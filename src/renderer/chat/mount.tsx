import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatView } from './ChatView';
import type { ChatHistorySource } from './transcript-layout';

let root: Root | null = null;

export interface MountChatOptions {
  agentId?: string;
  agentPrompt: string;
  agentStatus: string;
  agentSource?: 'sdk' | 'cli' | 'cca';
  spaceId?: string;
  sandboxed?: boolean;
  yolo?: boolean;
  pendingApprovalId?: string;
  pendingPermissionKind?: string;
  onClose: () => void;
  onOpenCli: (agentId: string) => void;
  onOpenCanvas?: (spaceId: string) => void;
  historySource?: ChatHistorySource;
}

export function mountChat(container: HTMLElement, options: MountChatOptions): void {
  if (root) {
    root.unmount();
  }

  root = createRoot(container);
  root.render(
    <ChatView
      agentId={options.agentId}
      agentPrompt={options.agentPrompt}
      agentStatus={options.agentStatus}
      agentSource={options.agentSource}
      spaceId={options.spaceId}
      sandboxed={options.sandboxed}
      yolo={options.yolo}
      pendingApprovalId={options.pendingApprovalId}
      pendingPermissionKind={options.pendingPermissionKind}
      onClose={options.onClose}
      onOpenCli={options.onOpenCli}
      onOpenCanvas={options.onOpenCanvas}
      historySource={options.historySource}
    />
  );
}

export function unmountChat(): void {
  if (root) {
    root.unmount();
    root = null;
  }
}
