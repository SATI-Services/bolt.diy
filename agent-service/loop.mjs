/*
 * Agent loop v2 — native tool_use via Vercel AI SDK.
 *
 * Instead of parsing XML <boltArtifact> tags, we define tools (writeFile,
 * runShell, readFile, listFiles, startDevServer) and let the AI SDK handle
 * the tool-call → execute → feed-result-back → continue loop via maxSteps.
 *
 * This matches how Codex, Opencode, and Claude Code work:
 *   - LLM returns structured tool calls (not XML)
 *   - finishReason === 'tool-calls' → continue
 *   - finishReason === 'stop' → done
 *   - Errors feed back as tool results, never thrown to the user
 */

import { streamText as aiStreamText, tool } from 'ai';
import { z } from 'zod';
import {
  getSession,
  updateSession,
  getMessages,
  saveMessage,
  saveAction,
  updateAction,
  upsertFile,
} from './db.mjs';
import { getModelInstance, getMaxTokens, isReasoningModel } from './llm.mjs';
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

const sseClients = new Map();

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
        /* client disconnected */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Active loops tracking (for abort)
// ---------------------------------------------------------------------------

const activeLoops = new Map();

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

  if (body !== undefined) {
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
// Tool definitions factory — creates tools bound to a specific session
// ---------------------------------------------------------------------------

function createTools(session, sessionId) {
  const { sidecar_url: sidecarUrl, sidecar_token: sidecarToken } = session;

  if (!sidecarUrl || !sidecarToken) {
    throw new Error('No sidecar configured for this session');
  }

  return {
    writeFile: tool({
      description:
        'Write a file to the project. Provide the COMPLETE file contents — no diffs or partial updates. ' +
        'Path is relative to /app (the working directory).',
      parameters: z.object({
        path: z.string().describe('File path relative to /app, e.g. "src/App.tsx" or "package.json"'),
        content: z.string().describe('Complete file contents'),
      }),
      execute: async ({ path, content }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'file', filePath: path },
        });

        try {
          await sidecarFetch(sidecarUrl, sidecarToken, '/write', { path, content });
          await upsertFile(sessionId, path, content);

          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'complete', filePath: path, content },
          });

          return `File written successfully: ${path}`;
        } catch (err) {
          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'failed', filePath: path, output: err.message },
          });

          return `Error writing file ${path}: ${err.message}`;
        }
      },
    }),

    readFile: tool({
      description: 'Read the current contents of a file. Use this BEFORE modifying existing files.',
      parameters: z.object({
        path: z.string().describe('File path relative to /app'),
      }),
      execute: async ({ path }) => {
        try {
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/read', { path });
          const content = result?.content ?? result?.data ?? '';

          if (typeof content === 'string') {
            return truncate(content, 50000);
          }

          return `File ${path} read successfully (${JSON.stringify(content).length} bytes)`;
        } catch (err) {
          return `Error reading ${path}: ${err.message}`;
        }
      },
    }),

    listFiles: tool({
      description: 'List files and directories at a given path.',
      parameters: z.object({
        path: z.string().describe('Directory path relative to /app, e.g. "." or "src"').default('.'),
      }),
      execute: async ({ path }) => {
        try {
          // Try /list endpoint; fall back to ls via /exec
          try {
            const result = await sidecarFetch(sidecarUrl, sidecarToken, '/list', { path });

            if (result?.entries) {
              return result.entries.map((e) => `${e.type === 'dir' ? 'd' : 'f'} ${e.name}`).join('\n');
            }
          } catch {
            /* endpoint may not exist */
          }

          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/exec', {
            command: `ls -la ${path}`,
          });

          return truncate(result?.output || 'Empty directory', 10000);
        } catch (err) {
          return `Error listing ${path}: ${err.message}`;
        }
      },
    }),

    runShell: tool({
      description:
        'Execute a shell command and return stdout/stderr + exit code. ' +
        'One command at a time — no && chaining unless truly atomic. ' +
        'Commands run in /app. Use this for: installing packages, running builds, running tests, etc.',
      parameters: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
      execute: async ({ command }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'shell', content: command },
        });

        try {
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/exec', { command });
          const exitCode = result?.exitCode ?? -1;
          const output = truncate(result?.output || '', 3000);
          const status = exitCode === 0 ? 'complete' : 'failed';

          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'shell', status, exitCode, output, command },
          });

          // Always return output to the model — errors are information, not exceptions
          return `Exit code: ${exitCode}\n${output}`;
        } catch (err) {
          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'shell', status: 'failed', exitCode: -1, output: err.message, command },
          });

          return `Command failed: ${err.message}`;
        }
      },
    }),

    startDevServer: tool({
      description:
        'Start a long-running dev server (npm run dev, etc). Fire-and-forget — does not wait for exit. ' +
        'Use ONCE per project setup. Dev servers must bind to 0.0.0.0.',
      parameters: z.object({
        command: z.string().describe('The dev server command, e.g. "npm run dev"'),
      }),
      execute: async ({ command }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'start', content: command },
        });

        // Fire and don't wait
        sidecarFetch(sidecarUrl, sidecarToken, '/exec', { command }).catch(() => {});

        // Give server a moment to start
        await sleep(3000);

        emitSSE(sessionId, {
          type: 'action-complete',
          result: { id: actionId, type: 'start', status: 'running', command, output: 'Dev server started' },
        });

        return 'Dev server started. It is now running in the background.';
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Main agent loop — uses AI SDK streamText with maxSteps
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

  try {
    // Build tools bound to this session's sidecar
    const tools = createTools(session, sessionId);

    // Load conversation history from DB
    const dbMessages = await getMessages(sessionId);
    const messages = dbMessages.map((m) => ({
      role: m.role === 'execution_result' ? 'user' : m.role,
      content: m.content,
    }));

    // Resolve model
    const modelInstance = await getModelInstance(session.provider, session.model);
    const maxTokens = getMaxTokens(session.model);
    const reasoning = isReasoningModel(session.model);
    const tokenParams = reasoning ? { maxCompletionTokens: maxTokens } : { maxTokens };

    // System prompt (tool-focused, no XML instructions)
    const systemPrompt = getAgentSystemPrompt();

    log('info', 'Starting agent loop with native tools', {
      sessionId,
      provider: session.provider,
      model: session.model,
      maxSteps: session.max_iterations,
    });

    // Single streamText call with maxSteps — the AI SDK handles the
    // tool-call → execute → feed-result → continue loop automatically
    const result = aiStreamText({
      model: modelInstance,
      system: systemPrompt,
      messages,
      tools,
      maxSteps: session.max_iterations,
      ...tokenParams,
      ...(reasoning ? { temperature: 1 } : {}),
      abortSignal: controller.signal,
      onStepFinish: async ({ stepType, text, toolCalls, toolResults, finishReason, usage }) => {
        const step = stepCounter++;

        log('info', 'Step finished', {
          sessionId,
          step,
          stepType,
          finishReason,
          toolCallCount: toolCalls?.length || 0,
          tokens: usage?.totalTokens,
        });

        emitSSE(sessionId, {
          type: 'iteration',
          n: step,
          max: session.max_iterations,
        });

        // Persist assistant message text if present
        if (text) {
          await saveMessage(sessionId, { role: 'assistant', content: text });
        }

        // Persist tool calls and results
        if (toolCalls?.length) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const tr = toolResults?.[i];

            await saveAction(sessionId, null, {
              type: tc.toolName === 'writeFile' ? 'file' : tc.toolName === 'startDevServer' ? 'start' : 'shell',
              content: tc.toolName === 'runShell' || tc.toolName === 'startDevServer'
                ? tc.args.command
                : JSON.stringify(tc.args),
              filePath: tc.args?.path || null,
            });
          }
        }

        // Update token count
        if (usage?.totalTokens) {
          const totalTokens = (session.total_tokens || 0) + usage.totalTokens;
          await updateSession(sessionId, { totalTokens, iteration: step });
          session = await getSession(sessionId);
        }

        // Token budget safety check
        if (session.total_tokens > 500000) {
          log('warn', 'Token budget exceeded', { sessionId, tokens: session.total_tokens });
          controller.abort();
        }
      },
    });

    let stepCounter = 1;

    // Stream text deltas to the client
    for await (const chunk of result.fullStream) {
      if (controller.signal.aborted) break;

      switch (chunk.type) {
        case 'text-delta':
          emitSSE(sessionId, { type: 'text-delta', delta: chunk.textDelta });
          break;

        case 'tool-call':
          log('debug', 'Tool call', {
            sessionId,
            tool: chunk.toolName,
            args: chunk.toolName === 'writeFile'
              ? { path: chunk.args.path, contentLength: chunk.args.content?.length }
              : chunk.args,
          });
          break;

        case 'tool-result':
          log('debug', 'Tool result', {
            sessionId,
            tool: chunk.toolName,
            resultLength: typeof chunk.result === 'string' ? chunk.result.length : 0,
          });
          break;

        case 'step-finish':
          // Handled by onStepFinish callback
          break;

        case 'error':
          log('error', 'Stream error', { sessionId, error: chunk.error });
          emitSSE(sessionId, { type: 'error', error: String(chunk.error) });
          break;

        case 'finish':
          log('info', 'Agent loop complete', {
            sessionId,
            finishReason: chunk.finishReason,
            steps: stepCounter,
          });
          break;
      }
    }

    // Get final usage
    const finalUsage = await result.usage;

    if (finalUsage?.totalTokens) {
      await updateSession(sessionId, {
        totalTokens: (session.total_tokens || 0) + finalUsage.totalTokens,
      });
    }

    // Save final text response
    const finalText = await result.text;

    if (finalText) {
      await saveMessage(sessionId, { role: 'assistant', content: finalText });
      emitSSE(sessionId, { type: 'message-complete', messageId: 'final' });
    }

    await updateSession(sessionId, { status: 'done', iteration: stepCounter });
    emitSSE(sessionId, { type: 'status', status: 'done' });
    emitSSE(sessionId, { type: 'done', reason: 'complete' });
  } catch (err) {
    if (controller.signal.aborted) {
      await updateSession(sessionId, { status: 'paused' }).catch(() => {});
      emitSSE(sessionId, { type: 'status', status: 'paused' });
      emitSSE(sessionId, { type: 'done', reason: 'aborted' });
      return;
    }

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
