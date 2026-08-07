import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownCanvas, type MarkdownCanvasHandle, type AgentPersona, type MentionEvent, type CanvasSaveResult } from './MarkdownCanvas';
import type { CanvasAgentInteraction, CanvasPresence, CanvasUser, CanvasDecoration, CanvasThreadAgentStatus } from './types';

let root: Root | null = null;
let canvasRef: React.RefObject<MarkdownCanvasHandle | null> = React.createRef();

export interface MountCanvasOptions {
  spaceId: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  theme: 'light' | 'dark';
  personas?: AgentPersona[];
  agentPresence?: CanvasPresence[];
  agentThreadStatuses?: CanvasThreadAgentStatus[];
  agentInteractions?: readonly CanvasAgentInteraction[];
  onDirtyChange: (dirty: boolean) => void;
  onSaveStatus: (status: string) => void;
  onAgentMentioned?: (event: MentionEvent) => void;
  onInlineMention?: (handle: string, lineMarkdown: string, lineNumber: number) => void;
  onForkSelection?: (selectedText: string) => void;
  onExtractToPage?: (selectedText: string) => void;
  titleFallback?: string;
  onTitleChange?: (title: string) => void;
}

export function mountCanvas(container: HTMLElement, options: MountCanvasOptions): void {
  if (root) {
    root.unmount();
  }

  canvasRef = React.createRef();
  root = createRoot(container);
  root.render(
    <MarkdownCanvas
      ref={canvasRef}
      spaceId={options.spaceId}
      initialContent={options.content}
      initialFrontmatter={options.frontmatter}
      theme={options.theme}
      personas={options.personas}
      agentPresence={options.agentPresence}
      agentThreadStatuses={options.agentThreadStatuses}
      agentInteractions={options.agentInteractions}
      onDirtyChange={options.onDirtyChange}
      onSaveStatus={options.onSaveStatus}
      onAgentMentioned={options.onAgentMentioned}
      onInlineMention={options.onInlineMention}
      onForkSelection={options.onForkSelection}
      onExtractToPage={options.onExtractToPage}
      titleFallback={options.titleFallback}
      onTitleChange={options.onTitleChange}
    />
  );
}

export async function unmountCanvas(save = true): Promise<CanvasSaveResult> {
  if (save && canvasRef.current) {
    const result = await canvasRef.current.saveNow();
    if (!result.success) return result;
  }
  if (root) {
    root.unmount();
    root = null;
  }
  return { success: true };
}

export function getCanvasContent(): string {
  return canvasRef.current?.getContent() ?? '';
}

export async function saveCanvas(): Promise<CanvasSaveResult> {
  if (canvasRef.current) {
    return canvasRef.current.saveNow();
  }
  return { success: true };
}

export function updateCanvasPresence(presence: CanvasPresence[]): void {
  canvasRef.current?.updatePresence(presence);
}

export function updateCanvasAgentThreadStatuses(statuses: CanvasThreadAgentStatus[]): void {
  canvasRef.current?.updateAgentThreadStatuses(statuses);
}

export function updateCanvasAgentInteractions(interactions: readonly CanvasAgentInteraction[]): void {
  canvasRef.current?.updateAgentInteractions(interactions);
}

export function updateCanvasPersonas(personas: AgentPersona[]): void {
  canvasRef.current?.updatePersonas(personas);
}

export function updateCanvasDecorations(decorations: readonly CanvasDecoration[]): void {
  canvasRef.current?.updateDecorations(decorations);
}

export function updateCanvasAgentUsers(users: CanvasUser[]): void {
  canvasRef.current?.updateAgentUsers(users);
}

export function replaceCanvasContent(content: string): void {
  canvasRef.current?.replaceContent(content);
}

export function addCanvasCommentReply(threadId: string, body: string): void {
  canvasRef.current?.addCommentReply(threadId, body);
}

export function updateCanvasFrontmatter(frontmatter: Record<string, unknown>): void {
  canvasRef.current?.updateFrontmatter(frontmatter);
}

export function toggleCanvasMode(): { mode: string; error?: string } {
  return canvasRef.current?.toggleMode() ?? { mode: 'rendered' };
}

export function getCanvasEditorMode(): string {
  return canvasRef.current?.getEditorMode() ?? 'rendered';
}

export function appendCanvasLink(label: string, url: string): void {
  canvasRef.current?.appendLink(label, url);
}

export function replaceCanvasText(search: string, replacement: string): void {
  canvasRef.current?.replaceText(search, replacement);
}

export function getCanvasSelectedText(): string {
  return canvasRef.current?.getSelectedText() ?? '';
}

/**
 * Put the caret in the canvas editor.
 *
 * The imperative handle is only attached once React has committed the mount,
 * and Milkdown builds its view a frame later still, so callers that focus
 * straight after `mountCanvas` would find nothing to focus. Retrying across a
 * couple of frames keeps that timing out of every call site.
 */
export function focusCanvasEditor(): void {
  let attempts = 0;
  const attempt = () => {
    if (canvasRef.current) {
      canvasRef.current.focus();
      return;
    }
    if (attempts++ < 10) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
