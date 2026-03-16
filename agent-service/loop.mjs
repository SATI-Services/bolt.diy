// Agent loop — the core feedback cycle:
//   1. Build messages from DB
//   2. Call LLM (streaming)
//   3. Parse actions from response
//   4. Execute actions via sidecar
//   5. Collect results, save as feedback message
//   6. Repeat until done or safety limit hit

import { getSession, updateSession, getMessages, saveMessage, saveAction, updateAction, upsertFile } from './db.mjs';
import { streamLLM } from './llm.mjs';
import { parseActions, formatExecutionResults } from './parser.mjs';
import { getAgentSystemPrompt } from './prompts.mjs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// SSE emitter registry (per session)
// ---------------------------------------------------------------------------

const sseClients = new Map(); // sessionId → Set<(event) => void>

export function addSSEClient(sessionId, emitFn) {
  if (!sseClients.has(sessionId)) {
    sseClients.set(sessionId, new Set());
  }

  sseClients.get(sessionId).add(emitFn);
}

export function removeSSEClient(sessionId, emitFn) {
  const clients = sseClients.get(sessionId);

  if (clients) {
    clients.delete(emitFn);

    if (clients.size === 0) {
      sseClients.delete(sessionId);
    }
  }
}

function emitSSE(sessionId, event) {
  const clients = sseClients.get(sessionId);

  if (clients) {
    for (const emit of clients) {
      try {
        emit(event);
      } catch {
        // Client disconnected, will be cleaned up
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Active loops tracking (for abort)
// ---------------------------------------------------------------------------

const activeLoops = new Map(); // sessionId → AbortController

export function isLoopRunning(sessionId) {
  return activeLoops.has(sessionId);
}

export function abortLoop(sessionId) {
  const controller = activeLoops.get(sessionId);

  if (controller) {
    controller.abort();
    activeLoops.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Sidecar communication
// ---------------------------------------------------------------------------

async function sidecarFetch(sidecarUrl, token, endpoint, body) {
  const url = `${sidecarUrl}${endpoint}`;
  const opts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Sidecar ${endpoint} failed (${resp.status}): ${text}`);
  }

  return resp.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

async function executeAction(session, action) {
  const { sidecar_url: sidecarUrl, sidecar_token: sidecarToken } = session;

  if (!sidecarUrl || !sidecarToken) {
    return {
      type: action.type,
      status: 'failed',
      content: action.content,
      filePath: action.filePath,
      output: 'No sidecar configured for this session',
      exitCode: -1,
    };
  }

  switch (action.type) {
    case 'file': {
      try {
        await sidecarFetch(sidecarUrl, sidecarToken, '/write', {
          path: action.filePath,
          content: action.content,
        });

        return {
          type: 'file',
          status: 'complete',
          filePath: action.filePath,
        };
      } catch (err) {
        return {
          type: 'file',
          status: 'failed',
          filePath: action.filePath,
          output: err.message,
        };
      }
    }

    case 'shell': {
      try {
        const result = await sidecarFetch(sidecarUrl, sidecarToken, '/exec', {
          command: action.content,
        });

        return {
          type: 'shell',
          status: result?.exitCode === 0 ? 'complete' : 'failed',
          exitCode: result?.exitCode ?? -1,
          output: truncate(result?.output || '', 3000),
          command: action.content,
        };
      } catch (err) {
        return {
          type: 'shell',
          status: 'failed',
          exitCode: -1,
          output: err.message,
          command: action.content,
        };
      }
    }

    case 'start': {
      try {
        // Fire and don't wait — dev servers are long-running
        sidecarFetch(sidecarUrl, sidecarToken, '/exec', {
          command: action.content,
        }).catch(() => {}); // intentionally not awaited

        // Wait briefly for initial output
        await sleep(3000);

        // Check if server started
        let health = null;

        try {
          health = await sidecarFetch(sidecarUrl, sidecarToken, '/health', {});
        } catch {
          // health check failed — server may still be starting
        }

        return {
          type: 'start',
          status: 'running',
          command: action.content,
          output: 'Dev server started',
          serverReady: health?.serverReady || false,
          port: health?.detectedPort,
        };
      } catch (err) {
        return {
          type: 'start',
          status: 'failed',
          command: action.content,
          output: err.message,
        };
      }
    }

    case 'build': {
      try {
        const result = await sidecarFetch(sidecarUrl, sidecarToken, '/exec', {
          command: action.content,
        });

        return {
          type: 'build',
          status: result?.exitCode === 0 ? 'complete' : 'failed',
          exitCode: result?.exitCode ?? -1,
          output: truncate(result?.output || '', 3000),
          command: action.content,
        };
      } catch (err) {
        return {
          type: 'build',
          status: 'failed',
          exitCode: -1,
          output: err.message,
          command: action.content,
        };
      }
    }

    default:
      return {
        type: action.type,
        status: 'complete',
        output: `Unknown action type: ${action.type}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

function detectStall(lastResults, prevResults) {
  if (!prevResults || prevResults.length === 0) return false;
  if (lastResults.length !== prevResults.length) return false;

  // Compare serialized results (ignoring timestamps)
  const normalize = (results) =>
    results.map((r) => ({
      type: r.type,
      status: r.status,
      exitCode: r.exitCode,
      output: r.output,
    }));

  return JSON.stringify(normalize(lastResults)) === JSON.stringify(normalize(prevResults));
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(sessionId) {
  if (activeLoops.has(sessionId)) {
    log('warn', 'Agent loop already running', { sessionId });
    return;
  }

  const controller = new AbortController();
  activeLoops.set(sessionId, controller);

  let session = await getSession(sessionId);

  if (!session) {
    log('error', 'Session not found', { sessionId });
    activeLoops.delete(sessionId);
    return;
  }

  await updateSession(sessionId, { status: 'running' });
  emitSSE(sessionId, { type: 'status', status: 'running' });

  let consecutiveErrors = 0;
  let prevResults = null;

  try {
    while (session.iteration < session.max_iterations) {
      // Check abort
      if (controller.signal.aborted) {
        log('info', 'Agent loop aborted', { sessionId });
        await updateSession(sessionId, { status: 'paused' });
        emitSSE(sessionId, { type: 'status', status: 'paused' });
        emitSSE(sessionId, { type: 'done', reason: 'aborted' });
        return;
      }

      const iteration = session.iteration + 1;
      log('info', 'Agent loop iteration', { sessionId, iteration, max: session.max_iterations });
      emitSSE(sessionId, { type: 'iteration', n: iteration, max: session.max_iterations });

      // 1. Load messages from DB
      const dbMessages = await getMessages(sessionId);
      const llmMessages = dbMessages.map((m) => ({
        role: m.role === 'execution_result' ? 'user' : m.role,
        content: m.content,
      }));

      // 2. Get system prompt
      const systemPrompt = getAgentSystemPrompt({
        provider: session.provider,
        model: session.model,
      });

      // 3. Call LLM (streaming)
      let responseText = '';

      try {
        const stream = await streamLLM({
          provider: session.provider,
          model: session.model,
          system: systemPrompt,
          messages: llmMessages,
          abortSignal: controller.signal,
        });

        // Collect streamed tokens
        for await (const chunk of stream.textStream) {
          responseText += chunk;
          emitSSE(sessionId, { type: 'text-delta', delta: chunk });
        }

        // Get usage info
        const usage = await stream.usage;

        if (usage) {
          const totalTokens = (session.total_tokens || 0) + (usage.totalTokens || 0);
          await updateSession(sessionId, { totalTokens });
          session = await getSession(sessionId);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          await updateSession(sessionId, { status: 'paused' });
          emitSSE(sessionId, { type: 'status', status: 'paused' });
          emitSSE(sessionId, { type: 'done', reason: 'aborted' });
          return;
        }

        log('error', 'LLM call failed', { sessionId, error: err.message });
        emitSSE(sessionId, { type: 'error', error: err.message });
        await updateSession(sessionId, { status: 'error' });
        emitSSE(sessionId, { type: 'done', reason: 'llm_error' });
        return;
      }

      // 4. Save assistant message
      const assistantMsg = await saveMessage(sessionId, {
        role: 'assistant',
        content: responseText,
      });

      emitSSE(sessionId, { type: 'message-complete', messageId: assistantMsg.id });

      // 5. Parse actions
      const actions = parseActions(responseText);

      // 6. If no actions, LLM is done
      if (actions.length === 0) {
        log('info', 'Agent loop complete — no actions in response', { sessionId, iteration });
        await updateSession(sessionId, { status: 'done', iteration });
        emitSSE(sessionId, { type: 'status', status: 'done' });
        emitSSE(sessionId, { type: 'done', reason: 'complete' });
        return;
      }

      // 7. Execute actions one at a time
      const results = [];

      for (const action of actions) {
        // Save action to DB
        const savedAction = await saveAction(sessionId, assistantMsg.id, action);

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: savedAction.id, ...action },
        });

        await updateAction(savedAction.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
        });

        // Execute
        const result = await executeAction(session, action);

        // Update action in DB
        await updateAction(savedAction.id, {
          status: result.status,
          exitCode: result.exitCode ?? null,
          output: result.output ?? null,
          completedAt: new Date().toISOString(),
        });

        // Track file writes
        if (action.type === 'file' && result.status === 'complete') {
          await upsertFile(sessionId, action.filePath, action.content);
        }

        emitSSE(sessionId, {
          type: 'action-complete',
          result: { id: savedAction.id, ...result },
        });

        results.push(result);
      }

      // 8. Format results as feedback message
      const feedbackContent = formatExecutionResults(results);
      await saveMessage(sessionId, {
        role: 'user', // LLM sees execution results as user messages
        content: feedbackContent,
        annotations: { type: 'execution_result' },
      });

      emitSSE(sessionId, { type: 'execution-feedback', results });

      // 9. Update iteration
      await updateSession(sessionId, { iteration });
      session = await getSession(sessionId);

      // 10. Safety checks
      // Consecutive error check
      const failedCount = results.filter((r) => r.status === 'failed').length;

      if (failedCount === results.length && results.length > 0) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }

      if (consecutiveErrors >= 3) {
        log('warn', 'Too many consecutive errors', { sessionId, consecutiveErrors });
        await updateSession(sessionId, { status: 'error' });
        emitSSE(sessionId, { type: 'status', status: 'error' });
        emitSSE(sessionId, { type: 'done', reason: 'consecutive_errors' });
        return;
      }

      // Stall detection
      if (detectStall(results, prevResults)) {
        log('warn', 'Stall detected — identical results', { sessionId });
        await updateSession(sessionId, { status: 'error' });
        emitSSE(sessionId, { type: 'status', status: 'error' });
        emitSSE(sessionId, { type: 'done', reason: 'stall_detected' });
        return;
      }

      prevResults = results;

      // Token budget check
      if (session.total_tokens > 500000) {
        log('warn', 'Token budget exceeded', { sessionId, tokens: session.total_tokens });
        await updateSession(sessionId, { status: 'done' });
        emitSSE(sessionId, { type: 'status', status: 'done' });
        emitSSE(sessionId, { type: 'done', reason: 'token_budget' });
        return;
      }
    }

    // Max iterations reached
    log('info', 'Max iterations reached', { sessionId, iterations: session.max_iterations });
    await updateSession(sessionId, { status: 'done' });
    emitSSE(sessionId, { type: 'status', status: 'done' });
    emitSSE(sessionId, { type: 'done', reason: 'max_iterations' });
  } catch (err) {
    log('error', 'Agent loop error', { sessionId, error: err.message, stack: err.stack });
    await updateSession(sessionId, { status: 'error' }).catch(() => {});
    emitSSE(sessionId, { type: 'error', error: err.message });
    emitSSE(sessionId, { type: 'done', reason: 'error' });
  } finally {
    activeLoops.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n... [truncated]';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
