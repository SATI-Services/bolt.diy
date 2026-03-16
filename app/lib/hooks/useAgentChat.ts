import { useCallback, useEffect, useRef, useState } from 'react';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useAgentChat');

/*
 * ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------
 */

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'execution_result';
  content: string;
  annotations?: any;
  created_at?: string;
}

export interface AgentAction {
  id: string;
  type: 'file' | 'shell' | 'start' | 'build';
  content?: string;
  filePath?: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  exitCode?: number;
  output?: string;
}

export interface AgentSessionState {
  session: {
    id: string;
    status: 'idle' | 'running' | 'paused' | 'error' | 'done';
    iteration: number;
    maxIterations: number;
    totalTokens: number;
    provider?: string;
    model?: string;
    containerDomain?: string;
  } | null;
  messages: AgentMessage[];
  actions: AgentAction[];
}

export type SSEEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'message-complete'; messageId: string }
  | { type: 'tool-call'; toolName: string; args: any; label: string }
  | { type: 'tool-result'; toolName: string; result: string; success: boolean }
  | { type: 'action-start'; action: AgentAction }
  | { type: 'action-complete'; result: AgentAction & { exitCode?: number; output?: string } }
  | { type: 'execution-feedback'; results: any[] }
  | { type: 'compacting' }
  | { type: 'iteration'; n: number; max: number }
  | { type: 'status'; status: string }
  | { type: 'done'; reason: string }
  | { type: 'error'; error: string };

export interface UseAgentChatOptions {
  sessionId?: string;
  onActionStart?: (action: AgentAction) => void;
  onActionComplete?: (result: AgentAction) => void;
  onDone?: (reason: string) => void;
  onError?: (error: string) => void;
}

/*
 * ---------------------------------------------------------------------------
 * Hook
 * ---------------------------------------------------------------------------
 */

export function useAgentChat(options: UseAgentChatOptions = {}) {
  const { sessionId: initialSessionId, onActionStart, onActionComplete, onDone, onError } = options;

  const [sessionId, _setSessionId] = useState<string | null>(initialSessionId || null);
  const sessionIdRef = useRef<string | null>(initialSessionId || null);

  // Wrapper that updates both state (for re-renders) and ref (for sync access in callbacks)
  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    _setSessionId(id);
  }, []);

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [status, setStatus] = useState<string>('idle');
  const [iteration, setIteration] = useState<{ n: number; max: number }>({ n: 0, max: 200 });
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentAction, setCurrentAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const callbackRefs = useRef({ onActionStart, onActionComplete, onDone, onError });

  // Keep callback refs in sync
  useEffect(() => {
    callbackRefs.current = { onActionStart, onActionComplete, onDone, onError };
  }, [onActionStart, onActionComplete, onDone, onError]);

  /*
   * ---------------------------------------------------------------------------
   * SSE connection
   * ---------------------------------------------------------------------------
   */

  const connectSSE = useCallback((sid: string) => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/agent-stream/${sid}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent;

        switch (data.type) {
          case 'connected':
            logger.debug('SSE connected', { sessionId: data.sessionId });
            break;

          case 'text-delta':
            setIsStreaming(true);
            setStreamingContent((prev) => prev + data.delta);
            break;

          case 'message-complete':
            // Move streaming content into messages array
            setStreamingContent((prev) => {
              if (prev) {
                setMessages((msgs) => [
                  ...msgs,
                  {
                    id: data.messageId,
                    role: 'assistant',
                    content: prev,
                  },
                ]);
              }

              return '';
            });
            setIsStreaming(false);
            break;

          case 'tool-call':
            // Show tool calls inline in chat (like Claude Code / Codex)
            setCurrentAction((data as any).label || (data as any).toolName || null);

            /*
             * Flush any accumulated streaming text BEFORE adding the tool call
             * This preserves chronological ordering: text appears before its tool calls
             */
            setStreamingContent((prev) => {
              if (prev) {
                setMessages((msgs) => [
                  ...msgs,
                  {
                    id: `text-${Date.now()}`,
                    role: 'assistant',
                    content: prev,
                  },
                  {
                    id: `tool-${Date.now()}`,
                    role: 'execution_result',
                    content: (data as any).label || `${(data as any).toolName}(...)`,
                    annotations: { type: 'tool_call', toolName: (data as any).toolName, args: (data as any).args },
                  },
                ]);
              } else {
                setMessages((msgs) => [
                  ...msgs,
                  {
                    id: `tool-${Date.now()}`,
                    role: 'execution_result',
                    content: (data as any).label || `${(data as any).toolName}(...)`,
                    annotations: { type: 'tool_call', toolName: (data as any).toolName, args: (data as any).args },
                  },
                ]);
              }

              return '';
            });
            setIsStreaming(false);
            break;

          case 'tool-result':
            setCurrentAction(null);

            // Update the last tool-call message with the result
            setMessages((msgs) => {
              const updated = [...msgs];

              // Find the last tool_call message and append result
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].annotations?.type === 'tool_call') {
                  updated[i] = {
                    ...updated[i],
                    annotations: {
                      ...updated[i].annotations,
                      result: (data as any).result,
                      success: (data as any).success,
                      resolved: true,
                    },
                  };
                  break;
                }
              }

              return updated;
            });
            break;

          case 'action-start':
            setCurrentAction(data.action?.type === 'shell' ? data.action.content || null : null);
            setActions((prev) => [...prev, { ...data.action, status: 'running' }]);
            callbackRefs.current.onActionStart?.(data.action);
            break;

          case 'action-complete':
            setCurrentAction(null);
            setActions((prev) => prev.map((a) => (a.id === data.result.id ? { ...a, ...data.result } : a)));
            callbackRefs.current.onActionComplete?.(data.result);
            break;

          case 'compacting':
            setMessages((msgs) => [
              ...msgs,
              {
                id: `compact-${Date.now()}`,
                role: 'assistant',
                content: '_Compacting conversation..._',
              },
            ]);
            break;

          case 'execution-feedback':
            break;

          case 'iteration':
            setIteration({ n: data.n, max: data.max });
            break;

          case 'status':
            setStatus(data.status);
            break;

          case 'done':
            setIsStreaming(false);
            setStreamingContent('');
            setCurrentAction(null);
            callbackRefs.current.onDone?.(data.reason);
            break;

          case 'error':
            setError(data.error);
            setIsStreaming(false);
            callbackRefs.current.onError?.(data.error);
            break;
        }
      } catch (e) {
        logger.warn('Failed to parse SSE event', e);
      }
    };

    es.onerror = () => {
      logger.warn('SSE connection error — will auto-reconnect');

      // EventSource auto-reconnects by default
    };

    return es;
  }, []);

  /*
   * ---------------------------------------------------------------------------
   * Session management
   * ---------------------------------------------------------------------------
   */

  const createSession = useCallback(
    async (opts: { id?: string; provider?: string; model?: string; title?: string }) => {
      try {
        const resp = await fetch('/api/agent-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        });

        if (!resp.ok) {
          throw new Error('Failed to create session');
        }

        const session = (await resp.json()) as { id: string };
        setSessionId(session.id);
        setMessages([]);
        setActions([]);
        setStatus('idle');
        setError(null);

        // Connect SSE
        connectSSE(session.id);

        return session;
      } catch (err: any) {
        setError(err.message);
        throw err;
      }
    },
    [connectSSE],
  );

  const loadSession = useCallback(
    async (sid: string) => {
      try {
        const resp = await fetch(`/api/agent-session/${sid}`);

        if (!resp.ok) {
          throw new Error('Session not found');
        }

        const state: AgentSessionState = await resp.json();

        if (state.session) {
          setSessionId(state.session.id);
          setStatus(state.session.status);
          setIteration({ n: state.session.iteration, max: state.session.maxIterations });
        }

        setMessages(state.messages || []);
        setActions(state.actions || []);

        // Connect SSE if session is still running
        if (state.session?.status === 'running') {
          connectSSE(sid);
        }

        return state;
      } catch (err: any) {
        setError(err.message);
        throw err;
      }
    },
    [connectSSE],
  );

  /*
   * ---------------------------------------------------------------------------
   * Send message
   * ---------------------------------------------------------------------------
   */

  const sendMessage = useCallback(
    async (content: string, opts?: { provider?: string; model?: string }) => {
      const sid = sessionIdRef.current;

      if (!sid) {
        throw new Error('No active session');
      }

      // Add user message optimistically
      const userMsg: AgentMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
      };
      setMessages((prev) => [...prev, userMsg]);
      setError(null);
      setStreamingContent('');

      // Connect SSE if not connected
      if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
        connectSSE(sid);
      }

      try {
        const resp = await fetch(`/api/agent-session/${sid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'message',
            content,
            provider: opts?.provider,
            model: opts?.model,
          }),
        });

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          throw new Error((errBody as any).error || 'Failed to send message');
        }
      } catch (err: any) {
        setError(err.message);
        throw err;
      }
    },
    [connectSSE],
  );

  /*
   * ---------------------------------------------------------------------------
   * Stop / Abort
   * ---------------------------------------------------------------------------
   */

  const stop = useCallback(async () => {
    const sid = sessionIdRef.current;

    if (!sid) {
      return;
    }

    try {
      await fetch(`/api/agent-session/${sid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      setStatus('paused');
    } catch (err: any) {
      logger.error('Failed to stop agent', err);
    }
  }, []);

  /*
   * ---------------------------------------------------------------------------
   * Cleanup
   * ---------------------------------------------------------------------------
   */

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-load session on mount if sessionId is provided
  useEffect(() => {
    if (initialSessionId) {
      loadSession(initialSessionId).catch(() => {
        // Session doesn't exist yet — will be created when first message is sent
      });
    }
  }, [initialSessionId, loadSession]);

  /*
   * ---------------------------------------------------------------------------
   * Return
   * ---------------------------------------------------------------------------
   */

  return {
    // State
    sessionId,
    messages,
    actions,
    status,
    iteration,
    isStreaming,
    streamingContent,
    currentAction,
    error,

    // Actions
    createSession,
    loadSession,
    sendMessage,
    stop,
    setSessionId,
    setMessages,
    connectSSE,
  };
}
