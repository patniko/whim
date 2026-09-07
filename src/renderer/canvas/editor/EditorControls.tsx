import React, { forwardRef, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Strikethrough, Code, Link, List, ListOrdered, ListTodo, Quote, IndentIncrease, IndentDecrease, Undo2, Redo2 } from 'lucide-react';
import { formatAccelerator } from '../../lib/hotkeys';
import { TEXT_STYLES, type FormatAction, type FormattingState, type TextStyle } from './formatting';
import { normalizeLinkUrl, type LinkTarget } from './links';

interface ToolbarAction {
  action: FormatAction | 'link';
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
}

const GROUPS: { label: string; actions: ToolbarAction[] }[] = [
  {
    label: 'Inline formatting',
    actions: [
      { action: 'strong', label: 'Bold', shortcut: 'CommandOrControl+B', icon: <Bold size={16} /> },
      { action: 'emphasis', label: 'Italic', shortcut: 'CommandOrControl+I', icon: <Italic size={16} /> },
      { action: 'strikethrough', label: 'Strikethrough', shortcut: 'CommandOrControl+Shift+X', icon: <Strikethrough size={16} /> },
      { action: 'inlineCode', label: 'Inline code', shortcut: 'CommandOrControl+E', icon: <Code size={16} /> },
      { action: 'link', label: 'Insert or edit link', shortcut: 'CommandOrControl+K', icon: <Link size={16} /> },
    ],
  },
  {
    label: 'Lists and quotes',
    actions: [
      { action: 'bulletList', label: 'Bulleted list', shortcut: 'CommandOrControl+Alt+8', icon: <List size={16} /> },
      { action: 'orderedList', label: 'Numbered list', shortcut: 'CommandOrControl+Alt+7', icon: <ListOrdered size={16} /> },
      { action: 'taskList', label: 'Checklist', shortcut: 'CommandOrControl+Alt+9', icon: <ListTodo size={16} /> },
      { action: 'blockquote', label: 'Block quote', icon: <Quote size={16} /> },
    ],
  },
  {
    label: 'List indentation',
    actions: [
      { action: 'outdent', label: 'Outdent list item', shortcut: 'CommandOrControl+[', icon: <IndentDecrease size={16} /> },
      { action: 'indent', label: 'Indent list item', shortcut: 'CommandOrControl+]', icon: <IndentIncrease size={16} /> },
    ],
  },
  {
    label: 'History',
    actions: [
      { action: 'undo', label: 'Undo', shortcut: 'CommandOrControl+Z', icon: <Undo2 size={16} /> },
      { action: 'redo', label: 'Redo', shortcut: 'CommandOrControl+Shift+Z', icon: <Redo2 size={16} /> },
    ],
  },
];

export const EditorToolbar = forwardRef<HTMLDivElement, {
  state: FormattingState | null;
  onAction: (action: FormatAction) => void;
  onTextStyle: (style: TextStyle) => void;
  onLink: () => void;
  onReturnToEditor: () => void;
}>(function EditorToolbar({ state, onAction, onTextStyle, onLink, onReturnToEditor }, ref) {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return (
    <div
      ref={ref}
      className="md-editor-toolbar"
      role="toolbar"
      aria-label="Text formatting"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onReturnToEditor();
          return;
        }
        if (event.target instanceof HTMLSelectElement) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button:not(:disabled), select:not(:disabled)'));
        const current = controls.findIndex(control => control === document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}
    >
      <select
        aria-label="Text style"
        title="Text style"
        value={state?.textStyle ?? ''}
        disabled={!state}
        onChange={event => {
          const style = TEXT_STYLES.find(style => style.value === event.target.value);
          if (style) onTextStyle(style.value);
        }}
      >
        <option value="" disabled>Mixed styles</option>
        {TEXT_STYLES.map(style => <option key={style.value} value={style.value} disabled={!state?.styles[style.value]}>{style.label}</option>)}
      </select>
      {GROUPS.map(group => (
        <div key={group.label} className="md-editor-toolbar-group" role="group" aria-label={group.label}>
          {group.actions.map(({ action, label, shortcut, icon }) => (
            <button
              key={action}
              type="button"
              aria-label={label}
              aria-pressed={action === 'link' ? state?.linkActive : state?.active[action]}
              title={shortcut ? `${label} (${formatAccelerator(shortcut, platform)})` : label}
              disabled={action === 'link' ? !state?.linkEnabled : !state?.enabled[action]}
              onMouseDown={event => event.preventDefault()}
              onClick={() => action === 'link' ? onLink() : onAction(action)}
            >
              {icon}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
});

export function LinkEditor({
  target,
  theme,
  onApply,
  onCancel,
  onOpen,
}: {
  target: LinkTarget;
  theme: 'light' | 'dark';
  onApply: (href: string | null, text: string) => string | null;
  onCancel: () => void;
  onOpen?: (href: string) => void;
}) {
  const [href, setHref] = useState(target.href);
  const [text, setText] = useState(target.text);
  const [error, setError] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  }, []);

  const apply = (url: string | null) => setError(onApply(url, text));
  return createPortal(
    <div className={`md-link-backdrop md-theme-${theme}`} onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <form
        className="md-link-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={event => { event.preventDefault(); apply(href); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input:not(:disabled), button:not(:disabled)'));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={`${id}-title`}>{target.hasLink ? 'Edit link' : 'Insert link'}</h2>
        <label htmlFor={`${id}-text`}>Text</label>
        <input
          id={`${id}-text`}
          value={text}
          disabled={!target.canEditText}
          placeholder="Use the address as the link text"
          onChange={event => setText(event.target.value)}
        />
        <label htmlFor={`${id}-href`}>Link address</label>
        <input
          ref={addressRef}
          id={`${id}-href`}
          value={href}
          placeholder="https://example.com or a workspace path"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => { setHref(event.target.value); setError(null); }}
        />
        {error && <p id={`${id}-error`} className="md-link-error" role="alert">{error}</p>}
        <div className="md-link-actions">
          {target.hasLink && <button type="button" onClick={() => apply(null)}>Remove link</button>}
          {target.hasLink && onOpen && <button type="button" disabled={!normalizeLinkUrl(href)} onClick={() => {
            const url = normalizeLinkUrl(href);
            if (url) onOpen(url);
          }}>Open link</button>}
          <span />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="md-link-apply" disabled={!href.trim()}>Apply</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
