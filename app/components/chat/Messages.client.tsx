import type { Message } from 'ai';
import { Fragment, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useLocation } from '@remix-run/react';
import { db, chatId } from '~/lib/persistence/useChatHistory';
import { forkChat } from '~/lib/persistence/db';
import { toast } from 'react-toastify';
import { forwardRef } from 'react';
import type { ForwardedRef } from 'react';
import type { ProviderInfo } from '~/types/model';

interface MessagesProps {
  id?: string;
  className?: string;
  isStreaming?: boolean;
  messages?: Message[];
  append?: (message: Message) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
}

export const Messages = forwardRef<HTMLDivElement, MessagesProps>(
  (props: MessagesProps, ref: ForwardedRef<HTMLDivElement> | undefined) => {
    const { id, isStreaming = false, messages = [] } = props;
    const location = useLocation();

    const handleRewind = (messageId: string) => {
      const searchParams = new URLSearchParams(location.search);
      searchParams.set('rewindTo', messageId);
      window.location.search = searchParams.toString();
    };

    const handleFork = async (messageId: string) => {
      try {
        if (!db || !chatId.get()) {
          toast.error('Chat persistence is not available');
          return;
        }

        const urlId = await forkChat(db, chatId.get()!, messageId);
        window.location.href = `/chat/${urlId}`;
      } catch (error) {
        toast.error('Failed to fork chat: ' + (error as Error).message);
      }
    };

    return (
      <div id={id} className={props.className} ref={ref}>
        {messages.length > 0
          ? messages.map((message, index) => {
              const { role, content, id: messageId, annotations, parts } = message;
              const isUserMessage = role === 'user';
              const isFirst = index === 0;
              const isHidden = annotations?.includes('hidden');
              const isExecutionResult = annotations?.includes('execution_result');

              if (isHidden) {
                return <Fragment key={index} />;
              }

              // Compact rendering for agent execution results
              if (isExecutionResult) {
                return <ExecutionResultMessage key={index} content={content} isFirst={isFirst} />;
              }

              return (
                <div
                  key={index}
                  className={classNames('flex gap-4 py-3 w-full rounded-lg', {
                    'mt-4': !isFirst,
                  })}
                >
                  <div className="grid grid-col-1 w-full">
                    {isUserMessage ? (
                      <UserMessage content={content} parts={parts} />
                    ) : (
                      <AssistantMessage
                        content={content}
                        annotations={message.annotations}
                        messageId={messageId}
                        onRewind={handleRewind}
                        onFork={handleFork}
                        append={props.append}
                        chatMode={props.chatMode}
                        setChatMode={props.setChatMode}
                        model={props.model}
                        provider={props.provider}
                        parts={parts}
                        addToolResult={props.addToolResult}
                      />
                    )}
                  </div>
                </div>
              );
            })
          : null}
        {isStreaming && (
          <div className="text-center w-full  text-bolt-elements-item-contentAccent i-svg-spinners:3-dots-fade text-4xl mt-4"></div>
        )}
      </div>
    );
  },
);

// Compact execution result message for agent mode
function ExecutionResultMessage({ content, isFirst }: { content: string; isFirst: boolean }) {
  const [expanded, setExpanded] = useState(false);

  let results: any[] = [];

  try {
    results = JSON.parse(content);
  } catch {
    // Not JSON — just show raw
    return (
      <div className={classNames('px-4 py-2 text-sm text-bolt-elements-textSecondary', { 'mt-4': !isFirst })}>
        {content}
      </div>
    );
  }

  const succeeded = results.filter((r: any) => r.status === 'complete' || r.status === 'running').length;
  const failed = results.filter((r: any) => r.status === 'failed').length;
  const total = results.length;

  return (
    <div className={classNames('px-4 py-2', { 'mt-2': !isFirst })}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors w-full text-left"
      >
        <span className={expanded ? 'i-ph:caret-down' : 'i-ph:caret-right'} />
        <span>
          {total} action{total !== 1 ? 's' : ''} ({succeeded} succeeded
          {failed > 0 ? `, ${failed} failed` : ''})
        </span>
        {failed > 0 && <span className="i-ph:warning text-bolt-elements-button-danger-text" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-5 space-y-1 text-xs font-mono text-bolt-elements-textSecondary border-l-2 border-bolt-elements-borderColor pl-3">
          {results.map((r: any, i: number) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className={
                  r.status === 'failed' ? 'text-bolt-elements-button-danger-text' : 'text-bolt-elements-icon-success'
                }
              >
                {r.status === 'failed' ? 'FAIL' : 'OK'}
              </span>
              <span>{r.type === 'file' ? `file: ${r.filePath}` : `${r.type}: ${r.command || r.content || ''}`}</span>
              {r.output && r.status === 'failed' && (
                <pre className="mt-1 whitespace-pre-wrap text-bolt-elements-button-danger-text opacity-80 max-h-20 overflow-auto">
                  {r.output.slice(0, 500)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
