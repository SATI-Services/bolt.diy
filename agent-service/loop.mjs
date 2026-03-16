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
        'After calling this, use getServerStatus to confirm the server is running.',
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

          const paths = files.map((f) => f.path).join(', ');

          emitSSE(sessionId, {
            type: 'action-complete',
            result: { id: actionId, type: 'file', status: 'complete', filePath: paths },
          });

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
    default:
      return `${toolName}(${JSON.stringify(args).slice(0, 60)})`;
  }
}
