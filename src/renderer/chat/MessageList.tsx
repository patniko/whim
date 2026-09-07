import React, { memo, useMemo } from 'react';
import type { ChatMessage } from '../../shared/chat-types';
import { UserBubble } from './tiles/UserBubble';
import { AssistantMessage } from './tiles/AssistantMessage';
import { ToolTile } from './tiles/ToolTile';
import { SubagentTile } from './tiles/SubagentTile';
import { ReasoningTile } from './tiles/ReasoningTile';
import { ApprovalTile } from './tiles/ApprovalTile';
import { UserInputTile } from './tiles/UserInputTile';
import { ElicitationTile } from './tiles/ElicitationTile';
import { SandboxBlockTile } from './tiles/SandboxBlockTile';
import { TranscriptWindow } from './TranscriptWindow';
import type { ChatHistoryPaging } from './transcript-layout';

interface MessageListProps {
  messages: ChatMessage[];
  onApprovalRespond: (requestId: string, approved: boolean) => void;
  onUserInputRespond: (requestId: string, answer: string, wasFreeform: boolean) => void;
  onElicitationRespond: (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
  onSandboxResolve: (
    agentId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-for-session' | 'disable',
  ) => void;
  onEditSandboxConfig?: (personaHandle: string) => void;
  parentAgentId?: string;
  onOpenSubagentDetail?: (agentId: string) => void;
  historyPaging?: ChatHistoryPaging;
}

export const MessageList = memo(function MessageList({ messages, historyPaging, ...handlers }: MessageListProps) {
  // ask_user already has an interactive UserInputTile; do not allocate a blank row.
  const visibleMessages = useMemo(() => messages.filter(message =>
    message.type !== 'tool_call' || message.toolName !== 'ask_user'), [messages]);
  if (visibleMessages.length === 0 && !historyPaging) {
    return (
      <div className="chat-messages">
        <div className="chat-empty-state">
          <span className="chat-empty-icon">💬</span>
          <span>Watching agent activity...</span>
        </div>
      </div>
    );
  }

  return (
    <TranscriptWindow messages={visibleMessages} historyPaging={historyPaging}>
      {message => <MessageRow message={message} {...handlers} />}
    </TranscriptWindow>
  );
});

const MessageRow = memo(function MessageRow({
  message: msg, onApprovalRespond, onUserInputRespond, onElicitationRespond, onSandboxResolve,
  onEditSandboxConfig, parentAgentId, onOpenSubagentDetail,
}: Omit<MessageListProps, 'messages' | 'historyPaging'> & { message: ChatMessage }) {
  switch (msg.type) {
    case 'user':
      return <UserBubble content={msg.content} timestamp={msg.timestamp} attachments={msg.attachments} />;
    case 'assistant':
      return <AssistantMessage content={msg.content} isStreaming={msg.isStreaming} />;
    case 'tool_call':
      if (msg.toolName === '__subagent__') {
        return (
          <SubagentTile
            toolCallId={msg.toolCallId}
            name={String(msg.args.name || '')}
            displayName={String(msg.args.displayName || 'Sub-agent')}
            description={String(msg.args.description || '')}
            agentType={String(msg.args.agentType || '')}
            agentId={msg.args.agentId as string | undefined}
            completed={msg.completed}
            success={msg.success}
            error={msg.args.error as string | undefined}
            durationMs={msg.args.durationMs as number | undefined}
            model={msg.args.model as string | undefined}
            totalTokens={msg.args.totalTokens as number | undefined}
            totalToolCalls={msg.args.totalToolCalls as number | undefined}
            parentAgentId={parentAgentId || ''}
            onOpenDetail={onOpenSubagentDetail}
          />
        );
      }
      return (
        <ToolTile
          toolName={msg.toolName}
          args={msg.args}
          result={msg.result}
          completed={msg.completed}
          success={msg.success}
          error={msg.error}
        />
      );
    case 'reasoning':
      return <ReasoningTile content={msg.content} isStreaming={msg.isStreaming} />;
    case 'approval':
      return (
        <ApprovalTile
          requestId={msg.requestId}
          permissionKind={msg.permissionKind}
          intention={msg.intention}
          path={msg.path}
          responded={msg.responded}
          approved={msg.approved}
          onRespond={onApprovalRespond}
        />
      );
    case 'session_event':
      return (
        <div className={`chat-session-event ${msg.eventType}`}>
          {msg.eventType === 'error' ? '⚠️' : msg.eventType === 'info' ? 'ℹ️' : msg.eventType === 'completed' ? '✓' : '•'}{' '}
          {msg.message || msg.eventType}
        </div>
      );
    case 'user_input':
      return (
        <UserInputTile
          requestId={msg.requestId}
          question={msg.question}
          choices={msg.choices}
          allowFreeform={msg.allowFreeform}
          responded={msg.responded}
          answer={msg.answer}
          wasFreeform={msg.wasFreeform}
          onRespond={onUserInputRespond}
        />
      );
    case 'elicitation':
      return (
        <ElicitationTile
          requestId={msg.requestId}
          message={msg.message}
          requestedSchema={msg.requestedSchema}
          mode={msg.mode}
          elicitationSource={msg.elicitationSource}
          responded={msg.responded}
          action={msg.action}
          content={msg.content}
          onRespond={onElicitationRespond}
        />
      );
    case 'sandbox_block':
      return (
        <SandboxBlockTile
          requestId={msg.requestId}
          agentId={msg.agentId}
          source={msg.source}
          kind={msg.kind}
          toolName={msg.toolName}
          target={msg.target}
          intention={msg.intention}
          allowedDecisions={msg.allowedDecisions}
          layer={msg.layer}
          personaHandle={msg.personaHandle}
          responded={msg.responded}
          decision={msg.decision}
          onResolve={onSandboxResolve}
          onEditSandboxConfig={onEditSandboxConfig}
        />
      );
    default:
      return null;
  }
});
