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
  deleteFileRecord,
} from './db.mjs';
import { getModelInstance, getMaxTokens, isReasoningModel, getContextWindowSize } from './llm.mjs';
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

async function sidecarGet(sidecarUrl, endpoint) {
  const resp = await fetch(`${sidecarUrl}${endpoint}`);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Sidecar GET ${endpoint} failed (${resp.status}): ${text}`);
  }

  return resp.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Glob-to-regex helper
// ---------------------------------------------------------------------------

function globToRegex(pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`);
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
        'Path is relative to /app (the working directory). For small changes to existing files, prefer editFile instead.',
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

    editFile: tool({
      description:
        'Make a targeted edit to an existing file by replacing a specific string. ' +
        'Much more efficient than writeFile for small changes. ' +
        'old_string must match EXACTLY one location in the file. Use readFile first to get exact content.',
      parameters: z.object({
        path: z.string().describe('File path relative to /app'),
        old_string: z.string().describe('Exact text to find in the file (must be unique)'),
        new_string: z.string().describe('Replacement text (empty string to delete the match)'),
      }),
      execute: async ({ path, old_string, new_string }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'file', filePath: path },
        });

        try {
          // Read current contents
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/read', { path });
          const content = result?.content ?? result?.data ?? '';

          if (typeof content !== 'string') {
            return `Error editing ${path}: could not read file contents`;
          }

          // Validate old_string exists
          const idx = content.indexOf(old_string);

          if (idx === -1) {
            emitSSE(sessionId, {
              type: 'action-complete',
              result: { id: actionId, type: 'file', status: 'failed', filePath: path, output: 'old_string not found' },
            });
            return `Error editing ${path}: old_string not found in file. Use readFile to see current contents.`;
          }

          // Validate uniqueness
          const secondIdx = content.indexOf(old_string, idx + 1);

          if (secondIdx !== -1) {
            emitSSE(sessionId, {
              type: 'action-complete',
              result: { id: actionId, type: 'file', status: 'failed', filePath: path, output: 'old_string not unique' },
            });
            return `Error editing ${path}: old_string appears multiple times. Include more surrounding context to make it unique.`;
          }

          // Apply replacement
          const newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
          await sidecarFetch(sidecarUrl, sidecarToken, '/write', { path, content: newContent });
          await upsertFile(sessionId, path, newContent);

          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'complete', filePath: path, content: newContent },
          });

          return `File edited successfully: ${path}`;
        } catch (err) {
          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'failed', filePath: path, output: err.message },
          });

          return `Error editing ${path}: ${err.message}`;
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

    searchFiles: tool({
      description:
        'Search for a pattern across project files using grep. Returns matching lines with file paths and line numbers. ' +
        'Use this to find code before modifying it — do not guess file paths.',
      parameters: z.object({
        pattern: z.string().describe('Regex pattern to search for, e.g. "useState" or "import.*Router"'),
        path: z.string().describe('Directory to search in, relative to /app').default('.'),
      }),
      execute: async ({ pattern, path }) => {
        try {
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/search', { pattern, path });
          const matches = result?.matches || result?.results || [];

          if (!matches.length) {
            return `No matches found for "${pattern}"${path !== '.' ? ` in ${path}` : ''}`;
          }

          const lines = matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
          const output = lines.join('\n');

          return truncate(output, 15000);
        } catch (err) {
          return `Error searching for "${pattern}": ${err.message}`;
        }
      },
    }),

    searchGlob: tool({
      description:
        'Find files by name pattern (glob). Use to discover project structure, e.g. "*.tsx", "**/*.test.ts", "tsconfig*".',
      parameters: z.object({
        pattern: z.string().describe('Glob pattern, e.g. "*.tsx", "**/*.test.ts", "src/**/*.css"'),
        path: z.string().describe('Directory to search in, relative to /app').default('.'),
      }),
      execute: async ({ pattern, path }) => {
        try {
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/list-files', {
            path,
            maxDepth: 15,
          });

          const files = result?.files || {};
          const filePaths = Object.keys(files);
          const regex = globToRegex(pattern);
          const matches = filePaths.filter((fp) => {
            // Match against full path and also just the filename
            const name = fp.split('/').pop();
            return regex.test(fp) || regex.test(name);
          });

          if (!matches.length) {
            return `No files matching "${pattern}"${path !== '.' ? ` in ${path}` : ''}`;
          }

          const output = matches.slice(0, 100).join('\n');
          const suffix = matches.length > 100 ? `\n... and ${matches.length - 100} more` : '';

          return output + suffix;
        } catch (err) {
          return `Error searching for files matching "${pattern}": ${err.message}`;
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
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/list-files', {
            path,
            maxDepth: 3,
          });

          if (result?.files) {
            const entries = Object.entries(result.files).map(
              ([filePath, info]) => `${info.type === 'directory' ? 'd' : 'f'} ${filePath}`,
            );

            if (entries.length) {
              return truncate(entries.join('\n'), 10000);
            }
          }

          return 'Empty directory';
        } catch (err) {
          return `Error listing ${path}: ${err.message}`;
        }
      },
    }),

    deleteFile: tool({
      description: 'Delete a file from the project.',
      parameters: z.object({
        path: z.string().describe('File path relative to /app'),
      }),
      execute: async ({ path }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'file', filePath: path },
        });

        try {
          await sidecarFetch(sidecarUrl, sidecarToken, '/delete', { path });
          await deleteFileRecord(sessionId, path);

          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'complete', filePath: path },
          });

          return `File deleted: ${path}`;
        } catch (err) {
          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'failed', filePath: path, output: err.message },
          });

          return `Error deleting ${path}: ${err.message}`;
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
        'Use ONCE per project setup. Dev servers must bind to 0.0.0.0. ' +
        'IMPORTANT: Do NOT use port 3000 — it is reserved by the system proxy. ' +
        'Use the framework default port (e.g. 8000 for Laravel/Django, 5173 for Vite, 4321 for Astro, 8080 for Go). ' +
        'The system will auto-detect the port and proxy it. ' +
        'After calling this, you MUST use getServerStatus to confirm the server is running.',
      parameters: z.object({
        command: z.string().describe('The dev server command, e.g. "npm run dev" or "php artisan serve --host=0.0.0.0"'),
      }),
      execute: async ({ command }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'start', content: command },
        });

        try {
          // Use /exec-detached so the HTTP request returns immediately
          // instead of hanging until the dev server exits (which is never)
          const result = await sidecarFetch(sidecarUrl, sidecarToken, '/exec-detached', { command });
          log('info', 'Dev server started (detached)', { sessionId, pid: result?.pid });
        } catch (err) {
          log('warn', 'exec-detached failed, falling back to fire-and-forget /exec', { sessionId, error: err.message });
          sidecarFetch(sidecarUrl, sidecarToken, '/exec', { command }).catch(() => {});
        }

        // Give server a moment to start
        await sleep(3000);

        emitSSE(sessionId, {
          type: 'action-complete',
          result: { id: actionId, type: 'start', status: 'running', command, output: 'Dev server started' },
        });

        return 'Dev server started. It is now running in the background. Call getServerStatus to verify it is ready.';
      },
    }),

    getServerStatus: tool({
      description:
        'Check whether the dev server is running and on which port. ' +
        'Call this after startDevServer to confirm the server is ready.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await sidecarGet(sidecarUrl, '/health');

          if (result?.serverReady) {
            const port = result.detectedPort || 'unknown';
            return `Server is running on port ${port}`;
          }

          return 'Server is not ready yet. It may still be starting up — wait a moment and check again.';
        } catch (err) {
          return `Could not reach sidecar health endpoint: ${err.message}`;
        }
      },
    }),

    batchWrite: tool({
      description:
        'Write multiple files in a single operation. Use for scaffolding — when you need to create several files at once.',
      parameters: z.object({
        files: z.array(
          z.object({
            path: z.string().describe('File path relative to /app'),
            content: z.string().describe('Complete file contents'),
          }),
        ).describe('Array of files to write'),
      }),
      execute: async ({ files }) => {
        const actionId = crypto.randomUUID();

        emitSSE(sessionId, {
          type: 'action-start',
          action: { id: actionId, type: 'file', filePath: `${files.length} files` },
        });

        try {
          const operations = files.map((f) => ({
            type: 'write_file',
            path: f.path,
            content: f.content,
          }));
          await sidecarFetch(sidecarUrl, sidecarToken, '/batch', { operations });

          // Update DB for each file
          for (const f of files) {
            await upsertFile(sessionId, f.path, f.content);
          }

          // Emit per-file action-complete so the workbench receives each file's content
          for (const f of files) {
            emitSSE(sessionId, {
              type: 'action-complete',
              result: { id: crypto.randomUUID(), type: 'file', status: 'complete', filePath: f.path, content: f.content },
            });
          }

          const paths = files.map((f) => f.path).join(', ');

          return `Successfully wrote ${files.length} files: ${paths}`;
        } catch (err) {
          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'failed', output: err.message },
          });

          return `Error in batch write: ${err.message}`;
        }
      },
    }),

    refreshPreview: tool({
      description:
        'Reload the preview iframe in the user\'s browser. ' +
        'Call this after making changes that should be visible in the preview (file edits, config changes, build completion). ' +
        'File edits auto-refresh, but use this after shell commands that affect the output (e.g. npm run build).',
      parameters: z.object({}),
      execute: async () => {
        emitSSE(sessionId, { type: 'refresh-preview' });

        return 'Preview refresh triggered.';
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Conversation compaction — summarize older messages to free context space
// ---------------------------------------------------------------------------

async function compactConversation(sessionId) {
  const dbMessages = await getMessages(sessionId);

  if (dbMessages.length < 6) {
    return; // Not enough messages to compact
  }

  // Keep the first user message and last 4 messages intact
  const toSummarize = dbMessages.slice(1, -4);
  const kept = [dbMessages[0], ...dbMessages.slice(-4)];

  if (toSummarize.length < 4) {
    return; // Not worth compacting
  }

  log('info', 'Compacting conversation', { sessionId, summarizing: toSummarize.length, keeping: kept.length });
  emitSSE(sessionId, { type: 'compacting' });

  // Build a summary of the compacted messages
  const summaryParts = [];

  for (const m of toSummarize) {
    if (m.role === 'assistant' && m.content?.length > 20) {
      summaryParts.push(`Assistant: ${m.content.slice(0, 200)}`);
    } else if (m.role === 'user') {
      summaryParts.push(`User: ${m.content.slice(0, 100)}`);
    }
  }

  const summaryText =
    '[Conversation compacted. Summary of earlier work:\n' +
    summaryParts.join('\n') +
    '\n...end of summary. Continue from the most recent messages below.]';

  // Delete old messages and insert summary
  const { pool } = await import('./db.mjs');
  const idsToDelete = toSummarize.map((m) => m.id);

  if (idsToDelete.length > 0) {
    await pool.query(
      `DELETE FROM messages WHERE id = ANY($1::uuid[])`,
      [idsToDelete],
    );
  }

  // Insert the summary as a system message right after the first user message
  await saveMessage(sessionId, { role: 'assistant', content: summaryText });

  log('info', 'Compaction complete', {
    sessionId,
    deleted: idsToDelete.length,
    summaryLength: summaryText.length,
  });
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

  // Track whether we need to restart after compaction
  let needsCompactionRestart = false;

  await updateSession(sessionId, { status: 'running' });
  emitSSE(sessionId, { type: 'status', status: 'running' });

  try {
    // Build tools bound to this session's sidecar
    const tools = createTools(session, sessionId);

    // Load conversation history from DB and reconstruct AI SDK message format
    const dbMessages = await getMessages(sessionId);
    const messages = reconstructMessages(dbMessages);

    // Resolve model
    const modelInstance = await getModelInstance(session.provider, session.model);
    const maxTokens = getMaxTokens(session.model);
    const reasoning = isReasoningModel(session.model);
    const tokenParams = reasoning ? { maxCompletionTokens: maxTokens } : { maxTokens };
    const contextWindow = await getContextWindowSize(session.model);
    const compactionThreshold = Math.floor(contextWindow * 0.85);

    // System prompt (tool-focused, no XML instructions)
    const systemPrompt = getAgentSystemPrompt();

    log('info', 'Starting agent loop with native tools', {
      sessionId,
      provider: session.provider,
      model: session.model,
      maxSteps: session.max_iterations,
      contextWindow,
      compactionThreshold,
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
          promptTokens: usage?.promptTokens,
        });

        emitSSE(sessionId, {
          type: 'iteration',
          n: step,
          max: session.max_iterations,
        });

        /*
         * Persist the full step to the DB so multi-turn conversations retain
         * tool call context. We save:
         * 1. Assistant text (if any) as a plain message
         * 2. Assistant tool calls as a message with role 'assistant' and
         *    annotations.toolCalls containing the structured calls
         * 3. Tool results as a message with role 'tool' and
         *    annotations.toolResults containing the structured results
         *
         * On reload, reconstructMessages() rebuilds the AI SDK format.
         */
        if (text) {
          await saveMessage(sessionId, { role: 'assistant', content: text });
        }

        if (toolCalls?.length) {
          // Save the assistant's tool call message
          const serializedCalls = toolCalls.map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }));
          await saveMessage(sessionId, {
            role: 'assistant',
            content: text || '',
            annotations: { type: 'tool_calls', toolCalls: serializedCalls },
          });

          // Save each tool result as a separate 'tool' message
          if (toolResults?.length) {
            for (const tr of toolResults) {
              await saveMessage(sessionId, {
                role: 'tool',
                content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
                annotations: {
                  type: 'tool_result',
                  toolCallId: tr.toolCallId,
                  toolName: tr.toolName,
                },
              });
            }
          }

          // Also save to actions table for the UI
          for (const tc of toolCalls) {
            const fileTools = ['writeFile', 'editFile', 'readFile', 'deleteFile', 'batchWrite'];
            const actionType = fileTools.includes(tc.toolName) ? 'file'
              : tc.toolName === 'startDevServer' ? 'start'
              : 'shell';

            await saveAction(sessionId, null, {
              type: actionType,
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

        // Context window compaction check — abort and restart with compacted history
        if (usage?.promptTokens && usage.promptTokens > compactionThreshold) {
          log('info', 'Prompt tokens approaching context limit, triggering compaction', {
            sessionId,
            promptTokens: usage.promptTokens,
            threshold: compactionThreshold,
            contextWindow,
          });
          needsCompactionRestart = true;
          controller.abort();
          return;
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

        case 'tool-call': {
          const toolLabel = formatToolCallLabel(chunk.toolName, chunk.args);

          log('debug', 'Tool call', { sessionId, tool: chunk.toolName, label: toolLabel });

          // Emit a rich event so the client can render tool calls inline in the chat
          // Redact large content fields from SSE to avoid bloating the stream
          let sseArgs = chunk.args;

          if (chunk.toolName === 'writeFile') {
            sseArgs = { path: chunk.args.path, contentLength: chunk.args.content?.length };
          } else if (chunk.toolName === 'editFile') {
            sseArgs = { path: chunk.args.path, oldLength: chunk.args.old_string?.length, newLength: chunk.args.new_string?.length };
          } else if (chunk.toolName === 'batchWrite') {
            sseArgs = { fileCount: chunk.args.files?.length, paths: chunk.args.files?.map((f) => f.path) };
          }

          emitSSE(sessionId, {
            type: 'tool-call',
            toolName: chunk.toolName,
            args: sseArgs,
            label: toolLabel,
          });
          break;
        }

        case 'tool-result': {
          const resultPreview = typeof chunk.result === 'string'
            ? chunk.result.slice(0, 300)
            : JSON.stringify(chunk.result).slice(0, 300);

          log('debug', 'Tool result', { sessionId, tool: chunk.toolName, resultLength: resultPreview.length });

          emitSSE(sessionId, {
            type: 'tool-result',
            toolName: chunk.toolName,
            result: resultPreview,
            success: !resultPreview.startsWith('Error') && !resultPreview.startsWith('Command failed'),
          });
          break;
        }

        case 'step-finish':
          emitSSE(sessionId, {
            type: 'iteration',
            n: stepCounter,
            max: session.max_iterations,
          });
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
      // Check if this was a compaction-triggered abort
      if (needsCompactionRestart) {
        log('info', 'Restarting loop after compaction', { sessionId });

        try {
          await compactConversation(sessionId);
        } catch (compactErr) {
          log('error', 'Compaction failed', { sessionId, error: compactErr.message });
        }

        // Clean up and restart
        activeLoops.delete(sessionId);

        // Brief pause then restart the loop with compacted messages
        await sleep(500);
        runAgentLoop(sessionId).catch((restartErr) => {
          log('error', 'Restart after compaction failed', { sessionId, error: restartErr.message });
        });
        return;
      }

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
// Message reconstruction — convert DB rows into AI SDK message format
// ---------------------------------------------------------------------------

/**
 * Rebuild conversation messages from flat DB rows into the structured format
 * the Vercel AI SDK expects for multi-turn tool use conversations.
 *
 * DB rows come in three flavors:
 * - role='user'      content=text         → plain user message
 * - role='assistant'  annotations.type='tool_calls' → assistant with tool_use parts
 * - role='assistant'  (no annotations)    → plain assistant text
 * - role='tool'       annotations.type='tool_result' → tool result
 *
 * AI SDK expects:
 * - { role: 'user', content: 'text' }
 * - { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool-call', ... }] }
 * - { role: 'tool', content: [{ type: 'tool-result', ... }] }
 */
function reconstructMessages(dbMessages) {
  const messages = [];
  let i = 0;

  while (i < dbMessages.length) {
    const msg = dbMessages[i];
    const ann = typeof msg.annotations === 'string' ? JSON.parse(msg.annotations) : msg.annotations;

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
      i++;
    } else if (msg.role === 'assistant' && ann?.type === 'tool_calls') {
      // Reconstruct assistant message with tool-call parts
      const parts = [];

      if (msg.content) {
        parts.push({ type: 'text', text: msg.content });
      }

      for (const tc of ann.toolCalls) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }

      messages.push({ role: 'assistant', content: parts });

      // Collect following tool result messages
      const toolResults = [];
      let j = i + 1;

      while (j < dbMessages.length) {
        const next = dbMessages[j];
        const nextAnn = typeof next.annotations === 'string' ? JSON.parse(next.annotations) : next.annotations;

        if (next.role === 'tool' && nextAnn?.type === 'tool_result') {
          toolResults.push({
            type: 'tool-result',
            toolCallId: nextAnn.toolCallId,
            toolName: nextAnn.toolName,
            result: next.content,
          });
          j++;
        } else {
          break;
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'tool', content: toolResults });
      }

      i = j;
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
      i++;
    } else if (msg.role === 'tool') {
      // Orphaned tool result (shouldn't happen normally) — skip
      i++;
    } else {
      // execution_result or system — map to user for safety
      messages.push({ role: 'user', content: msg.content });
      i++;
    }
  }

  return messages;
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

function formatToolCallLabel(toolName, args) {
  switch (toolName) {
    case 'writeFile':
      return `Write ${args.path}`;
    case 'editFile':
      return `Edit ${args.path}`;
    case 'readFile':
      return `Read ${args.path}`;
    case 'searchFiles':
      return `Search \`${args.pattern}\`${args.path && args.path !== '.' ? ` in ${args.path}` : ''}`;
    case 'searchGlob':
      return `Find \`${args.pattern}\``;
    case 'listFiles':
      return `List ${args.path || '.'}`;
    case 'deleteFile':
      return `Delete ${args.path}`;
    case 'runShell':
      return `Run \`${args.command}\``;
    case 'startDevServer':
      return `Start server: \`${args.command}\``;
    case 'getServerStatus':
      return 'Check server status';
    case 'batchWrite':
      return `Write ${args.files?.length || 0} files`;
    case 'refreshPreview':
      return 'Refresh preview';
    default:
      return `${toolName}(${JSON.stringify(args).slice(0, 60)})`;
  }
}
