import { closeHistory } from '@milkdown/kit/prose/history';
import type { Mark, Slice } from '@milkdown/kit/prose/model';
import { AllSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { canLink } from './formatting';

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'whim:', 'file:']);
// eslint-disable-next-line no-control-regex -- Browser-ignored characters must not conceal a URL scheme.
const IGNORED_CHARACTERS = /[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/g;

/** Normalize web addresses, while retaining explicitly entered workspace paths. */
export function normalizeLinkUrl(input: string): string | null {
  let value = input.trim();
  if (!value || /[\r\n]/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value.replace(IGNORED_CHARACTERS, ''))?.[0].toLowerCase();
  if (scheme && !SUPPORTED_SCHEMES.has(scheme)) return null;
  if (scheme && !value.toLowerCase().startsWith(scheme)) return null;
  if (value.startsWith('//')) value = `https:${value}`;
  else if (/^www\./i.test(value) || (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value) && !/^[^/]+\.(?:md|mdx|txt|pdf)(?:[?#].*)?$/i.test(value))) {
    value = `https://${value}`;
  }
  if (scheme) value = scheme + value.slice(scheme.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      if (!SUPPORTED_SCHEMES.has(url.protocol)) return null;
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null;
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !/^https?:\/\//.test(value)) value = url.href;
      if (url.protocol === 'mailto:' && !url.pathname) return null;
      if (url.protocol === 'whim:' && !url.hostname) return null;
    } catch {
      return null;
    }
  }
  return value;
}

export interface LinkTarget {
  from: number;
  to: number;
  text: string;
  href: string;
  title: string | null;
  hasLink: boolean;
  canEditText: boolean;
}

function linkRange(state: EditorState, start: number, end: number): { from: number; to: number; mark: Mark } | null {
  const $from = state.doc.resolve(start);
  const $to = state.doc.resolve(end);
  const empty = start === end;
  if (!$from.sameParent($to)) return null;
  const parent = $from.parent;
  let child = parent.childAfter($from.parentOffset);
  let mark = child.node?.marks.find(mark => mark.type === state.schema.marks.link);
  if (!mark && empty) {
    child = parent.childBefore($from.parentOffset);
    mark = child.node?.marks.find(mark => mark.type === state.schema.marks.link);
  }
  if (!mark || !child.node) return null;
  let from = $from.start() + child.offset;
  let to = from + child.node.nodeSize;
  for (let i = child.index - 1; i >= 0 && mark.isInSet(parent.child(i).marks); i--) from -= parent.child(i).nodeSize;
  for (let i = child.index + 1; i < parent.childCount && mark.isInSet(parent.child(i).marks); i++) to += parent.child(i).nodeSize;
  return $from.pos >= from && $to.pos <= to ? { from, to, mark } : null;
}

export function getLinkTarget(state: EditorState): LinkTarget | null {
  if (!canLink(state)) return null;
  let { from, to } = state.selection;
  if (state.selection instanceof AllSelection) {
    let first = true;
    state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      if (first) { from = pos; first = false; }
      to = pos + node.nodeSize;
    });
  }
  const link = linkRange(state, from, to);
  if (link) ({ from, to } = link);
  let textOnly = true;
  state.doc.nodesBetween(from, to, node => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  return {
    from,
    to,
    text: state.doc.textBetween(from, to, '\n'),
    href: link?.mark.attrs.href ?? '',
    title: link?.mark.attrs.title ?? null,
    hasLink: !!link || state.doc.rangeHasMark(from, to, state.schema.marks.link),
    canEditText: textOnly && state.doc.resolve(from).sameParent(state.doc.resolve(to)),
  };
}

interface PendingLink {
  target: LinkTarget;
  content: Slice;
  valid: boolean;
}

export const linkEditingKey = new PluginKey<PendingLink | null>('whim-link-editing');

/** Map the saved range through agent edits instead of linking a stale position. */
export const linkEditingPlugin = new Plugin<PendingLink | null>({
  key: linkEditingKey,
  state: {
    init: () => null,
    apply(tr, pending) {
      const next = tr.getMeta(linkEditingKey) as LinkTarget | null | undefined;
      if (next !== undefined) {
        return next ? { target: next, content: tr.doc.slice(next.from, next.to), valid: true } : null;
      }
      if (!pending || !tr.docChanged || !pending.valid) return pending;
      const empty = pending.target.from === pending.target.to;
      const mappedFrom = tr.mapping.map(pending.target.from, 1);
      const from = empty ? TextSelection.near(tr.doc.resolve(mappedFrom)).from : mappedFrom;
      const to = empty ? from : tr.mapping.map(pending.target.to, -1);
      const valid = from <= to && tr.doc.slice(from, to).eq(pending.content);
      return { ...pending, target: { ...pending.target, from, to }, valid };
    },
  },
});

export function applyLink(view: EditorView, href: string | null, text: string): string | null {
  const pending = linkEditingKey.getState(view.state);
  if (!pending?.valid) return 'The selected text changed. Close this dialog and select it again.';
  const url = href === null ? null : normalizeLinkUrl(href);
  if (href !== null && !url) return 'Enter a valid web address, email link, or workspace path.';
  const { target } = pending;
  const { from } = target;
  let { to } = target;
  const { state } = view;
  const type = state.schema.marks.link;
  const tr = state.tr;
  if (url && target.canEditText && (from === to || text !== target.text)) {
    const label = text.trim() ? text : url;
    const inherited = from === to
      ? state.storedMarks ?? state.doc.resolve(from).marks()
      : state.doc.nodeAt(from)?.marks ?? state.doc.resolve(from).marks();
    const marks = inherited.filter(mark => mark.type !== type);
    tr.replaceWith(from, to, state.schema.text(label, marks));
    to = from + label.length;
  }
  tr.removeMark(from, to, type);
  if (url) tr.addMark(from, to, type.create({ href: url, title: target.title }));
  tr.setSelection(TextSelection.near(tr.doc.resolve(to)));
  tr.removeStoredMark(type).setMeta(linkEditingKey, null);
  view.dispatch(closeHistory(tr).scrollIntoView());
  view.focus();
  return null;
}

export function pasteLink(view: EditorView, event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard || clipboard.files.length || clipboard.getData('vscode-editor-data')) return false;
  const text = clipboard.getData('text/plain').trim();
  if (!/^(?:https?:\/\/|www\.|mailto:|whim:\/\/)/i.test(text) || /\s/.test(text)) return false;
  const href = normalizeLinkUrl(text);
  if (!href || !canLink(view.state)) return false;
  const { state } = view;
  const { from, to, empty, $from } = state.selection;
  const type = state.schema.marks.link;
  const mark = type.create({ href });
  const tr = state.tr;
  if (empty) {
    const marks = (state.storedMarks ?? $from.marks()).filter(mark => mark.type !== type);
    tr.replaceSelectionWith(state.schema.text(text, [...marks, mark]), false);
  } else {
    tr.addMark(from, to, mark).setSelection(TextSelection.near(tr.doc.resolve(to)));
  }
  tr.removeStoredMark(type).setMeta('paste', true).setMeta('uiEvent', 'paste');
  view.dispatch(closeHistory(tr).scrollIntoView());
  event.preventDefault();
  return true;
}
