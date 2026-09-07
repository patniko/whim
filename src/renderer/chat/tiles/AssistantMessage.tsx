import React, { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AssistantMessageProps {
  content: string;
  isStreaming: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ content, isStreaming }: AssistantMessageProps) {
  return (
    <div className="chat-assistant-message">
      <div className="chat-assistant-content">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const isInline = !className;
              if (isInline) {
                return <code className="chat-inline-code" {...props}>{children}</code>;
              }
              return (
                <pre className="chat-code-block">
                  <code className={className} {...props}>{children}</code>
                </pre>
              );
            },
            a({ href, children, ...props }) {
              return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
            },
          }}
        >
          {content}
        </Markdown>
        {isStreaming && <span className="streaming-cursor">▌</span>}
      </div>
    </div>
  );
});
