import React, { lazy, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkerTiles } from './WorkerTiles';
import { FeatureBoundary } from '../FeatureBoundary';
const ChatView = lazy(() => import('../chat/ChatView').then(module => ({ default: module.ChatView })));

// ── Types ──────────────────────────────────────────────────

declare const whimAPI: {
  openAgentCli(agentId: string): Promise<any>;
  [key: string]: any;
};

export interface CanvasWorkerPanelOptions {
  spaceId: string;
  onChatPaneToggle: (open: boolean) => void;
}

// ── Module state ───────────────────────────────────────────

let tilesRoot: Root | null = null;
let chatRoot: Root | null = null;
let currentOptions: CanvasWorkerPanelOptions | null = null;
let selectedAgentId: string | null = null;
let chatPaneContainer: HTMLElement | null = null;
let tilesContainer: HTMLElement | null = null;

// ── Render helpers ─────────────────────────────────────────

function renderTiles() {
  if (!tilesRoot || !currentOptions) return;
  tilesRoot.render(
    <WorkerTiles
      spaceId={currentOptions.spaceId}
      selectedAgentId={selectedAgentId}
      onSelectAgent={handleSelectAgent}
    />
  );
}

function renderChat() {
  if (!chatRoot || !currentOptions || !selectedAgentId) return;
  chatRoot.render(
    <FeatureBoundary><Suspense fallback={<p role="status">Loading chat...</p>}>
    <ChatView
      agentId={selectedAgentId}
      agentPrompt=""
      agentStatus="running"
      spaceId={currentOptions.spaceId}
      onClose={closeChatPane}
      onOpenCli={(id: string) => whimAPI.openAgentCli(id)}
    />
    </Suspense></FeatureBoundary>
  );
}

// ── Event handlers ─────────────────────────────────────────

function handleSelectAgent(agentId: string, _prompt: string, _status: string, _source?: string) {
  if (selectedAgentId === agentId) {
    // Toggle off if clicking same agent
    closeChatPane();
    return;
  }

  selectedAgentId = agentId;
  if (chatPaneContainer) chatPaneContainer.classList.remove('hidden');
  currentOptions?.onChatPaneToggle(true);
  renderTiles();
  renderChat();
}

function closeChatPane() {
  selectedAgentId = null;
  if (chatRoot) {
    chatRoot.unmount();
    chatRoot = chatPaneContainer ? createRoot(chatPaneContainer) : null;
    // Clear contents by rendering nothing
    chatRoot?.render(<></>);
  }
  if (chatPaneContainer) chatPaneContainer.classList.add('hidden');
  currentOptions?.onChatPaneToggle(false);
  renderTiles();
}

// ── Public API ─────────────────────────────────────────────

export function mountCanvasWorkerPanel(
  tilesEl: HTMLElement,
  chatPaneEl: HTMLElement,
  options: CanvasWorkerPanelOptions,
): void {
  tilesContainer = tilesEl;
  chatPaneContainer = chatPaneEl;
  currentOptions = options;
  selectedAgentId = null;

  if (tilesRoot) tilesRoot.unmount();
  if (chatRoot) chatRoot.unmount();

  tilesRoot = createRoot(tilesEl);
  chatRoot = createRoot(chatPaneEl);

  chatPaneEl.classList.add('hidden');
  renderTiles();
}

export function unmountCanvasWorkerPanel(): void {
  if (tilesRoot) { tilesRoot.unmount(); tilesRoot = null; }
  if (chatRoot) { chatRoot.unmount(); chatRoot = null; }
  currentOptions = null;
  selectedAgentId = null;
  tilesContainer = null;
  chatPaneContainer = null;
}

export function isCanvasChatPaneOpen(): boolean {
  return selectedAgentId !== null;
}

export function closeCanvasChatPane(): void {
  if (selectedAgentId) closeChatPane();
}
