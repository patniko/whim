// @vitest-environment happy-dom
//
// Regression coverage for the three core canvas-editor behaviors that have silently
// broken before: the selection toolbar trigger, typing effects, and autosave.
//
// Part A drives the real ProseMirror plugins + Milkdown listeners directly (layout-free,
// so it's reliable under happy-dom). Part B renders the real <MilkdownEditor> React
// component to lock in the error-isolation that keeps a throwing host callback from
// bricking the whole editor (selection / typing / autosave) for the session.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { typingEffectsPlugin, typingEffectsPluginKey, SUPPRESS_TYPING_EFFECTS } from './plugins/typing-effects-plugin';
import { hostDecorationPlugin, decorationPluginKey } from './plugins/decoration-plugin';
import { commentPlugin } from './plugins/comment-plugin';
import { presencePlugin, SET_PRESENCE } from './plugins/presence-plugin';
import { MilkdownEditor, type MilkdownEditorHandle } from './MilkdownEditor';
import { mergeDirtyRawExternalChange } from '../MarkdownCanvas';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface Listeners {
  markdownUpdates: string[];
  selections: { from: number; to: number; text: string }[];
}

async function makeEditor(initial: string, listeners: Listeners) {
  const root = document.createElement('div');
  root.className = 'markdown-canvas-container';
  document.body.appendChild(root);

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, initial);
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: 'milkdown-prose', spellcheck: 'true' },
      }));
      const l = ctx.get(listenerCtx);
      l.markdownUpdated((_c, md) => { listeners.markdownUpdates.push(md); });
      l.selectionUpdated((sctx, selection) => {
        const view = sctx.get(editorViewCtx);
        const { from, to, empty } = selection;
        if (empty) return;
        listeners.selections.push({ from, to, text: view.state.doc.textBetween(from, to, '\n', '\uFFFC') });
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(clipboard)
    .use(history)
    .use(cursor)
    .use(typingEffectsPlugin)
    .use(hostDecorationPlugin)
    .use(commentPlugin)
    .use(presencePlugin)
    .create();

  const view = editor.ctx.get(editorViewCtx) as EditorView;
  return { editor, view, root };
}

function decorationCount(view: EditorView): number {
  const st = typingEffectsPluginKey.getState(view.state);
  // DecorationSet#find() returns all decorations in the set.
  return (st?.set as any)?.find?.().length ?? 0;
}

describe('canvas editor — typing effects (regression)', () => {
  it('renders a typing-effect decoration when a character is inserted', async () => {
    const listeners: Listeners = { markdownUpdates: [], selections: [] };
    const { view, editor } = await makeEditor('Hello world', listeners);

    expect(decorationCount(view)).toBe(0);
    const endPos = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.insertText('!', endPos));

    const st = typingEffectsPluginKey.getState(view.state);
    expect(st!.effects.length).toBeGreaterThan(0);
    expect(st!.effects[0]!.kind).toBe('insert');
    expect(decorationCount(view)).toBeGreaterThan(0);

    editor.destroy();
  });

  it('suppresses typing effects when the SUPPRESS meta is set (programmatic writes)', async () => {
    const listeners: Listeners = { markdownUpdates: [], selections: [] };
    const { view, editor } = await makeEditor('Hello world', listeners);

    // Mirror MilkdownEditor.replaceAll's non-animated path: flag suppression, then edit.
    view.dispatch(view.state.tr.setMeta(SUPPRESS_TYPING_EFFECTS, true));
    const endPos = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.insertText('Z', endPos));

    const st = typingEffectsPluginKey.getState(view.state);
    expect(st!.effects.length).toBe(0);
    expect(decorationCount(view)).toBe(0);

    editor.destroy();
  });
});

describe('canvas editor — selection trigger (regression)', () => {
  it('fires selectionUpdated with the selected text when a range is selected', async () => {
    const listeners: Listeners = { markdownUpdates: [], selections: [] };
    const { view, editor } = await makeEditor('Hello world', listeners);

    // Select "Hello" (positions 1..6 inside the first paragraph).
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));

    expect(listeners.selections.length).toBeGreaterThan(0);
    expect(listeners.selections.at(-1)!.text).toBe('Hello');

    editor.destroy();
  });
});

describe('canvas editor — autosave wiring (regression)', () => {
  it('fires markdownUpdated with the new markdown after an edit', async () => {
    const listeners: Listeners = { markdownUpdates: [], selections: [] };
    const { view, editor } = await makeEditor('Hello world', listeners);

    const endPos = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.insertText('!', endPos));

    // Milkdown debounces markdownUpdated ~200ms.
    await new Promise((r) => setTimeout(r, 300));

    expect(listeners.markdownUpdates.length).toBeGreaterThan(0);
    expect(listeners.markdownUpdates.at(-1)).toContain('Hello world!');

    editor.destroy();
  });

  describe('canvas editor — raw external changes', () => {
    it('preserves dirty raw edits while merging non-overlapping disk changes', () => {
      const base = '# Title\n\nBody\n';
      const local = '# Local title\n\nBody\n';
      const disk = '# Title\n\nBody from disk\n';

      expect(mergeDirtyRawExternalChange(base, local, disk))
        .toBe('# Local title\n\nBody from disk\n');
    });
  });
});

describe('canvas editor — malformed agent data (regression hardening)', () => {
  it('survives malformed presence + decoration payloads without breaking the editor', async () => {
    const listeners: Listeners = { markdownUpdates: [], selections: [] };
    const { view, editor } = await makeEditor('Hello world', listeners);

    // Malformed agent/host payloads that would throw inside the plugins' transaction
    // `apply` (e.g. `'threadId' in p.cursor` on a non-object, or `.flags` on a non-RegExp
    // pattern). Pre-hardening these aborted the whole transaction and bricked the editor.
    expect(() => {
      view.dispatch(view.state.tr.setMeta(SET_PRESENCE, [{ userId: 'agent', cursor: 5 }] as any));
    }).not.toThrow();
    expect(() => {
      view.dispatch(view.state.tr.setMeta(decorationPluginKey, [{ pattern: 'not-a-regexp' }] as any));
    }).not.toThrow();

    // The editor must still accept edits afterwards.
    const endPos = view.state.doc.content.size - 1;
    expect(() => {
      view.dispatch(view.state.tr.insertText('!', endPos));
    }).not.toThrow();
    expect(view.state.doc.textContent).toContain('Hello world!');

    editor.destroy();
  });
});

describe('canvas editor — error isolation (regression hardening)', () => {
  let container: HTMLElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'markdown-canvas-container';
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { reactRoot.unmount(); });
    container.remove();
  });

  it('keeps applying edits + reporting changes even if host callbacks throw', async () => {
    const ref = React.createRef<MilkdownEditorHandle>();
    let contentChanges = 0;

    await act(async () => {
      reactRoot.render(
        <MilkdownEditor
          ref={ref}
          initialContent={'Hello world'}
          theme={'light'}
          // Both of these run inside the editor's hot paths (a debounced timer and the
          // ProseMirror transaction apply). An unguarded throw here would otherwise abort
          // the transaction pipeline (killing typing + selection) and permanently stall the
          // markdown stream (killing autosave).
          onContentChanged={() => { contentChanges += 1; throw new Error('boom: onContentChanged'); }}
          onSelectionChange={() => { throw new Error('boom: onSelectionChange'); }}
        />,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(ref.current?.isReady()).toBe(true);

    // First edit — its caret move fires the throwing onSelectionChange and its markdown
    // update fires the throwing onContentChanged. The editor must survive both.
    await act(async () => { ref.current?.insertMarkdown(' one'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

    // Second edit — must still apply and still report (proves nothing got bricked).
    await act(async () => { ref.current?.insertMarkdown(' two'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

    const md = ref.current?.getMarkdown() ?? '';
    expect(md).toContain('one');
    expect(md).toContain('two');
    expect(contentChanges).toBeGreaterThanOrEqual(2);
  });
});
