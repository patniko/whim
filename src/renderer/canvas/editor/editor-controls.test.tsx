// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { AllSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose, getMarkdown } from '@milkdown/kit/utils';
import { EditorToolbar, LinkEditor } from './EditorControls';
import { formatCommand, getFormattingState, setTextStyle, splitTaskItem, type FormatAction } from './formatting';
import { applyLink, getLinkTarget, linkEditingKey, linkEditingPlugin, normalizeLinkUrl, pasteLink } from './links';
import { createListItemNodeView } from './plugins/list-item-view';
import { MilkdownEditor, type MilkdownEditorHandle, type MilkdownEditorProps } from './MilkdownEditor';

const editors: Editor[] = [];
let reactRoot: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = null;
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function makeEditor(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await Editor.make()
    .config(ctx => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, prev => ({
        ...prev,
        nodeViews: { list_item: createListItemNodeView },
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use($prose(() => linkEditingPlugin))
    .create();
  editors.push(editor);
  return { editor, view: editor.ctx.get(editorViewCtx) };
}

function selectText(view: EditorView, text: string, collapsed = false) {
  let from: number | null = null;
  view.state.doc.descendants((node, pos) => {
    if (from !== null || !node.isText) return;
    const index = node.text!.indexOf(text);
    if (index >= 0) from = pos + index;
  });
  if (from === null) throw new Error(`Text not found: ${text}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, collapsed ? from : from + text.length)));
}

function selectAllText(view: EditorView) {
  let from: number | undefined;
  let to = 0;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    from ??= pos;
    to = pos + node.nodeSize;
  });
  if (from === undefined) throw new Error('No text to select');
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function run(view: EditorView, action: FormatAction) {
  expect(formatCommand(action)(view.state, view.dispatch, view)).toBe(true);
}

function beginLink(view: EditorView) {
  const target = getLinkTarget(view.state);
  expect(target).not.toBeNull();
  view.dispatch(view.state.tr.setMeta(linkEditingKey, target));
  return target!;
}

function pasteEvent(text: string, html = ''): ClipboardEvent {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (html) data.setData('text/html', html);
  return new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
}

describe('editor formatting commands', () => {
  it.each(['bulletList', 'orderedList', 'taskList'] as const)('handles Select All when creating and removing a %s', async action => {
    const { view } = await makeEditor('One\n\nTwo');
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    run(view, action);
    expect(view.state.doc.firstChild!.childCount).toBe(2);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(getFormattingState(view.state).active[action]).toBe(true);
    run(view, action);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(view.state.doc.lastChild!.type.name).toBe('paragraph');
  });

  it.each(['bulletList', 'orderedList', 'taskList'] as const)('wraps selected paragraphs as separate %s items and undoes in one step', async action => {
    const { view } = await makeEditor('One\n\nTwo');
    selectAllText(view);
    const original = view.state.doc;

    run(view, action);

    const list = view.state.doc.firstChild!;
    expect(list.type.name).toBe(action === 'orderedList' ? 'ordered_list' : 'bullet_list');
    expect(list.childCount).toBe(2);
    expect(list.child(0).textContent).toBe('One');
    expect(list.child(1).textContent).toBe('Two');
    expect(list.child(0).attrs.checked).toBe(action === 'taskList' ? false : null);
    expect(getFormattingState(view.state).active[action]).toBe(true);
    run(view, 'undo');
    expect(view.state.doc.eq(original)).toBe(true);
    run(view, 'redo');
    expect(view.state.doc.firstChild!.childCount).toBe(2);
  });

  it('converts list types without nesting or losing formatted content', async () => {
    const { editor, view } = await makeEditor('- **One**\n- Two');
    selectText(view, 'One', true);
    run(view, 'taskList');
    expect(view.state.doc.firstChild!.child(1).attrs.checked).toBe(false);
    run(view, 'orderedList');
    expect(view.state.doc.firstChild!.type.name).toBe('ordered_list');
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBeNull();
    expect(editor.action(getMarkdown())).toContain('**One**');
    run(view, 'bulletList');
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list');
    expect(view.state.doc.firstChild!.child(0).childCount).toBe(1);
  });

  it('toggles a list off for the selected item, leaving its siblings intact', async () => {
    const { view } = await makeEditor('- One\n- Two');
    selectText(view, 'One', true);
    run(view, 'bulletList');
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(view.state.doc.firstChild!.textContent).toBe('One');
    expect(view.state.doc.lastChild!.type.name).toBe('bullet_list');
    expect(view.state.doc.lastChild!.textContent).toBe('Two');
  });

  it('can turn headings into list items', async () => {
    const { view } = await makeEditor('## Heading');
    selectText(view, 'Heading');
    run(view, 'taskList');
    expect(view.state.doc.firstChild!.firstChild!.firstChild!.type.name).toBe('paragraph');
    expect(view.state.doc.textContent).toBe('Heading');
  });

  it('supports nesting and unnesting lists', async () => {
    const { view } = await makeEditor('- One\n- Two');
    selectText(view, 'Two', true);
    run(view, 'indent');
    expect(view.state.doc.firstChild!.firstChild!.lastChild!.type.name).toBe('bullet_list');
    run(view, 'outdent');
    expect(view.state.doc.firstChild!.childCount).toBe(2);
  });

  it('sets headings and code blocks, with accurate active state', async () => {
    const { view } = await makeEditor('Hello');
    expect(setTextStyle('h2')(view.state, view.dispatch)).toBe(true);
    expect(getFormattingState(view.state).textStyle).toBe('h2');
    expect(setTextStyle('code_block')(view.state, view.dispatch)).toBe(true);
    expect(getFormattingState(view.state).textStyle).toBe('code_block');
    expect(getFormattingState(view.state).enabled.strong).toBe(false);
    expect(getFormattingState(view.state).linkEnabled).toBe(false);
    expect(setTextStyle('paragraph')(view.state, view.dispatch)).toBe(true);
    run(view, 'blockquote');
    expect(getFormattingState(view.state).active.blockquote).toBe(true);
    run(view, 'blockquote');
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
  });

  it('toggles inline code at the caret without retaining incompatible marks', async () => {
    const { view } = await makeEditor('Hello');
    run(view, 'strong');
    run(view, 'inlineCode');
    view.dispatch(view.state.tr.insertText('code'));
    expect(view.state.doc.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual(['inlineCode']);
    run(view, 'inlineCode');
    expect(getFormattingState(view.state).active.inlineCode).toBe(false);
  });

  it('removes a surrounding quote without unwrapping its list', async () => {
    const { view } = await makeEditor('> - One\n> - Two');
    selectText(view, 'One', true);
    run(view, 'blockquote');
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list');
    expect(view.state.doc.firstChild!.childCount).toBe(2);
  });

  it('toggles a quote when its entire contents are selected with Select All', async () => {
    const { view } = await makeEditor('> One\n>\n> Two');
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(getFormattingState(view.state).active.blockquote).toBe(true);
    run(view, 'blockquote');
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
  });
});

describe('interactive checklists', () => {
  it('renders real checkboxes and saves toggles as GFM', async () => {
    const { editor, view } = await makeEditor('- [ ] First\n- [x] Second');
    const checkbox = view.dom.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.getAttribute('aria-label')).toContain('First');
    checkbox.click();
    expect(view.state.doc.firstChild!.firstChild!.attrs.checked).toBe(true);
    expect(editor.action(getMarkdown())).toContain('[x] First');
    run(view, 'undo');
    expect(view.dom.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  });

  it.each([false, true])('continues a checked=%s item with an unchecked item', async checked => {
    const { view } = await makeEditor(`- [${checked ? 'x' : ' '}] First`);
    selectText(view, 'First');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.to)));
    expect(splitTaskItem(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.firstChild!.childCount).toBe(2);
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(checked);
    expect(view.state.doc.firstChild!.child(1).attrs.checked).toBe(false);
  });

  it('keeps both halves as tasks when splitting in the middle', async () => {
    const { view } = await makeEditor('- [x] First second');
    selectText(view, 'second', true);
    expect(splitTaskItem(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(true);
    expect(view.state.doc.firstChild!.child(1).attrs.checked).toBe(false);
    expect(view.state.doc.firstChild!.child(1).textContent).toBe('second');
  });
});

describe('link editing and clipboard commands', () => {
  it.each([
    ['example.com/docs', 'https://example.com/docs'],
    ['www.example.com', 'https://www.example.com'],
    [' HTTPS://example.com/a_(b)#c ', 'https://example.com/a_(b)#c'],
    ['docs/notes.md', 'docs/notes.md'],
    ['notes.md', 'notes.md'],
    ['notes.md#intro', 'notes.md#intro'],
    ['attachments/my file.pdf', 'attachments/my file.pdf'],
    ['whim://space/123', 'whim://space/123'],
    ['mailto:person@example.com', 'mailto:person@example.com'],
    ['javascript:alert(1)', null],
    ['java\tscript:alert(1)', null],
    ['java\u200bscript:alert(1)', null],
    ['data:text/html,test', null],
    ['https://', null],
    ['', null],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeLinkUrl(input)).toBe(expected);
  });

  it('links selected text without losing its formatting and removes just the link', async () => {
    const { editor, view } = await makeEditor('Read **these docs** please');
    selectText(view, 'these docs');
    const target = beginLink(view);
    expect(applyLink(view, 'example.com', target.text)).toBeNull();
    expect(view.dom.querySelector('strong')?.textContent).toBe('these docs');
    expect(view.state.doc.textContent).toBe('Read these docs please');
    selectText(view, 'these docs', true);
    const linked = beginLink(view);
    expect(linked.href).toBe('https://example.com');
    expect(applyLink(view, null, linked.text)).toBeNull();
    expect(editor.action(getMarkdown())).toContain('**these docs**');
    expect(editor.action(getMarkdown())).not.toContain('https://');
  });

  it('edits an entire link spanning multiple differently formatted text nodes', async () => {
    const { view } = await makeEditor('Before [one **two** three](https://old.example) after');
    selectText(view, 'two', true);
    const target = beginLink(view);
    expect(target.text).toBe('one two three');
    expect(applyLink(view, 'https://new.example', target.text)).toBeNull();
    const links: string[] = [];
    view.state.doc.descendants(node => {
      for (const mark of node.marks) if (mark.type.name === 'link') links.push(mark.attrs.href);
    });
    expect(links).toEqual(['https://new.example', 'https://new.example', 'https://new.example']);
  });

  it('inserts custom link text at the caret without linking subsequent typing', async () => {
    const { view } = await makeEditor('End');
    selectText(view, 'End', true);
    beginLink(view);
    expect(applyLink(view, 'https://example.com', 'Docs')).toBeNull();
    view.dispatch(view.state.tr.insertText(' plain'));
    expect(view.state.doc.firstChild!.firstChild!.text).toBe('Docs');
    expect(view.state.doc.firstChild!.child(1).marks).toHaveLength(0);
  });

  it('links and edits text selected with Select All without replacing the paragraph', async () => {
    const { view } = await makeEditor('Docs');
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const target = beginLink(view);
    expect(target.canEditText).toBe(true);
    expect(applyLink(view, 'https://example.com', 'Read docs')).toBeNull();
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(view.state.doc.textContent).toBe('Read docs');
    expect(view.dom.querySelector('a')?.textContent).toBe('Read docs');
  });

  it('maps a saved link range through an unrelated external edit', async () => {
    const { editor, view } = await makeEditor('Read docs');
    selectText(view, 'docs');
    const target = beginLink(view);
    view.dispatch(view.state.tr.insertText('Please ', 1));
    expect(applyLink(view, 'https://example.com', target.text)).toBeNull();
    expect(editor.action(getMarkdown())).toContain('Please Read [docs](https://example.com)');
  });

  it('refuses to overwrite a link range changed by another edit', async () => {
    const { view } = await makeEditor('Read docs');
    selectText(view, 'docs');
    const target = beginLink(view);
    view.dispatch(view.state.tr.insertText('new', target.from, target.to));
    expect(applyLink(view, 'https://example.com', target.text)).toMatch(/selected text changed/);
    expect(view.state.doc.textContent).toBe('Read new');
  });

  it('pastes a URL over selected text as a link, in one undo step', async () => {
    const { editor, view } = await makeEditor('Read **the docs**');
    selectText(view, 'the docs');
    const original = view.state.doc;
    const event = pasteEvent('https://example.com/a_(b)');
    expect(pasteLink(view, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('Read the docs');
    expect(view.dom.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a_(b)');
    expect(view.dom.querySelector('strong')?.textContent).toBe('the docs');
    expect(editor.action(getMarkdown())).toContain('https://example.com/a_\\(b\\)');
    run(view, 'undo');
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('pastes a clickable URL at the caret, leaving the next characters unlinked', async () => {
    const { view } = await makeEditor('');
    expect(pasteLink(view, pasteEvent('https://example.com'))).toBe(true);
    view.dispatch(view.state.tr.insertText(' more'));
    expect(view.state.doc.firstChild!.firstChild!.marks[0].attrs.href).toBe('https://example.com');
    expect(view.state.doc.firstChild!.lastChild!.marks).toHaveLength(0);
  });

  it('continues typing after text linked by pasting instead of replacing the label', async () => {
    const { view } = await makeEditor('Read the docs');
    selectText(view, 'the docs');
    expect(pasteLink(view, pasteEvent('https://example.com'))).toBe(true);
    expect(view.state.selection.empty).toBe(true);
    view.dispatch(view.state.tr.insertText(' next'));
    expect(view.state.doc.textContent).toBe('Read the docs next');
    expect(view.state.doc.firstChild!.lastChild!.marks).toHaveLength(0);
  });

  it.each(['`https://example.com`', '```\nhttps://example.com\n```'])('leaves URLs inside code alone: %s', async markdown => {
    const { view } = await makeEditor(markdown);
    selectText(view, 'https://example.com');
    expect(pasteLink(view, pasteEvent('https://new.example'))).toBe(false);
  });

  it.each(['Some text https://example.com', '[Docs](https://example.com)', 'https://one.example\nhttps://two.example'])('does not reinterpret non-URL clipboard content: %s', async text => {
    const { view } = await makeEditor('Selected');
    selectText(view, 'Selected');
    expect(pasteLink(view, pasteEvent(text))).toBe(false);
  });
});

function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  act(() => reactRoot!.render(element));
  return container;
}

async function renderEditor(initialContent: string, props: Partial<MilkdownEditorProps> = {}) {
  const ref = React.createRef<MilkdownEditorHandle>();
  const onContentChanged = vi.fn();
  const container = mount(<MilkdownEditor theme="light" {...props} ref={ref} initialContent={initialContent} onContentChanged={onContentChanged} />);
  await act(async () => { await vi.waitFor(() => expect(ref.current?.isReady()).toBe(true)); });
  return { ref, onContentChanged, container, prose: container.querySelector<HTMLElement>('.ProseMirror')! };
}

describe('editor controls UI', () => {
  it('exposes the common actions without requiring a selection and preserves focus on mouse down', async () => {
    const { view } = await makeEditor('Hello');
    const onAction = vi.fn();
    const container = mount(<EditorToolbar state={getFormattingState(view.state)} onAction={onAction} onTextStyle={vi.fn()} onLink={vi.fn()} onReturnToEditor={vi.fn()} />);
    expect(container.querySelector('[aria-label="Text style"]')).not.toBeNull();
    for (const name of ['Bulleted list', 'Numbered list', 'Checklist', 'Insert or edit link']) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
      expect(button.disabled).toBe(false);
      expect(button.title).toContain(name);
    }
    const checklist = container.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => { checklist.dispatchEvent(down); checklist.click(); });
    expect(down.defaultPrevented).toBe(true);
    expect(onAction).toHaveBeenCalledWith('taskList');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.disabled).toBe(true);
  });

  it('focuses the link address, traps focus, and dismisses Escape without closing the canvas', async () => {
    const { view } = await makeEditor('Docs');
    selectText(view, 'Docs');
    const onCancel = vi.fn();
    const outsideKey = vi.fn();
    mount(<LinkEditor target={getLinkTarget(view.state)!} theme="light" onApply={vi.fn()} onCancel={onCancel} />);
    const dialog = document.querySelector<HTMLFormElement>('[role="dialog"]')!;
    const input = dialog.querySelectorAll('input')[1];
    expect(document.activeElement).toBe(input);
    const last = dialog.querySelectorAll('button')[0];
    act(() => {
      dialog.querySelector('input')!.focus();
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
    document.addEventListener('keydown', outsideKey);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    document.removeEventListener('keydown', outsideKey);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(outsideKey).not.toHaveBeenCalled();
  });

  it('wires the real editor toolbar, Cmd+K, URL pasting, and plain-text paste', async () => {
    const { ref, onContentChanged, prose } = await renderEditor('');
    act(() => prose.dispatchEvent(pasteEvent('https://example.com')));
    expect(ref.current!.getMarkdown()).toContain('https://example.com');
    expect(prose.querySelector('a')?.getAttribute('href')).toBe('https://example.com');

    act(() => prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', metaKey: true, shiftKey: true, bubbles: true }));
      prose.dispatchEvent(pasteEvent(' **literal** '));
    });
    expect(prose.querySelector('strong')).toBeNull();
    expect(prose.textContent).toContain('**literal**');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(onContentChanged).toHaveBeenCalled();
  });

  it('keeps URL and rich HTML pastes literal when paste-as-plain-text is requested', async () => {
    const { prose } = await renderEditor('');
    act(() => {
      prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', metaKey: true, shiftKey: true, bubbles: true }));
      prose.dispatchEvent(pasteEvent('https://example.com', '<a href="https://example.com">https://example.com</a>'));
    });
    expect(prose.textContent).toBe('https://example.com');
    expect(prose.querySelector('a')).toBeNull();
  });

  it.each(['`code`', '```\ncode\n```'])('keeps pasted URLs literal in %s', async markdown => {
    const { prose } = await renderEditor(markdown);
    act(() => prose.dispatchEvent(pasteEvent('https://example.com')));
    expect(prose.querySelector('a')).toBeNull();
    expect(prose.querySelector('code')?.textContent).toContain('https://example.com');
  });

  it('leaves Markdown paste parsing and image upload intact', async () => {
    const uploadFile = vi.fn(async () => ({ src: 'attachments/image.png' }));
    const { ref, prose } = await renderEditor('', { uploadFile });
    act(() => prose.dispatchEvent(pasteEvent('**Bold**')));
    expect(prose.querySelector('strong')?.textContent).toBe('Bold');
    const data = new DataTransfer();
    data.items.add(new File(['image'], 'image.png', { type: 'image/png' }));
    data.setData('text/plain', 'https://example.com');
    await act(async () => {
      prose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(ref.current!.getMarkdown()).toContain('attachments/image.png');
    expect(prose.querySelector('a')).toBeNull();
  });

  it('opens links with Ctrl+K on Windows and reaches the toolbar with Alt+F10', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const { container, prose } = await renderEditor('Notes');
    act(() => prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', altKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(container.querySelector('.md-editor-toolbar select'));
  });

  it('routes app links through the host without giving unsafe schemes a native href', async () => {
    const onLinkClick = vi.fn();
    const { prose } = await renderEditor('[Space](whim://space/123) [File](file:///tmp/notes.md) [Unsafe](javascript:alert)', { onLinkClick });
    const links = prose.querySelectorAll<HTMLAnchorElement>('a');
    act(() => { links[0].click(); links[1].click(); links[2].click(); });
    expect(onLinkClick.mock.calls).toEqual([['whim://space/123'], ['file:///tmp/notes.md']]);
    expect(links[2].getAttribute('href')).toBe('');
  });

  it('reports selections after the view is ready, including initial list normalization', async () => {
    const error = vi.spyOn(console, 'error');
    const { ref, container } = await renderEditor('1. First\n2. Second');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!.click());
    expect(ref.current!.getMarkdown()).toContain('[ ] First');
    act(() => ref.current!.insertMarkdown('A longer inserted paragraph with an @mention', true));
    expect(error).not.toHaveBeenCalled();
  });

  it('exits an empty checklist on Enter', async () => {
    const { container, prose } = await renderEditor('');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!.click());
    expect(prose.querySelector('input[type="checkbox"]')).not.toBeNull();
    act(() => prose.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(prose.querySelector('li')).toBeNull();
  });
});
