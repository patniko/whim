import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { MilkdownEditor, type MilkdownEditorHandle } from './editor/MilkdownEditor';
import { startTiming } from '../../shared/performance';
import type {
  CanvasUser,
  CanvasPresence,
  CanvasAgentInteraction,
  CanvasDecoration,
  CanvasThreadAgentStatus,
  CommentThread,
  CommentTrigger,
} from './types';
import { splitComments, joinComments, extractMentions, newThreadId } from './editor/comments';
import { SelectionToolbar, CommentComposer, CommentPopover } from './editor/CommentUI';
import { MentionPopup } from './editor/MentionUI';
import { filterMentionCandidates, normalizeMentionLaunchText, type MentionCandidate } from './editor/mentions';
import type { Rect, SelectionInfo, MentionQuery, FormatMark } from './editor/geometry';
import { FrontmatterEditor } from './FrontmatterEditor';
import { VoiceRecorderButton, type VoiceRecordingResult } from './VoiceRecorderButton';
import { SpaceLinkPicker, type SpaceResult } from './SpaceLinkPicker';
import { merge3 } from '../../shared/text-merge';
import { mergeCanvasDocument } from './document-merge';
import { hasDisplayableFrontmatter, serializeFrontmatter, tryParseFrontmatter } from '../../shared/frontmatter';
import { deriveMarkdownTitle } from '../../shared/markdown-title';
import { isWebRemote } from '../transport-mode';
import type { CanvasLinkTarget } from '../../shared/ipc-contract';

declare const whimAPI: {
  writeCanvas(spaceId: string, content: string): Promise<CanvasSaveResult>;
  pasteFile(spaceId: string, filename: string, dataArray: number[]): Promise<{ error?: string; filename?: string; relativePath?: string }>;
  readFile(spaceId: string, relativePath: string): Promise<{ data?: number[]; mimeType?: string; error?: string }>;
  getSetting(key: string): Promise<string | null>;
  transcribe(audioData: number[]): Promise<string>;
  list(): Promise<Array<{ id: string; description: string; status: string }>>;
  searchSpaces(query: string): Promise<Array<{ id: string; description: string; status: string }>>;
  openCanvasWindow(target: { kind: string; id: string; title: string }): void;
  createPage(spaceId: string, pageName: string): Promise<{ success: boolean; page: string; error?: string }>;
  readPage(spaceId: string, pageName: string): Promise<{ content: string; error?: string }>;
  writePage(spaceId: string, pageName: string, content: string): Promise<{ success?: boolean; error?: string }>;
  closePage(spaceId: string, pageName: string, content: string): Promise<{ success?: boolean; error?: string }>;
  listPages(spaceId: string): Promise<{ pages: string[]; error?: string }>;
  openPageWindow(target: { kind: 'page'; spaceId: string; page: string; title: string }): void;
  openCanvasArtifact(spaceId: string, artifactId: string): Promise<{ ok?: true; error?: string }>;
  openExternal(url: string): Promise<{ ok: true }>;
  openLink(spaceId: string, url: string): Promise<{ action: string; error?: string }>;
  resolveLink(spaceId: string, url: string): Promise<CanvasLinkTarget>;
  approveAgent(agentId: string, requestId: string, approved: boolean): Promise<void>;
  respondToUserInput(agentId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void>;
  respondToElicitation(agentId: string, requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void>;
  resolveSandboxBlock(agentId: string, requestId: string, decision: 'allow-once' | 'allow-for-session' | 'disable'): Promise<void>;
};

export interface CanvasSaveResult {
  success: boolean;
  content?: string;
  error?: string;
}

/** A canvas to navigate to in this window. Mirrors the desktop's window target. */
export interface CanvasTargetRequest {
  kind: string;
  id: string;
  title: string;
  spaceId?: string;
  page?: string;
  filePath?: string;
}

/**
 * Route a whim:// resource click.
 *
 * On the desktop each of these opens a window, requested with a
 * fire-and-forget send. A browser has no second window, and the web transport
 * drops those sends — so every link in a document was dead over the web
 * remote. Where the canvas is drawn inline, `openCanvasTarget` navigates this
 * window instead; the window openers remain the desktop path.
 *
 * `notify` reports what could not be done. Silence is the failure mode this
 * whole function exists to avoid: the user clicked a link that plainly refers
 * to something, and deserves to know it is not reachable from here.
 */
export function openWhimResource(url: string, notify?: (message: string) => void): void {
  const openInline = (globalThis as { openCanvasTarget?: (t: CanvasTargetRequest) => void })
    .openCanvasTarget;

  if (url.startsWith('whim://space/')) {
    const id = url.slice('whim://space/'.length);
    if (!id) return;
    if (openInline) openInline({ kind: 'space', id, title: '' });
    else whimAPI.openCanvasWindow({ kind: 'space', id, title: '' });
    return;
  }
  if (url.startsWith('whim://artifact/')) {
    const parts = url.slice('whim://artifact/'.length).split('/');
    if (parts.length >= 2) {
      try {
        const spaceId = decodeURIComponent(parts[0]);
        const artifactId = decodeURIComponent(parts.slice(1).join('/'));
        if (spaceId && artifactId) {
          // Reports are agent-authored HTML served from a private Electron
          // scheme that deliberately never leaves the desktop app, so there is
          // nothing to route to here — say so rather than doing nothing.
          void whimAPI.openCanvasArtifact(spaceId, artifactId).catch(() => {
            notify?.('Reports open in the desktop app.');
          });
        }
      } catch { /* a malformed link opens nothing rather than throwing */ }
    }
    return;
  }
  if (url.startsWith('whim://page/')) {
    const parts = decodeURIComponent(url.slice('whim://page/'.length)).split('/');
    if (parts.length >= 2) {
      const [spaceId, ...rest] = parts;
      const page = rest.join('/');
      if (openInline) openInline({ kind: 'page', id: spaceId, spaceId, page, title: page });
      else whimAPI.openPageWindow({ kind: 'page', spaceId, page, title: page });
    }
  }
}

export interface AgentPersona {
  id: string;
  handle: string;
  instructions: string;
  model: string;
  emoji?: string;
  cliRuntime?: string;
}

export interface MentionEvent {
  handles: string[];
  commentBody: string;
  quote: string;
  anchor: { prefix?: string; suffix?: string };
  threadId: string | null;
}

export interface MarkdownCanvasProps {
  spaceId: string;
  initialContent: string;
  initialFrontmatter?: Record<string, unknown>;
  theme: 'light' | 'dark';
  personas?: AgentPersona[];
  agentPresence?: CanvasPresence[];
  agentThreadStatuses?: CanvasThreadAgentStatus[];
  agentInteractions?: readonly CanvasAgentInteraction[];
  decorations?: readonly CanvasDecoration[];
  onDirtyChange: (dirty: boolean) => void;
  onSaveStatus: (status: string) => void;
  onAgentMentioned?: (event: MentionEvent) => void;
  onInlineMention?: (handle: string, lineMarkdown: string, lineNumber: number) => void;
  onForkSelection?: (selectedText: string) => void;
  onExtractToPage?: (selectedText: string) => void;
  titleFallback?: string;
  onTitleChange?: (title: string) => void;
}

export interface MarkdownCanvasHandle {
  saveNow(): Promise<CanvasSaveResult>;
  getContent(): string;
  getEditorMode(): EditorMode;
  toggleMode(): { mode: EditorMode; error?: string };
  updatePresence(presence: CanvasPresence[]): void;
  updateAgentThreadStatuses(statuses: CanvasThreadAgentStatus[]): void;
  updateAgentInteractions(interactions: readonly CanvasAgentInteraction[]): void;
  updatePersonas(personas: AgentPersona[]): void;
  updateDecorations(decorations: readonly CanvasDecoration[]): void;
  updateAgentUsers(users: CanvasUser[]): void;
  addCommentReply(threadId: string, body: string): void;
  updateFrontmatter(frontmatter: Record<string, unknown>): void;
  replaceContent(content: string): void;
  appendLink(label: string, url: string): void;
  replaceText(search: string, replacement: string): void;
  getSelectedText(): string;
  focus(): void;
}

const AUTOSAVE_DELAY_MS = 2000;

export function mergeDirtyRawExternalChange(base: string, local: string, disk: string): string {
  return merge3(base, local, disk).merged;
}

const VOICE_PLACEHOLDER = '🎤 *[Recording transcription…]*';

type EditorMode = 'rendered' | 'raw';

/** Serialize frontmatter + body into a markdown string with YAML block. */
function serializeFm(fm: Record<string, unknown>, body: string): string {
  return serializeFrontmatter(fm, body);
}

/** Try to parse frontmatter from raw markdown. Returns null if YAML is invalid. */
function tryParseFm(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  return tryParseFrontmatter(raw);
}

function formatAttachmentRef(filename: string, relativePath: string, mimeType: string): string {
  if (mimeType.startsWith('image/')) {
    return `\n![${filename}](${relativePath})\n`;
  }
  const icon = mimeType.startsWith('audio/') ? '🎵' :
               mimeType.startsWith('video/') ? '🎬' : '📎';
  return `\n[${icon} ${filename}](${relativePath})\n`;
}

export const MarkdownCanvas = forwardRef<MarkdownCanvasHandle, MarkdownCanvasProps>(
  function MarkdownCanvas({ spaceId, initialContent, initialFrontmatter, theme, personas: initialPersonas, agentPresence: initialPresence, agentThreadStatuses: initialAgentThreadStatuses, agentInteractions: initialAgentInteractions, decorations: initialDecorations, onDirtyChange, onSaveStatus, onAgentMentioned, onInlineMention, onForkSelection, onExtractToPage, titleFallback = 'Untitled', onTitleChange }, ref) {
    const hasFrontmatter = initialFrontmatter !== undefined;
    // Round-trip frontmatter on save whenever it's present (`hasFrontmatter`), but only
    // surface the editor UI when there's something meaningful to edit — so spaces whose
    // only frontmatter is linked skills (or none) don't show a "Properties" box.
    const showFrontmatterEditor = initialFrontmatter !== undefined && hasDisplayableFrontmatter(initialFrontmatter);

    // Split the embedded comments block out of the editor body once at mount.
    const initialSplit = useMemo(() => splitComments(initialContent), [initialContent]);

    const [content, setContent] = useState(initialSplit.body);
    const [threads, setThreads] = useState<CommentThread[]>(initialSplit.threads);
    const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>(initialFrontmatter ?? {});
    const [editorMode, setEditorMode] = useState<EditorMode>('rendered');
    const [rawContent, setRawContent] = useState('');
    const [parseError, setParseError] = useState<string | null>(null);

    const contentRef = useRef(content);
    const threadsRef = useRef(threads);

    /**
     * Say why something did not happen.
     *
     * Reuses the save-status line rather than introducing a second
     * notification surface. Held in a ref so link handlers do not have to be
     * rebuilt when the callback identity changes.
     */
    const notifyRef = useRef<(message: string) => void>(() => {});
    notifyRef.current = (message: string) => {
      onSaveStatus(message);
      setTimeout(() => onSaveStatus(''), 4000);
    };
    const frontmatterRef = useRef(frontmatter);
    const editorModeRef = useRef<EditorMode>(editorMode);
    const rawContentRef = useRef(rawContent);
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<MilkdownEditorHandle>(null);
    const editorContentPendingRef = useRef(false);
    const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
    const onTitleChangeRef = useRef(onTitleChange);
    const titleFallbackRef = useRef(titleFallback);
    const lastEmittedTitleRef = useRef<string | null>(null);

    const hasFrontmatterRef = useRef(hasFrontmatter);
    hasFrontmatterRef.current = hasFrontmatter;

    /** Full on-disk string: frontmatter + body + comments block. */
    const buildFull = useCallback((body: string, t: CommentThread[]) => {
      const withComments = joinComments(body, t);
      return hasFrontmatterRef.current ? serializeFm(frontmatterRef.current, withComments) : withComments;
    }, []);

    const initialFull = useMemo(
      () => buildFull(initialSplit.body, initialSplit.threads),
      [buildFull, initialSplit],
    );

    const lastSavedRef = useRef(initialFull);
    const lastDiskContentRef = useRef(initialFull);
    const pendingSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    const mergeControllerRef = useRef<AbortController | null>(null);
    const mergeRevisionRef = useRef(0);
    const mountedRef = useRef(true);
    const unresolvedMergeRef = useRef<{ disk: string; base: string; acknowledgement: boolean } | null>(null);
    const reconcileRef = useRef<((disk: string, base: string, acknowledgement: boolean) => Promise<boolean>) | null>(null);

    const [isDragging, setIsDragging] = useState(false);
    const [personas, setPersonas] = useState<AgentPersona[]>(initialPersonas || []);
    const [presence, setPresence] = useState<CanvasPresence[]>(initialPresence || []);
    const [agentThreadStatuses, setAgentThreadStatuses] = useState<CanvasThreadAgentStatus[]>(initialAgentThreadStatuses || []);
    const [agentInteractions, setAgentInteractions] = useState<readonly CanvasAgentInteraction[]>(initialAgentInteractions || []);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [decorations, setDecorations] = useState<readonly CanvasDecoration[]>(initialDecorations || []);
    const [agentUsers, setAgentUsers] = useState<CanvasUser[]>([]);
    const [showLinkPicker, setShowLinkPicker] = useState(false);
    const [commentTrigger, setCommentTrigger] = useState<CommentTrigger>('caret');

    // Comment UI state
    const [activeComment, setActiveComment] = useState<{ id: string; rect: Rect } | null>(null);
    const [selection, setSelection] = useState<SelectionInfo | null>(null);
    const [linkEditing, setLinkEditing] = useState(false);
    const [composer, setComposer] = useState<{ quote: string; anchor: { prefix?: string; suffix?: string; kind?: string }; rect: Rect } | null>(null);

    // Mention suggestion state
    const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);
    const mentionQueryRef = useRef<MentionQuery | null>(null);
    const recentInlineMentions = useRef(new Set<string>());

    const personasRef = useRef(personas);
    personasRef.current = personas;

    const agentMentionCandidates: MentionCandidate[] = useMemo(
      () => personas.map(p => ({ handle: p.handle, emoji: p.emoji, model: p.model })),
      [personas],
    );

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const val = await whimAPI.getSetting('comment_trigger');
          if (!cancelled) {
            setCommentTrigger(val === 'hover-or-caret' ? 'hover-or-caret' : 'caret');
          }
        } catch { /* keep default */ }
      })();
      return () => { cancelled = true; };
    }, []);

    contentRef.current = content;
    threadsRef.current = threads;
    frontmatterRef.current = frontmatter;
    editorModeRef.current = editorMode;
    rawContentRef.current = rawContent;
    onTitleChangeRef.current = onTitleChange;
    titleFallbackRef.current = titleFallback;

    void agentUsers;

    const emitTitleChange = useCallback((markdown: string) => {
      if (!onTitleChangeRef.current) return;
      const title = deriveMarkdownTitle(markdown, titleFallbackRef.current);
      if (title === lastEmittedTitleRef.current) return;
      lastEmittedTitleRef.current = title;
      onTitleChangeRef.current(title);
    }, []);

    useEffect(() => {
      emitTitleChange(contentRef.current);
    }, [emitTitleChange]);

    const getBody = useCallback(() => {
      if (editorModeRef.current === 'rendered' && editorContentPendingRef.current && editorRef.current?.isReady()) {
        return editorRef.current.getMarkdown();
      }
      return contentRef.current;
    }, []);

    /** Include real editor revisions that have not reached the debounced listener. */
    const getFullContent = useCallback(() => {
      if (editorModeRef.current === 'raw') return rawContentRef.current;
      return buildFull(getBody(), threadsRef.current);
    }, [buildFull, getBody]);

    // Merge persona users (for mention roster) with active agent users (for presence display)
    const users: CanvasUser[] = useMemo(
      () => [
        ...personas.map(p => ({ id: p.handle, username: p.handle })),
        ...agentUsers,
      ],
      [personas, agentUsers],
    );
    void users;

    const saveRequestedDuringSaveRef = useRef(false);
    const savingPromiseRef = useRef<Promise<CanvasSaveResult> | null>(null);
    const doSaveRef = useRef<(() => Promise<CanvasSaveResult>) | undefined>(undefined);

    const doSave = useCallback(async () => {
      if (savingPromiseRef.current) {
        saveRequestedDuringSaveRef.current = true;
        const inFlightResult = await savingPromiseRef.current;
        if (getFullContent() !== lastSavedRef.current || unresolvedMergeRef.current) {
          return doSaveRef.current?.() ?? { success: false, error: 'save_failed' };
        }
        return inFlightResult;
      }
      const unresolved = unresolvedMergeRef.current;
      if (unresolved && !(await reconcileRef.current?.(unresolved.disk, unresolved.base, unresolved.acknowledgement))) {
        return { success: false, error: 'merge_unresolved: Both versions retained; save a separate copy before closing.' };
      }
      const fullContent = getFullContent();
      if (fullContent === lastSavedRef.current) return { success: true };

      savingRef.current = true;
      const endSave = startTiming('save.document');
      const savePromise = (async (): Promise<CanvasSaveResult> => {
        try {
          const result = await whimAPI.writeCanvas(spaceId, fullContent);
          if (!result?.success) {
            endSave(false);
            onSaveStatus(`✗ save failed${result?.error ? `: ${result.error}` : ''}`);
            return result ?? { success: false, error: 'save_failed' };
          }
          const savedContent = result.content ?? fullContent;
          endSave();
          if (!mountedRef.current) return { success: true, content: result.content };
          lastSavedRef.current = savedContent;
          if (savedContent !== fullContent) {
            // Rebase edits made while the durable save was in flight. Never
            // apply an acknowledgement directly over a newer local revision.
            if (unresolvedMergeRef.current ||
              !(await reconcileRef.current?.(savedContent, fullContent, true))) {
              onSaveStatus('Saved version differs; external merge unresolved. Local edits retained.');
              return { success: false, error: 'merge_unresolved' };
            }
          } else if (!unresolvedMergeRef.current) {
            lastDiskContentRef.current = savedContent;
          }
          if (unresolvedMergeRef.current) return { success: false, error: 'merge_unresolved' };
          const dirty = getFullContent() !== lastSavedRef.current;
          onDirtyChange(dirty);
          onSaveStatus(dirty ? 'Saving…' : 'Saved ✓');
          setTimeout(() => {
            if (!unresolvedMergeRef.current && getFullContent() === lastSavedRef.current) onSaveStatus('');
          }, 1500);
          return { success: true, content: result.content };
        } catch {
          endSave(false);
          onSaveStatus('✗ save failed');
          setTimeout(() => onSaveStatus(''), 3000);
          return { success: false, error: 'save_failed' };
        }
      })();
      savingPromiseRef.current = savePromise;
      const result = await savePromise;
      if (savingPromiseRef.current === savePromise) savingPromiseRef.current = null;
      try {
        return result;
      } finally {
        savingRef.current = false;
        if (saveRequestedDuringSaveRef.current) {
          saveRequestedDuringSaveRef.current = false;
          if (getFullContent() !== lastSavedRef.current) {
            setTimeout(() => { void doSaveRef.current?.(); }, 0);
          }
        }
      }
    }, [spaceId, onDirtyChange, onSaveStatus, getFullContent]);
    doSaveRef.current = doSave;

    const scheduleSave = useCallback(() => {
      if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current);
      pendingSaveRef.current = setTimeout(() => {
        pendingSaveRef.current = null;
        doSave();
      }, AUTOSAVE_DELAY_MS);
    }, [doSave]);

    const onEditorDocumentChanged = useCallback(() => {
      editorContentPendingRef.current = true;
      mergeRevisionRef.current++;
      onDirtyChange(true);
      onSaveStatus('Saving…');
      scheduleSave();
    }, [onDirtyChange, onSaveStatus, scheduleSave]);

    const saveNow = useCallback(async () => {
      if (pendingSaveRef.current) {
        clearTimeout(pendingSaveRef.current);
        pendingSaveRef.current = null;
      }
      // Explicit save/close must acknowledge the latest revision, not just the
      // document that happened to be in flight when the user clicked Save.
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await doSave();
        if (!result.success) return result;
        if (getFullContent() === lastSavedRef.current && !unresolvedMergeRef.current) return result;
      }
      onSaveStatus('Document is still changing; local edits retained. Try saving again.');
      return { success: false, error: 'document_still_changing' };
    }, [doSave, getFullContent, onSaveStatus]);

    const markDirtyAndSave = useCallback(() => {
      mergeRevisionRef.current++;
      const dirty = getFullContent() !== lastSavedRef.current;
      onDirtyChange(dirty);
      if (dirty) {
        onSaveStatus('Saving…');
        scheduleSave();
      }
    }, [getFullContent, onDirtyChange, onSaveStatus, scheduleSave]);

    // Content change ORIGINATING in the editor (user typing).
    const onEditorContentChanged = useCallback((newBody: string) => {
      editorContentPendingRef.current = false;
      if (newBody === contentRef.current) {
        markDirtyAndSave();
        return;
      }
      setContent(newBody);
      contentRef.current = newBody;
      emitTitleChange(newBody);
      markDirtyAndSave();
    }, [emitTitleChange, markDirtyAndSave]);

    // Content change ORIGINATING in the host (voice, drop, links, replies).
    const applyProgrammaticContent = useCallback((newBody: string) => {
      if (newBody === getBody()) return;
      setContent(newBody);
      contentRef.current = newBody;
      emitTitleChange(newBody);
      if (editorModeRef.current === 'rendered') {
        editorRef.current?.replaceAll(newBody, { animate: true });
      }
      editorContentPendingRef.current = false;
      markDirtyAndSave();
    }, [emitTitleChange, markDirtyAndSave, getBody]);

    /** Update threads, re-highlight, and persist (body is unchanged). */
    const updateThreads = useCallback((next: CommentThread[]) => {
      setThreads(next);
      threadsRef.current = next;
      markDirtyAndSave();
    }, [markDirtyAndSave]);

    const fireMentions = useCallback((body: string, quote: string, anchor: { prefix?: string; suffix?: string }, threadId: string) => {
      if (!onAgentMentioned) return;
      const handles = extractMentions(body, personasRef.current.map(p => p.handle));
      if (handles.length === 0) return;
      onAgentMentioned({ handles, commentBody: body, quote, anchor, threadId });
    }, [onAgentMentioned]);

    const handleFrontmatterChange = useCallback((updated: Record<string, unknown>) => {
      setFrontmatter(updated);
      frontmatterRef.current = updated;
      if (editorModeRef.current === 'raw') {
        const parsed = tryParseFm(rawContentRef.current);
        const nextRaw = serializeFm(updated, parsed?.body ?? rawContentRef.current);
        setRawContent(nextRaw);
        rawContentRef.current = nextRaw;
      }
      markDirtyAndSave();
    }, [markDirtyAndSave]);

    const handleToggleMode = useCallback((): { mode: EditorMode; error?: string } => {
      mergeRevisionRef.current++;
      if (editorModeRef.current === 'rendered') {
        const full = getFullContent();
        editorContentPendingRef.current = false;
        setRawContent(full);
        rawContentRef.current = full;
        setParseError(null);
        setEditorMode('raw');
        editorModeRef.current = 'raw';
        return { mode: 'raw' };
      } else {
        let region = rawContentRef.current;
        if (hasFrontmatter) {
          const parsed = tryParseFm(rawContentRef.current);
          if (!parsed) {
            const err = 'Invalid YAML frontmatter. Fix the syntax before switching to rendered view.';
            setParseError(err);
            return { mode: 'raw', error: err };
          }
          setFrontmatter(parsed.frontmatter);
          frontmatterRef.current = parsed.frontmatter;
          region = parsed.body;
        }
        const { body, threads: parsedThreads } = splitComments(region);
        setContent(body);
        contentRef.current = body;
        emitTitleChange(body);
        setThreads(parsedThreads);
        threadsRef.current = parsedThreads;
        setParseError(null);
        setEditorMode('rendered');
        editorModeRef.current = 'rendered';
        return { mode: 'rendered' };
      }
    }, [emitTitleChange, hasFrontmatter, getFullContent]);

    const handleRawContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newRaw = e.target.value;
      setRawContent(newRaw);
      rawContentRef.current = newRaw;
      setParseError(null);
      // Keep body/threads refs roughly in sync so a save reflects raw edits.
      const region = hasFrontmatter ? (tryParseFm(newRaw)?.body ?? newRaw) : newRaw;
      const split = splitComments(region);
      contentRef.current = split.body;
      threadsRef.current = split.threads;
      if (hasFrontmatter) {
        const parsed = tryParseFm(newRaw);
        if (parsed) frontmatterRef.current = parsed.frontmatter;
      }
      emitTitleChange(newRaw);
      markDirtyAndSave();
    }, [emitTitleChange, hasFrontmatter, markDirtyAndSave]);

    const reconcileExternal = useCallback(async (disk: string, base: string, acknowledgement: boolean): Promise<boolean> => {
      mergeControllerRef.current?.abort();
      const controller = new AbortController();
      mergeControllerRef.current = controller;
      const pending = { disk, base, acknowledgement };
      unresolvedMergeRef.current = pending;
      if (pendingSaveRef.current) {
        clearTimeout(pendingSaveRef.current);
        pendingSaveRef.current = null;
      }
      try {
        // A typing burst may invalidate a result. Recompute from the unchanged
        // ancestor, but bound retries so continuous typing cannot queue copies.
        for (let attempt = 0; attempt < 3; attempt++) {
          const local = getFullContent();
          const revision = mergeRevisionRef.current;
          const mode = editorModeRef.current;
          const rawDirty = mode === 'raw' && local !== lastSavedRef.current;
          const merged = await mergeCanvasDocument(
            base, local, disk, rawDirty || acknowledgement,
            hasFrontmatterRef.current, controller.signal,
          );
          if (controller.signal.aborted || !mountedRef.current || unresolvedMergeRef.current !== pending) return false;
          if (revision !== mergeRevisionRef.current || local !== getFullContent() || mode !== editorModeRef.current) continue;
          if (acknowledgement && mode !== 'raw' && hasFrontmatterRef.current && !merged.frontmatter) {
            throw new Error('Merged frontmatter is invalid; save a separate copy and resolve it in raw mode');
          }
          setContent(merged.body);
          contentRef.current = merged.body;
          setThreads(merged.threads);
          threadsRef.current = merged.threads;
          if (hasFrontmatterRef.current && (merged.frontmatter || !rawDirty)) {
            setFrontmatter(merged.frontmatter ?? {});
            frontmatterRef.current = merged.frontmatter ?? {};
          }
          if (mode === 'raw') {
            setRawContent(merged.full);
            rawContentRef.current = merged.full;
          } else {
            editorRef.current?.replaceAll(merged.body, { animate: true });
          }
          editorContentPendingRef.current = false;
          mergeRevisionRef.current++;
          lastDiskContentRef.current = merged.synchronizedDisk;
          unresolvedMergeRef.current = null;
          emitTitleChange(merged.body);
          const dirty = (rawDirty && !acknowledgement) || merged.full !== merged.synchronizedDisk;
          if (!dirty) lastSavedRef.current = merged.full;
          onDirtyChange(dirty);
          if (dirty && mode === 'raw' && !acknowledgement) {
            onSaveStatus('External changes merged — review and save');
          } else if (dirty) {
            scheduleSave();
          }
          return true;
        }
        onSaveStatus('Merge paused while editing. Both versions retained; press Save to retry.');
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current) return false;
        onSaveStatus(`Merge failed: ${error instanceof Error ? error.message : 'merge_failed'}. Local edits and disk version retained.`);
      }
      return false;
    }, [getFullContent, onDirtyChange, onSaveStatus, scheduleSave, emitTitleChange]);
    reconcileRef.current = reconcileExternal;

    useImperativeHandle(ref, () => ({
      saveNow,
      getContent: () => getFullContent(),
      getEditorMode: () => editorModeRef.current,
      toggleMode: () => handleToggleMode(),
      updatePresence: (nextPresence: CanvasPresence[]) => setPresence(nextPresence),
      updateAgentThreadStatuses: (nextStatuses: CanvasThreadAgentStatus[]) => setAgentThreadStatuses(nextStatuses),
      updateAgentInteractions: (nextInteractions: readonly CanvasAgentInteraction[]) => setAgentInteractions(nextInteractions),
      updatePersonas: (nextPersonas: AgentPersona[]) => setPersonas(nextPersonas),
      updateDecorations: (nextDecorations: readonly CanvasDecoration[]) => setDecorations(nextDecorations),
      updateAgentUsers: (nextUsers: CanvasUser[]) => setAgentUsers(nextUsers),
      addCommentReply: (threadId: string, body: string) => {
        const current = threadsRef.current;
        const idx = current.findIndex(t => t.id === threadId);
        if (idx < 0) return;
        const next = current.map((t, i) =>
          i === idx ? { ...t, comments: [...t.comments, { body, updatedAt: new Date().toISOString() }] } : t,
        );
        updateThreads(next);
      },
      updateFrontmatter: handleFrontmatterChange,
      replaceContent: (newDiskContent: string) => {
        mergeRevisionRef.current++;
        void reconcileExternal(newDiskContent, lastDiskContentRef.current, false);
      },
      appendLink: (label: string, url: string) => {
        const link = `[${label}](${url})`;
        const current = getBody();
        const separator = current.endsWith('\n') || current === '' ? '' : '\n';
        applyProgrammaticContent(current + separator + link);
      },
      replaceText: (search: string, replacement: string) => {
        const current = getBody();
        const idx = current.indexOf(search);
        if (idx === -1) return;
        const updated = current.slice(0, idx) + replacement + current.slice(idx + search.length);
        applyProgrammaticContent(updated);
      },
      getSelectedText: () => {
        if (editorModeRef.current === 'rendered') {
          const fromEditor = editorRef.current?.getSelectedText();
          if (fromEditor) return fromEditor;
        }
        const sel = window.getSelection();
        return sel ? sel.toString() : '';
      },
      focus: () => {
        if (editorModeRef.current === 'raw') rawTextareaRef.current?.focus();
        else editorRef.current?.focus();
      },
    }), [saveNow, applyProgrammaticContent, updateThreads, getFullContent, getBody, handleToggleMode, handleFrontmatterChange, reconcileExternal]);

    // Cmd+S handler
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          saveNow();
        }
      };
      el.addEventListener('keydown', handler);
      return () => el.removeEventListener('keydown', handler);
    }, [saveNow]);

    // Cmd+P handler — open space link picker
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
          e.preventDefault();
          setShowLinkPicker(prev => !prev);
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, []);

    const handleLinkPickerSelect = useCallback((space: SpaceResult) => {
      setShowLinkPicker(false);
      const link = `[${space.description || 'Untitled'}](whim://space/${space.id})`;
      const current = getBody();
      const separator = current.endsWith('\n') || current === '' ? '' : '\n';
      applyProgrammaticContent(current + separator + link);
    }, [applyProgrammaticContent, getBody]);

    // Resolve workspace-relative image srcs into object URLs for display.
    const resolveImageSrc = useCallback(async (src: string): Promise<string | null> => {
      // Over the web, point the browser at the attachment endpoint rather than
      // pulling the bytes through the RPC. `canvas:read-file` hands back a
      // JSON array of numbers — roughly four times the size of the image, and
      // one rate-limit token per picture — and then the blob URL it becomes is
      // uncacheable, so every remount re-fetches everything. A plain URL
      // streams once and is cached by the browser.
      if (isWebRemote()) {
        if (!src) return null;
        // Absolute and inline sources are already loadable as they stand.
        if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
        return `/api/attachment?spaceId=${encodeURIComponent(spaceId)}&path=${encodeURIComponent(src)}`;
      }
      try {
        const r = await whimAPI.readFile(spaceId, src);
        if (r.error || !r.data) return null;
        const blob = new Blob([new Uint8Array(r.data)], { type: r.mimeType || 'application/octet-stream' });
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    }, [spaceId]);

    // Persist a pasted image and return its workspace-relative src.
    const uploadFile = useCallback(async (file: File): Promise<{ src: string } | null> => {
      try {
        const buffer = await file.arrayBuffer();
        const dataArray = Array.from(new Uint8Array(buffer));
        const r = await whimAPI.pasteFile(spaceId, file.name, dataArray);
        if (r.error || !r.relativePath) return null;
        return { src: r.relativePath };
      } catch {
        return null;
      }
    }, [spaceId]);

    // Route link clicks. `whim://` navigates within whim; everything else is
    // resolved against the workspace and then applied here — because what a
    // link means is a shared question, but opening it is not: the desktop has
    // a shell and a file manager, and a browser has a new tab.
    const handleLinkClick = useCallback((url: string) => {
      if (url.startsWith('whim://')) {
        openWhimResource(url, notifyRef.current);
        return;
      }
      if (!isWebRemote()) {
        whimAPI.openLink(spaceId, url);
        return;
      }
      void whimAPI.resolveLink(spaceId, url).then((target) => {
        if (target.kind === 'external') {
          // `noopener` keeps the opened page from reaching back through
          // `window.opener` into a tab holding this session.
          window.open(target.url, '_blank', 'noopener,noreferrer');
          return;
        }
        if (target.kind === 'canvas') {
          const openInline = (globalThis as { openCanvasTarget?: (t: CanvasTargetRequest) => void })
            .openCanvasTarget;
          const title = target.filePath.split('/').pop() ?? target.filePath;
          if (openInline) openInline({ kind: 'file', id: target.filePath, filePath: target.filePath, title });
          return;
        }
        if (target.kind === 'file') {
          // The file is on the machine running whim, not the one holding this
          // tab, so there is nowhere here to open it.
          notifyRef.current?.('That file opens in the desktop app.');
        }
      }).catch(() => {
        notifyRef.current?.('Could not open that link.');
      });
    }, [spaceId]);

    // ── Comment interactions ───────────────────────────────
    const handleCommentActivate = useCallback((threadId: string | null, rect: Rect | null) => {
      if (threadId && rect) {
        setComposer(null);
        setActiveComment({ id: threadId, rect });
      } else {
        setActiveComment(null);
      }
    }, []);

    const handleSelectionChange = useCallback((info: SelectionInfo | null) => {
      setSelection(info);
    }, []);

    const handleStartComment = useCallback(() => {
      const anchor = editorRef.current?.getSelectionAnchor();
      const sel = selection;
      if (!anchor || !sel) return;
      setSelection(null);
      setActiveComment(null);
      setComposer({ quote: anchor.quote, anchor: anchor.anchor, rect: sel.rect });
    }, [selection]);

    const handleFormat = useCallback((mark: FormatMark) => {
      editorRef.current?.toggleMark(mark);
    }, []);

    const handleComposerSubmit = useCallback((body: string) => {
      const c = composer;
      if (!c) return;
      const thread: CommentThread = {
        id: newThreadId(),
        quote: c.quote,
        comments: [{ body, updatedAt: new Date().toISOString() }],
        anchor: { kind: 'text', prefix: c.anchor.prefix, suffix: c.anchor.suffix },
      };
      updateThreads([...threadsRef.current, thread]);
      fireMentions(body, thread.quote, { prefix: thread.anchor.prefix, suffix: thread.anchor.suffix }, thread.id);
      setComposer(null);
    }, [composer, updateThreads, fireMentions]);

    const handleReply = useCallback((body: string) => {
      const id = activeComment?.id;
      if (!id) return;
      const current = threadsRef.current;
      const thread = current.find(t => t.id === id);
      if (!thread) return;
      const next = current.map(t =>
        t.id === id ? { ...t, comments: [...t.comments, { body, updatedAt: new Date().toISOString() }] } : t,
      );
      updateThreads(next);
      fireMentions(body, thread.quote, { prefix: thread.anchor.prefix, suffix: thread.anchor.suffix }, thread.id);
    }, [activeComment, updateThreads, fireMentions]);

    const handleResolve = useCallback(() => {
      const id = activeComment?.id;
      if (!id) return;
      const next = threadsRef.current.map(t =>
        t.id === id ? { ...t, resolvedAt: t.resolvedAt ? undefined : new Date().toISOString() } : t,
      );
      updateThreads(next);
    }, [activeComment, updateThreads]);

    const handleDeleteThread = useCallback(() => {
      const id = activeComment?.id;
      if (!id) return;
      updateThreads(threadsRef.current.filter(t => t.id !== id));
      setActiveComment(null);
    }, [activeComment, updateThreads]);

    // ── Mention suggestions ────────────────────────────────
    const mentionCandidates: MentionCandidate[] = useMemo(() => {
      if (!mentionQuery) return [];
      return filterMentionCandidates(agentMentionCandidates, mentionQuery.query);
    }, [agentMentionCandidates, mentionQuery]);

    const mentionCandidatesRef = useRef(mentionCandidates);
    mentionCandidatesRef.current = mentionCandidates;
    const mentionIndexRef = useRef(mentionIndex);
    mentionIndexRef.current = mentionIndex;

    const closeMentionQuery = useCallback(() => {
      mentionQueryRef.current = null;
      setMentionQuery(null);
    }, []);

    const handleMentionQuery = useCallback((info: MentionQuery | null) => {
      mentionQueryRef.current = info;
      setMentionQuery(info);
      setMentionIndex(0);
    }, []);

    const applySelectedMention = useCallback((handle: string) => {
      const mq = mentionQueryRef.current;
      if (!mq) return;
      mentionQueryRef.current = null;
      setMentionQuery(null);
      const result = editorRef.current?.applyMention(handle, mq.from, mq.to);
      if (result && onInlineMention) {
        const key = `${handle}:${result.lineNumber}:${normalizeMentionLaunchText(result.lineMarkdown)}`;
        if (recentInlineMentions.current.has(key)) return;
        recentInlineMentions.current.add(key);
        setTimeout(() => recentInlineMentions.current.delete(key), 5000);
        onInlineMention(handle, result.lineMarkdown, result.lineNumber);
      }
    }, [onInlineMention]);

    // Intercept navigation keys while the mention popup is open (before the editor).
    useEffect(() => {
      if (!mentionQuery || linkEditing) return;
      const handler = (e: KeyboardEvent) => {
        const list = mentionCandidatesRef.current;
        if (list.length === 0) {
          if (e.key === 'Escape') closeMentionQuery();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionIndex(i => Math.min(i + 1, list.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const c = list[mentionIndexRef.current];
          if (c) applySelectedMention(c.handle);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMentionQuery();
        }
      };
      document.addEventListener('keydown', handler, true);
      return () => document.removeEventListener('keydown', handler, true);
    }, [mentionQuery, linkEditing, applySelectedMention, closeMentionQuery]);

    // File drag-and-drop handler
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
      };
      const handleDragLeave = () => setIsDragging(false);
      const handleDrop = async (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (!e.dataTransfer?.files.length) return;

        for (const file of Array.from(e.dataTransfer.files)) {
          try {
            const buffer = await file.arrayBuffer();
            const dataArray = Array.from(new Uint8Array(buffer));
            const result = await whimAPI.pasteFile(spaceId, file.name, dataArray);
            if (result.error) {
              onSaveStatus('✗ ' + result.error);
              setTimeout(() => onSaveStatus(''), 3000);
              continue;
            }
            const ref2 = formatAttachmentRef(result.filename!, result.relativePath!, file.type);
            insertAttachment(ref2);
          } catch {
            onSaveStatus('✗ drop failed');
            setTimeout(() => onSaveStatus(''), 3000);
          }
        }
      };

      el.addEventListener('dragover', handleDragOver);
      el.addEventListener('dragleave', handleDragLeave);
      el.addEventListener('drop', handleDrop);
      return () => {
        el.removeEventListener('dragover', handleDragOver);
        el.removeEventListener('dragleave', handleDragLeave);
        el.removeEventListener('drop', handleDrop);
      };
    }, [spaceId, onSaveStatus]); // eslint-disable-line react-hooks/exhaustive-deps

    function insertAttachment(markdownRef: string) {
      const current = getBody();
      const separator = current.endsWith('\n') ? '' : '\n';
      applyProgrammaticContent(current + separator + markdownRef);
    }

    const handleRecordingStart = useCallback(() => {
      const current = getBody();
      const separator = current.endsWith('\n') ? '\n' : '\n\n';
      applyProgrammaticContent(current + separator + VOICE_PLACEHOLDER + '\n');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleRecordingComplete = useCallback(async (result: VoiceRecordingResult) => {
      setIsTranscribing(true);
      onSaveStatus('🎤 Saving clip…');
      try {
        const timestamp = Date.now();
        const filename = `voice-${timestamp}.webm`;
        const buffer = await result.audioBlob.arrayBuffer();
        const dataArray = Array.from(new Uint8Array(buffer));
        const pasteResult = await whimAPI.pasteFile(spaceId, filename, dataArray);
        if (pasteResult.error) {
          onSaveStatus('✗ Failed to save audio');
          setTimeout(() => onSaveStatus(''), 3000);
          return;
        }
        const audioRef = `[🎵 ${pasteResult.filename}](${pasteResult.relativePath})`;
        let transcription = '';
        try {
          onSaveStatus('✨ Transcribing…');
          const text = await whimAPI.transcribe(Array.from(result.float32Data));
          transcription = text?.trim() || '';
        } catch (err) {
          console.error('[canvas-voice] Transcription failed:', err);
          transcription = '_Transcription failed_';
        }
        const block = transcription ? `${audioRef}\n\n${transcription}` : audioRef;
        const current = getBody();
        const bareIdx = current.indexOf(VOICE_PLACEHOLDER);
        if (bareIdx >= 0) {
          let lineStart = current.lastIndexOf('\n', bareIdx - 1);
          lineStart = lineStart < 0 ? 0 : lineStart + 1;
          let lineEnd = current.indexOf('\n', bareIdx + VOICE_PLACEHOLDER.length);
          if (lineEnd < 0) lineEnd = current.length;
          else lineEnd += 1;
          const before = current.slice(0, lineStart);
          const after = current.slice(lineEnd);
          const pre = before.length === 0 || before.endsWith('\n') ? '' : '\n';
          const post = after.length === 0 || after.startsWith('\n') ? '' : '\n';
          applyProgrammaticContent(before + pre + block + '\n' + post + after);
        } else {
          const separator = current.endsWith('\n') ? '\n' : '\n\n';
          applyProgrammaticContent(current + separator + block + '\n');
        }
        onSaveStatus('✓ Voice clip added');
        setTimeout(() => onSaveStatus(''), 2000);
      } catch (err: any) {
        console.error('[canvas-voice] Error:', err);
        const current = getBody();
        const bareIdx = current.indexOf(VOICE_PLACEHOLDER);
        if (bareIdx >= 0) {
          let lineStart = current.lastIndexOf('\n', bareIdx - 1);
          lineStart = lineStart < 0 ? 0 : lineStart;
          let lineEnd = current.indexOf('\n', bareIdx + VOICE_PLACEHOLDER.length);
          if (lineEnd < 0) lineEnd = current.length;
          else lineEnd += 1;
          applyProgrammaticContent(current.slice(0, lineStart) + current.slice(lineEnd));
        }
        onSaveStatus('✗ Voice recording failed');
        setTimeout(() => onSaveStatus(''), 3000);
      } finally {
        setIsTranscribing(false);
      }
    }, [spaceId, onSaveStatus]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleVoiceError = useCallback((message: string) => {
      onSaveStatus(`✗ ${message}`);
      setTimeout(() => onSaveStatus(''), 3000);
    }, [onSaveStatus]);

    // Cleanup pending save on unmount
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        mergeControllerRef.current?.abort();
        if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current);
      };
    }, []);

    // Auto-focus the editor after mount
    useEffect(() => {
      if (editorMode !== 'rendered') return;
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => editorRef.current?.focus());
      });
      return () => cancelAnimationFrame(raf);
    }, [editorMode]);

    const activeThread = activeComment ? threads.find(t => t.id === activeComment.id) ?? null : null;
    const activeThreadStatus = activeThread
      ? agentThreadStatuses.find(s => s.threadId === activeThread.id) ?? null
      : null;
    const activeThreadInteractions = activeThread
      ? agentInteractions.filter(i => i.agentId === activeThreadStatus?.agentId)
      : [];

    return (
      <div
        ref={containerRef}
        className={`markdown-canvas-container${isDragging ? ' drag-over' : ''} md-theme-${theme}`}
      >
        {parseError && (
          <div className="frontmatter-parse-error">{parseError}</div>
        )}
        {editorMode === 'rendered' ? (
          <>
            {showFrontmatterEditor && (
              <FrontmatterEditor
                frontmatter={frontmatter}
                personas={personas}
                onChange={handleFrontmatterChange}
              />
            )}
            <div className="markdown-editor-wrap">
              <MilkdownEditor
                onDocumentChanged={onEditorDocumentChanged}
                ref={editorRef}
                initialContent={content}
                theme={theme}
                onContentChanged={onEditorContentChanged}
                decorations={decorations}
                presence={presence}
                commentAgentStatuses={agentThreadStatuses}
                commentThreads={threads}
                activeCommentId={activeComment?.id ?? null}
                commentTrigger={commentTrigger}
                resolveImageSrc={resolveImageSrc}
                uploadFile={uploadFile}
                onCommentActivate={handleCommentActivate}
                onSelectionChange={handleSelectionChange}
                onMentionQuery={handleMentionQuery}
                onLinkClick={handleLinkClick}
                onLinkEditingChange={setLinkEditing}
              />
              {isTranscribing && (
                <div className="canvas-voice-transcribing-bar">
                  <span className="canvas-voice-transcribing-spinner" />
                  <span>Transcribing…</span>
                </div>
              )}
              <VoiceRecorderButton
                theme={theme}
                onRecordingComplete={handleRecordingComplete}
                onRecordingStart={handleRecordingStart}
                onError={handleVoiceError}
                disabled={isTranscribing}
              />
            </div>
            {selection && !composer && !linkEditing && (
              <SelectionToolbar
                rect={selection.rect}
                onFormat={handleFormat}
                onLink={() => editorRef.current?.openLinkEditor()}
                onComment={handleStartComment}
                onFork={onForkSelection ? () => { onForkSelection(selection.text); setSelection(null); } : undefined}
                onExtract={onExtractToPage ? () => { onExtractToPage(selection.text); setSelection(null); } : undefined}
              />
            )}
            {composer && !linkEditing && (
              <CommentComposer
                rect={composer.rect}
                quote={composer.quote}
                mentionCandidates={agentMentionCandidates}
                onSubmit={handleComposerSubmit}
                onCancel={() => setComposer(null)}
              />
            )}
            {activeThread && activeComment && !linkEditing && (
              <CommentPopover
                thread={activeThread}
                rect={activeComment.rect}
                mentionCandidates={agentMentionCandidates}
                agentStatus={activeThreadStatus}
                agentInteractions={activeThreadInteractions}
                onApprovalRespond={(requestId, approved) => {
                  const agentId = activeThreadStatus?.agentId;
                  if (agentId) void whimAPI.approveAgent(agentId, requestId, approved);
                }}
                onUserInputRespond={(requestId, answer, wasFreeform) => {
                  const agentId = activeThreadStatus?.agentId;
                  if (agentId) void whimAPI.respondToUserInput(agentId, requestId, answer, wasFreeform);
                }}
                onElicitationRespond={(requestId, action, content) => {
                  const agentId = activeThreadStatus?.agentId;
                  if (agentId) void whimAPI.respondToElicitation(agentId, requestId, action, content);
                }}
                onSandboxResolve={(agentId, requestId, decision) => {
                  void whimAPI.resolveSandboxBlock(agentId, requestId, decision);
                }}
                onReply={handleReply}
                onResolve={handleResolve}
                onDelete={handleDeleteThread}
                onClose={() => setActiveComment(null)}
              />
            )}
            {mentionQuery && mentionCandidates.length > 0 && !linkEditing && (
              <MentionPopup
                rect={mentionQuery.rect}
                candidates={mentionCandidates}
                activeIndex={mentionIndex}
                onSelect={applySelectedMention}
                onHover={setMentionIndex}
              />
            )}
          </>
        ) : (
          <textarea
            ref={rawTextareaRef}
            className="canvas-raw-editor"
            value={rawContent}
            onChange={handleRawContentChange}
            spellCheck={false}
          />
        )}
        {showLinkPicker && (
          <SpaceLinkPicker
            onSelect={handleLinkPickerSelect}
            onDismiss={() => setShowLinkPicker(false)}
          />
        )}
      </div>
    );
  }
);

// Inline mention support lives in the mention plugin (p4); these are re-exported
// for the host event types.
export type { CommentThread };
