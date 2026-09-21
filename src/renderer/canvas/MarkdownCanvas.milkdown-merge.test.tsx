// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { listenerCtx } from '@milkdown/kit/plugin/listener';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { merge3, type MergeResult } from '../../shared/text-merge';
import { MarkdownCanvas, type CanvasSaveResult, type MarkdownCanvasHandle } from './MarkdownCanvas';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage?: (event: { data: { result: MergeResult } }) => void;
  input!: { base: string; ours: string; theirs: string };
  terminate = vi.fn();
  constructor() { ControlledWorker.instances.push(this); }
  postMessage(input: ControlledWorker['input']) { this.input = input; }
  reply() {
    const { base, ours, theirs } = this.input;
    this.onmessage?.({ data: { result: merge3(base, ours, theirs) } });
  }
}

// Real markdown, parser, editor, listener, document merge and worker client.
// Only IPC and delivery of worker replies are controlled.
const base = Array.from({ length: 100 }, (_, n) => `Paragraph ${n}`).join('\n\n') + '\n';
let root: Root;
let container: HTMLDivElement;
let canvas: React.RefObject<MarkdownCanvasHandle | null>;
let editor: Editor;
let view: EditorView;
let markdownUpdates: ReturnType<typeof vi.fn<() => void>>;
let dirty: ReturnType<typeof vi.fn<(dirty: boolean) => void>>;
let writeCanvas: ReturnType<typeof vi.fn<(id: string, content: string) => Promise<CanvasSaveResult>>>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', ControlledWorker);
  ControlledWorker.instances = [];
  writeCanvas = vi.fn(async (_id, content) => ({ success: true, content }));
  vi.stubGlobal('whimAPI', { getSetting: vi.fn().mockResolvedValue(null), writeCanvas });
  const make = vi.spyOn(Editor, 'make');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  canvas = React.createRef();
  dirty = vi.fn();
  await act(async () => {
    root.render(<MarkdownCanvas ref={canvas} spaceId="fixture" initialContent={base}
      theme="light" onDirtyChange={dirty} onSaveStatus={vi.fn()} />);
  });
  await act(async () => {
    await vi.waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull());
  });
  editor = make.mock.results[0].value;
  view = editor.ctx.get(editorViewCtx);
  markdownUpdates = vi.fn();
  editor.ctx.get(listenerCtx).markdownUpdated(markdownUpdates);
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function typeAtEnd(text: string) {
  act(() => view.dispatch(view.state.tr.insertText(text, view.state.doc.content.size - 1)));
}

describe('real canvas editor reconciliation before the markdown debounce', () => {
  it('retries a controlled worker reply and exactly preserves the last editor transaction', async () => {
    typeAtEnd(' first edit');
    await act(async () => { await vi.advanceTimersByTimeAsync(201); });
    expect(markdownUpdates).toHaveBeenCalledOnce();
    markdownUpdates.mockClear();
    act(() => canvas.current!.replaceContent(base.replace('Paragraph 0', 'Remote heading')));
    expect(ControlledWorker.instances).toHaveLength(1);
    typeAtEnd(' latest typing');
    const local = base.replace('Paragraph 99', 'Paragraph 99 first edit latest typing');
    expect(markdownUpdates).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith(true);
    expect(view.state.doc.lastChild!.textContent).toBe('Paragraph 99 first edit latest typing');

    await act(async () => ControlledWorker.instances[0].reply());
    expect(ControlledWorker.instances).toHaveLength(2);
    expect(ControlledWorker.instances[1].input.ours).toBe(local);
    expect(canvas.current!.getContent()).toBe(local);
    await act(async () => ControlledWorker.instances[1].reply());
    const expected = local.replace('Paragraph 0', 'Remote heading');
    expect(canvas.current!.getContent()).toBe(expected);
    expect(view.state.doc.lastChild!.textContent).toBe('Paragraph 99 first edit latest typing');
    expect(markdownUpdates).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(201); });
    expect(canvas.current!.getContent()).toBe(expected);
  });

  it('includes pending typing in save/close, rebases the acknowledgement, and saves the newest revision', async () => {
    let acknowledge!: (result: CanvasSaveResult) => void;
    writeCanvas.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    typeAtEnd(' before close');
    let saving!: Promise<CanvasSaveResult>;
    act(() => { saving = canvas.current!.saveNow(); });
    const sent = base.replace('Paragraph 99', 'Paragraph 99 before close');
    expect(writeCanvas).toHaveBeenCalledExactlyOnceWith('fixture', sent);

    typeAtEnd(' during save');
    await act(async () => acknowledge({ success: true, content: sent.replace('Paragraph 0', 'Saved heading') }));
    expect(ControlledWorker.instances).toHaveLength(1);
    typeAtEnd(' before reply');
    await act(async () => ControlledWorker.instances[0].reply());
    expect(ControlledWorker.instances).toHaveLength(2);
    await act(async () => ControlledWorker.instances[1].reply());
    await act(async () => { expect((await saving).success).toBe(true); });
    const expected = sent.replace('Paragraph 0', 'Saved heading')
      .replace('before close', 'before close during save before reply');
    expect(writeCanvas).toHaveBeenCalledTimes(2);
    expect(writeCanvas).toHaveBeenLastCalledWith('fixture', expected);
    expect(canvas.current!.getContent()).toBe(expected);
    expect(markdownUpdates).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('reads pending content once per document, not per cursor move, and retains it on raw-mode switch', () => {
    const serialize = vi.fn(editor.ctx.get(serializerCtx));
    editor.ctx.set(serializerCtx, serialize);
    typeAtEnd(' pending');
    const expected = base.replace('Paragraph 99', 'Paragraph 99 pending');
    expect(canvas.current!.getContent()).toBe(expected);
    for (let pos = 1; pos < 8; pos++) {
      act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))));
      expect(canvas.current!.getContent()).toBe(expected);
    }
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(markdownUpdates).not.toHaveBeenCalled();
    act(() => { expect(canvas.current!.toggleMode().mode).toBe('raw'); });
    expect(canvas.current!.getContent()).toBe(expected);
  });
});
