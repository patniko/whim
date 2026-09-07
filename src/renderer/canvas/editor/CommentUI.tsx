import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Strikethrough, Code, Link, MessageSquarePlus, GitFork, FileOutput, Check, Trash2, CornerDownLeft } from 'lucide-react';
import type { CanvasAgentInteraction, CanvasThreadAgentStatus, CommentThread } from '../types';
import type { Rect, FormatMark } from './geometry';
import { useAnchoredPosition } from './floating';
import { eventMatchesAccelerator, formatAccelerator } from '../../lib/hotkeys';
import { MentionPopup } from './MentionUI';
import { detectMentionBeforeCaret, filterMentionCandidates, type MentionCandidate, type TextMentionQuery } from './mentions';
import { ApprovalTile } from '../../chat/tiles/ApprovalTile';
import { UserInputTile } from '../../chat/tiles/UserInputTile';
import { ElicitationTile } from '../../chat/tiles/ElicitationTile';
import { SandboxBlockTile } from '../../chat/tiles/SandboxBlockTile';

/** Render floating UI on document.body so it escapes the app's backdrop-filter
 *  containing block (which otherwise breaks position: fixed coordinates). */
function Floating({ children }: { children: React.ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.body);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

const CARET_STYLE_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'textRendering',
  'wordSpacing',
] as const;

type TextareaMentionQuery = TextMentionQuery & { rect: Rect };

function rectFromTextarea(textarea: HTMLTextAreaElement): Rect {
  const rect = textarea.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function textareaCaretRect(textarea: HTMLTextAreaElement, caret: number): Rect | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.minHeight = '0';
  for (const prop of CARET_STYLE_PROPS) {
    mirror.style[prop] = style[prop];
  }

  const before = textarea.value.slice(0, caret);
  mirror.textContent = before.endsWith('\n') ? `${before} ` : before;
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  try {
    const textareaRect = textarea.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16;
    const left = textareaRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;
    const top = textareaRect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;
    return {
      left,
      top,
      right: left,
      bottom: top + lineHeight,
      width: 0,
      height: lineHeight,
    };
  } finally {
    mirror.remove();
  }
}

function CommentMentionTextarea({
  value,
  mentionCandidates,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  value: string;
  mentionCandidates: readonly MentionCandidate[];
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<TextareaMentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!autoFocus) return;
    // The popover is rendered `visibility: hidden` until its anchored position
    // has been measured, and focusing a hidden element is a silent no-op — the
    // caret stayed in the document and the first thing typed went into the
    // canvas instead of the comment. Retry across a few frames so the focus
    // lands as soon as the popover is actually visible.
    let frame = 0;
    let attempts = 0;
    const attempt = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && attempts++ < 10) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const refreshMention = useCallback((textarea: HTMLTextAreaElement, nextValue = value) => {
    const caret = textarea.selectionStart ?? nextValue.length;
    const query = detectMentionBeforeCaret(nextValue, caret);
    if (!query) {
      setMentionQuery(null);
      setActiveIndex(0);
      return;
    }
    setMentionQuery({
      ...query,
      rect: textareaCaretRect(textarea, query.from) ?? rectFromTextarea(textarea),
    });
    setActiveIndex(0);
  }, [value]);

  const candidates = useMemo(
    () => mentionQuery ? filterMentionCandidates(mentionCandidates, mentionQuery.query) : [],
    [mentionCandidates, mentionQuery],
  );
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    if (activeIndex >= candidates.length) {
      setActiveIndex(Math.max(0, candidates.length - 1));
    }
  }, [activeIndex, candidates.length]);

  const applyMention = useCallback((handle: string) => {
    const textarea = textareaRef.current;
    const query = mentionQuery;
    if (!textarea || !query) return;
    const inserted = `@${handle} `;
    const nextValue = value.slice(0, query.from) + inserted + value.slice(query.to);
    const nextCaret = query.from + inserted.length;
    onChange(nextValue);
    setMentionQuery(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }, [mentionQuery, onChange, value]);

  return (
    <>
      <textarea
        ref={textareaRef}
        className="md-comment-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refreshMention(e.currentTarget, e.target.value);
        }}
        onClick={(e) => refreshMention(e.currentTarget)}
        onSelect={(e) => refreshMention(e.currentTarget)}
        onKeyUp={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') return;
          refreshMention(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (mentionQuery) {
            const list = candidatesRef.current;
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setMentionQuery(null);
              return;
            }
            if (list.length > 0 && e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              setActiveIndex(i => Math.min(i + 1, list.length - 1));
              return;
            }
            if (list.length > 0 && e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              setActiveIndex(i => Math.max(i - 1, 0));
              return;
            }
            if (list.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              e.stopPropagation();
              const candidate = list[activeIndexRef.current];
              if (candidate) applyMention(candidate.handle);
              return;
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      {mentionQuery && candidates.length > 0 && (
        <MentionPopup
          rect={mentionQuery.rect}
          candidates={candidates}
          activeIndex={activeIndex}
          onSelect={applyMention}
          onHover={setActiveIndex}
        />
      )}
    </>
  );
}

interface SelectionAction {
  id: string;
  label: string;
  accelerator: string;
  icon: React.ReactNode;
  /** Present when the button shows a text label next to its icon. */
  text?: string;
  run: () => void;
}

/**
 * Formatting actions belong to the editor's own keymap. They are listed here so
 * the tooltip can show the shortcut, but the toolbar must not claim them —
 * intercepting them would take the action away from ProseMirror and out of its
 * undo history.
 */
const EDITOR_OWNED_ACTIONS = new Set(['strong', 'emphasis', 'strikethrough', 'inlineCode', 'link']);

/** Floating toolbar shown over a text selection. */
export function SelectionToolbar({
  rect,
  onFormat,
  onLink,
  onComment,
  onFork,
  onExtract,
}: {
  rect: Rect;
  onFormat: (mark: FormatMark) => void;
  onLink?: () => void;
  onComment: () => void;
  onFork?: () => void;
  onExtract?: () => void;
}) {
  const { ref, style } = useAnchoredPosition(rect, { placement: 'above', align: 'center' });
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;

  const items = useMemo<SelectionAction[]>(() => ([
    { id: 'strong', label: 'Bold', accelerator: 'CommandOrControl+B', icon: <Bold size={14} />, run: () => onFormat('strong') },
    { id: 'emphasis', label: 'Italic', accelerator: 'CommandOrControl+I', icon: <Italic size={14} />, run: () => onFormat('emphasis') },
    { id: 'strikethrough', label: 'Strikethrough', accelerator: 'CommandOrControl+Shift+X', icon: <Strikethrough size={14} />, run: () => onFormat('strikethrough') },
    { id: 'inlineCode', label: 'Inline code', accelerator: 'CommandOrControl+E', icon: <Code size={14} />, run: () => onFormat('inlineCode') },
    ...(onLink ? [{ id: 'link', label: 'Insert or edit link', accelerator: 'CommandOrControl+K', icon: <Link size={14} />, run: onLink }] : []),
    { id: 'comment', label: 'Comment', accelerator: 'CommandOrControl+Shift+M', icon: <MessageSquarePlus size={14} />, text: 'Comment', run: onComment },
    ...(onFork ? [{ id: 'fork', label: 'Fork to new space', accelerator: 'CommandOrControl+Shift+F', icon: <GitFork size={14} />, run: onFork }] : []),
    ...(onExtract ? [{ id: 'extract', label: 'Extract to page', accelerator: 'CommandOrControl+Shift+O', icon: <FileOutput size={14} />, run: onExtract }] : []),
  ]), [onFormat, onLink, onComment, onFork, onExtract]);

  // The toolbar only exists while there is a selection, so binding the
  // accelerators to its lifetime is what scopes them: no selection, no
  // shortcut, and nothing to unregister by hand.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const item of items) {
        if (EDITOR_OWNED_ACTIONS.has(item.id)) continue;
        if (!eventMatchesAccelerator(e, item.accelerator, platform)) continue;
        e.preventDefault();
        e.stopPropagation();
        item.run();
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [items, platform]);

  // Roving focus: once a button has focus the arrows walk the toolbar, so it
  // can also be driven without memorising the accelerators.
  const handleArrowKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length].focus();
  };

  return (
    <Floating>
      <div
        ref={ref}
        className="md-selection-toolbar"
        style={style}
        role="toolbar"
        aria-label="Selection actions"
        onKeyDown={handleArrowKeys}
        onMouseDown={(e) => e.preventDefault()}
      >
        {items.map(item => (
          <React.Fragment key={item.id}>
            {item.id === 'comment' && <span className="md-selection-sep" />}
            <button
              className={`md-selection-btn${item.text ? '' : ' md-selection-icon'}`}
              title={`${item.label} (${formatAccelerator(item.accelerator, platform)})`}
              aria-label={item.label}
              onClick={item.run}
            >
              {item.icon}
              {item.text && <span>{item.text}</span>}
            </button>
          </React.Fragment>
        ))}
      </div>
    </Floating>
  );
}

/** Composer for the first comment on a freshly selected range. */
export function CommentComposer({
  rect,
  quote,
  mentionCandidates,
  onSubmit,
  onCancel,
}: {
  rect: Rect;
  quote: string;
  mentionCandidates: readonly MentionCandidate[];
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const { ref, style } = useAnchoredPosition(rect, { placement: 'below', align: 'start', gap: 6 });

  const submit = () => {
    const t = body.trim();
    if (t) onSubmit(t);
  };

  return (
    <Floating>
      <div ref={ref} className="md-comment-popover" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="md-comment-quote">{quote.length > 120 ? quote.slice(0, 120) + '…' : quote}</div>
        <CommentMentionTextarea
          value={body}
          mentionCandidates={mentionCandidates}
          placeholder="Add a comment…  (@mention an agent to deploy it)"
          onChange={setBody}
          onSubmit={submit}
          onCancel={onCancel}
          autoFocus
        />
        <div className="md-comment-actions">
          <button className="md-comment-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="md-comment-btn-primary" onClick={submit} disabled={!body.trim()}>
            <CornerDownLeft size={12} /> Comment
          </button>
        </div>
      </div>
    </Floating>
  );
}

/** Thread popover: existing comments + reply box + resolve/delete. */
export function CommentPopover({
  thread,
  rect,
  mentionCandidates,
  agentStatus,
  agentInteractions,
  onApprovalRespond,
  onUserInputRespond,
  onElicitationRespond,
  onSandboxResolve,
  onReply,
  onResolve,
  onDelete,
  onClose,
}: {
  thread: CommentThread;
  rect: Rect;
  mentionCandidates: readonly MentionCandidate[];
  agentStatus?: CanvasThreadAgentStatus | null;
  agentInteractions?: readonly CanvasAgentInteraction[];
  onApprovalRespond?: (requestId: string, approved: boolean) => void;
  onUserInputRespond?: (requestId: string, answer: string, wasFreeform: boolean) => void;
  onElicitationRespond?: (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
  onSandboxResolve?: (
    agentId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-for-session' | 'disable',
  ) => void;
  onReply: (body: string) => void;
  onResolve: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const { ref, style } = useAnchoredPosition(rect, { placement: 'below', align: 'start', gap: 6 });
  const interactions = agentInteractions ?? [];

  const submit = () => {
    const t = body.trim();
    if (t) { onReply(t); setBody(''); }
  };

  return (
    <Floating>
      <div ref={ref} className="md-comment-popover" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="md-comment-header">
          <span className="md-comment-quote-inline">“{thread.quote.length > 80 ? thread.quote.slice(0, 80) + '…' : thread.quote}”</span>
          <div className="md-comment-header-actions">
            <button className="md-comment-icon" title={thread.resolvedAt ? 'Resolved' : 'Resolve'} onClick={onResolve}>
              <Check size={13} />
            </button>
            <button className="md-comment-icon" title="Delete thread" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <div className="md-comment-list">
          {thread.comments.map((c, i) => (
            <div className="md-comment-item" key={i}>
              <div className="md-comment-body">{c.body}</div>
              <div className="md-comment-meta">{formatTime(c.updatedAt)}</div>
            </div>
          ))}
        </div>
        {agentStatus && (
          <div className={`md-comment-agent-status md-comment-agent-status-${agentStatus.status}`}>
            <span className="md-comment-agent-dot" />
            <span>{agentStatus.label}</span>
          </div>
        )}
        {interactions.length > 0 && (
          <div className="md-comment-agent-interactions">
            {interactions.map((interaction) => {
              if (interaction.kind === 'approval') {
                return (
                  <ApprovalTile
                    key={`${interaction.kind}:${interaction.requestId}`}
                    requestId={interaction.requestId}
                    permissionKind={interaction.permissionKind}
                    intention={interaction.intention}
                    path={interaction.path}
                    responded={!!interaction.responded}
                    approved={interaction.approved}
                    onRespond={(requestId, approved) => onApprovalRespond?.(requestId, approved)}
                  />
                );
              }
              if (interaction.kind === 'user_input') {
                return (
                  <UserInputTile
                    key={`${interaction.kind}:${interaction.requestId}`}
                    requestId={interaction.requestId}
                    question={interaction.question}
                    choices={interaction.choices}
                    allowFreeform={interaction.allowFreeform}
                    responded={!!interaction.responded}
                    answer={interaction.answer}
                    wasFreeform={interaction.wasFreeform}
                    onRespond={(requestId, answer, wasFreeform) => onUserInputRespond?.(requestId, answer, wasFreeform)}
                  />
                );
              }
              if (interaction.kind === 'elicitation') {
                return (
                  <ElicitationTile
                    key={`${interaction.kind}:${interaction.requestId}`}
                    requestId={interaction.requestId}
                    message={interaction.message}
                    requestedSchema={interaction.requestedSchema}
                    mode={interaction.mode}
                    elicitationSource={interaction.elicitationSource}
                    responded={!!interaction.responded}
                    action={interaction.action}
                    content={interaction.content}
                    onRespond={(requestId, action, content) => onElicitationRespond?.(requestId, action, content)}
                  />
                );
              }
              return (
                <SandboxBlockTile
                  key={`${interaction.kind}:${interaction.requestId}`}
                  requestId={interaction.requestId}
                  agentId={interaction.agentId}
                  source={interaction.source}
                  kind={interaction.blockKind}
                  toolName={interaction.toolName}
                  target={interaction.target}
                  intention={interaction.intention}
                  allowedDecisions={interaction.allowedDecisions}
                  layer={interaction.layer}
                  personaHandle={interaction.personaHandle}
                  responded={!!interaction.responded}
                  decision={interaction.decision}
                  onResolve={(agentId, requestId, decision) => onSandboxResolve?.(agentId, requestId, decision)}
                />
              );
            })}
          </div>
        )}
        <CommentMentionTextarea
          value={body}
          mentionCandidates={mentionCandidates}
          placeholder="Reply…  (@mention to deploy an agent)"
          onChange={setBody}
          onSubmit={submit}
          onCancel={onClose}
        />
        <div className="md-comment-actions">
          <button className="md-comment-btn-ghost" onClick={onClose}>Close</button>
          <button className="md-comment-btn-primary" onClick={submit} disabled={!body.trim()}>
            <CornerDownLeft size={12} /> Reply
          </button>
        </div>
      </div>
    </Floating>
  );
}
