// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownCanvas, type MarkdownCanvasHandle, type CanvasSaveResult } from './MarkdownCanvas';
import { mergeCanvasDocument } from './document-merge';

vi.mock('./editor/MilkdownEditor', async () => {
  const React = await import('react');
  return {
    MilkdownEditor: React.forwardRef((_props, ref) => {
      React.useImperativeHandle(ref, () => ({ replaceAll: vi.fn(), focus: vi.fn() }));
      return null;
    }),
  };
});
vi.mock('./document-merge', () => ({ mergeCanvasDocument: vi.fn() }));

type MergeArguments = Parameters<typeof mergeCanvasDocument>;
type DocumentResult = Awaited<ReturnType<typeof mergeCanvasDocument>>;
let requests: Array<{ args: MergeArguments; resolve: (result: DocumentResult) => void; reject: (error: Error) => void }>;
let root: Root;
let container: HTMLDivElement;
let ref: React.RefObject<MarkdownCanvasHandle | null>;
let status: ReturnType<typeof vi.fn<(status: string) => void>>;
let writeCanvas: ReturnType<typeof vi.fn>;
const base = 'heading\nmiddle\ntail';

async function finish(index: number) {
  const actual = await vi.importActual<typeof import('./document-merge')>('./document-merge');
  const request = requests[index];
  // A cancelled worker may still deliver a message; exercise the revision
  // guard independently of the worker client's cancellation guard.
  const [base, local, disk, whole, frontmatter] = request.args;
  await act(async () => request.resolve(await actual.mergeCanvasDocument(base, local, disk, whole, frontmatter)));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  status = vi.fn<(status: string) => void>();
  writeCanvas = vi.fn();
  vi.stubGlobal('whimAPI', { getSetting: vi.fn().mockResolvedValue(null), writeCanvas });
  vi.mocked(mergeCanvasDocument).mockImplementation((...args) =>
    new Promise((resolve, reject) => requests.push({ args, resolve, reject })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ref = React.createRef();
  await act(async () => root.render(
    <MarkdownCanvas ref={ref} spaceId="fixture" initialContent={base} theme="light"
      onDirtyChange={vi.fn()} onSaveStatus={status} />,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('canvas merge revision guards', () => {
  it('retries a stale worker result against edits typed during execution', async () => {
    await act(async () => ref.current!.appendLink('first', 'https://first.test'));
    await act(async () => ref.current!.replaceContent(base.replace('heading', 'remote')));
    await act(async () => ref.current!.appendLink('second', 'https://second.test'));
    await finish(0);
    expect(requests).toHaveLength(2);
    expect(ref.current!.getContent()).toContain('[second]');
    await finish(1);
    expect(ref.current!.getContent()).toContain('remote');
    expect(ref.current!.getContent()).toContain('[first]');
    expect(ref.current!.getContent()).toContain('[second]');
  });

  it('cancels superseded disk revisions and ignores late results', async () => {
    await act(async () => ref.current!.replaceContent('older\nmiddle\ntail'));
    await act(async () => ref.current!.replaceContent('newest\nmiddle\ntail'));
    expect(requests[0].args[5]?.aborted).toBe(true);
    await finish(1);
    await finish(0);
    expect(ref.current!.getContent()).toBe('newest\nmiddle\ntail');
  });

  it('does not let a delayed save acknowledgement overwrite newer typing', async () => {
    let acknowledge!: (result: CanvasSaveResult) => void;
    writeCanvas.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    await act(async () => ref.current!.appendLink('first', 'https://first.test'));
    let save!: Promise<CanvasSaveResult>;
    await act(async () => { save = ref.current!.saveNow(); });
    const sent = writeCanvas.mock.calls[0][1] as string;
    await act(async () => ref.current!.appendLink('second', 'https://second.test'));
    await act(async () => acknowledge({ success: true, content: sent.replace('heading', 'remote') }));
    expect(ref.current!.getContent()).toContain('[second]');
    await finish(0);
    // The explicit Save includes the newer revision, not just the first ACK.
    await act(async () => acknowledge({ success: true, content: writeCanvas.mock.calls[1][1] }));
    await act(async () => { expect((await save).success).toBe(true); });
    expect(ref.current!.getContent()).toContain('remote');
    expect(ref.current!.getContent()).toContain('[second]');
  });

  it('keeps failed merges unsaved and surfaces errors instead of overwriting disk', async () => {
    await act(async () => ref.current!.appendLink('local', 'https://local.test'));
    const local = ref.current!.getContent();
    await act(async () => ref.current!.replaceContent('remote\nmiddle\ntail'));
    await act(async () => requests[0].reject(new Error('merge_resource_limit')));
    expect(ref.current!.getContent()).toBe(local);
    expect(status).toHaveBeenCalledWith(expect.stringContaining('merge_resource_limit'));
    let save!: Promise<CanvasSaveResult>;
    await act(async () => { save = ref.current!.saveNow(); });
    await act(async () => requests[1].reject(new Error('merge_resource_limit')));
    expect((await save).success).toBe(false);
    expect(writeCanvas).not.toHaveBeenCalled();
    expect(ref.current!.getContent()).toBe(local);
  });

  it('bounds retries during continuous typing and retains the pending disk version', async () => {
    await act(async () => ref.current!.replaceContent('remote\nmiddle\ntail'));
    for (let index = 0; index < 3; index++) {
      await act(async () => ref.current!.appendLink(`edit-${index}`, 'https://local.test'));
      await finish(index);
    }
    expect(requests).toHaveLength(3);
    expect(status).toHaveBeenCalledWith(expect.stringContaining('Merge paused while editing'));
    expect(ref.current!.getContent()).toContain('[edit-2]');
    let save!: Promise<CanvasSaveResult>;
    writeCanvas.mockResolvedValue({ success: true });
    await act(async () => { save = ref.current!.saveNow(); });
    await finish(3);
    await act(async () => { expect((await save).success).toBe(true); });
    expect(ref.current!.getContent()).toContain('remote');
    expect(ref.current!.getContent()).toContain('[edit-2]');
  });
});
