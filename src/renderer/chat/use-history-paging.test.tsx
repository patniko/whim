// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/chat-types';
import type { ChatHistoryPaging, ChatHistorySource } from './transcript-layout';
import { useHistoryPaging } from './use-history-paging';

const latest: ChatMessage = { id: 'latest', type: 'assistant', content: 'current', isStreaming: false, timestamp: '' };
const earlier: ChatMessage = { id: 'earlier', type: 'assistant', content: 'older', isStreaming: false, timestamp: '' };
let root: Root;
let host: HTMLDivElement;
let paging: ChatHistoryPaging | undefined;
let messages: ChatMessage[];
function Harness({ source }: { source: ChatHistorySource }) {
  const [items, setItems] = useState([latest]);
  messages = items;
  paging = useHistoryPaging(source, setItems);
  return null;
}
function deferredPage() {
  let resolve!: (items: ChatMessage[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ChatMessage[]>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('single-flights older-page requests and preserves newer rows on overlap', async () => {
  const page = deferredPage();
  const source = { hasOlder: true, loadOlder: vi.fn(() => page.promise) };
  act(() => root.render(<Harness source={source} />));
  act(() => { paging!.loadOlder(); paging!.loadOlder(); });
  expect(source.loadOlder).toHaveBeenCalledOnce();
  expect(paging!.loading).toBe(true);
  await act(async () => page.resolve([earlier, { ...latest, content: 'stale' }]));
  expect(messages).toEqual([earlier, latest]);
  expect(paging!.loading).toBe(false);
});

it('surfaces page failures and permits retry', async () => {
  const page = deferredPage();
  const source = { hasOlder: true, loadOlder: vi.fn(() => page.promise) };
  act(() => root.render(<Harness source={source} />));
  act(() => { paging!.loadOlder(); });
  await act(async () => page.reject(new Error('Synthetic paging failure')));
  expect(paging!.error).toBe('Synthetic paging failure');
  expect(paging!.loading).toBe(false);
  source.loadOlder.mockResolvedValueOnce([earlier]);
  await act(async () => paging!.loadOlder());
  expect(paging!.error).toBeUndefined();
  expect(messages).toEqual([earlier, latest]);
});

it('ignores a stale page after the history source changes', async () => {
  const page = deferredPage();
  act(() => root.render(<Harness source={{ hasOlder: true, loadOlder: () => page.promise }} />));
  act(() => { paging!.loadOlder(); });
  act(() => root.render(<Harness source={{ hasOlder: false, loadOlder: async () => [] }} />));
  await act(async () => page.resolve([earlier]));
  expect(messages).toEqual([latest]);
  expect(paging!.loading).toBe(false);
});
