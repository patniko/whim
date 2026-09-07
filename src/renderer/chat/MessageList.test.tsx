// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/chat-types';
import { MessageList } from './MessageList';

const renderCounts = vi.hoisted(() => new Map<string, number>());
vi.mock('./tiles/AssistantMessage', () => ({
  AssistantMessage: ({ content }: { content: string }) => {
    renderCounts.set(content, (renderCounts.get(content) || 0) + 1);
    return <div>{content}</div>;
  },
}));

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let observers: Map<Element, () => void>;
let heights: Map<string, number>;
const handlers = {
  onApprovalRespond: vi.fn(), onUserInputRespond: vi.fn(),
  onElicitationRespond: vi.fn(), onSandboxResolve: vi.fn(),
  onOpenSubagentDetail: vi.fn(),
};

beforeEach(() => {
  renderCounts.clear();
  frames = new Map();
  observers = new Map();
  heights = new Map();
  let next = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    private nodes: Element[] = [];
    constructor(private callback: () => void) {}
    observe(node: Element) { this.nodes.push(node); observers.set(node, this.callback); }
    disconnect() { this.nodes.forEach(node => observers.delete(node)); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 800, heights.get(this.dataset.messageId || '') ?? 96);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const messages = (count: number): ChatMessage[] => Array.from({ length: count }, (_, i) => ({
  id: String(i), type: 'assistant', content: `synthetic ${i}`, isStreaming: false, timestamp: '',
}));
const render = (items: ChatMessage[]) => act(() => root.render(<MessageList messages={items} {...handlers} />));
function scroll(top: number) {
  act(() => {
    const node = host.querySelector<HTMLElement>('.chat-messages')!;
    node.scrollTop = top;
    node.dispatchEvent(new Event('scroll'));
    for (const [id, callback] of frames) { frames.delete(id); callback(16); }
  });
}

describe('windowed chat components', () => {
  it('bounds DOM rows, memoizes stable rows, and follows streaming without smooth scrolling', () => {
    const items = messages(1000);
    render(items);
    expect(host.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(80);
    expect(host.textContent).toContain('synthetic 999');
    const count = renderCounts.get('synthetic 998');
    render([...items.slice(0, -1), { ...items[999], content: 'changed', type: 'assistant', isStreaming: true }]);
    expect(renderCounts.get('synthetic 998')).toBe(count);
    expect(host.textContent).toContain('changed');
    const node = host.querySelector<HTMLElement>('.chat-messages')!;
    expect(node.scrollTop).toBe(99_400);
  });

  it('preserves the visible anchor on prepend and on measured height changes above it', () => {
    const all = messages(1000);
    render(all.slice(100));
    scroll(10_017);
    const node = host.querySelector<HTMLElement>('.chat-messages')!;
    render(all);
    expect(node.scrollTop).toBe(20_017);
    const row = host.querySelector<HTMLElement>('[data-message-id="199"]')!;
    expect(row).not.toBeNull();
    heights.set('199', 196);
    act(() => observers.get(row)!());
    expect(node.scrollTop).toBe(20_117);
    render([...all, { id: 'new', type: 'assistant', content: 'tail', isStreaming: true, timestamp: '' }]);
    expect(node.scrollTop).toBe(20_117);
  });

  it('keeps pending approval/input/elicitation/sandbox controls mounted and preserves form drafts', () => {
    const items = messages(1000);
    items[2] = { id: '2', type: 'user_input', requestId: 'input', agentId: 'a',
      question: 'Synthetic question?', responded: false, allowFreeform: true, timestamp: '' };
    items[3] = { id: '3', type: 'elicitation', requestId: 'elicit', agentId: 'a',
      message: 'Synthetic form', responded: false,
      requestedSchema: { type: 'object', properties: { title: { type: 'string' } } }, timestamp: '' };
    items[4] = { id: '4', type: 'approval', requestId: 'approve', agentId: 'a',
      permissionKind: 'read', responded: false, timestamp: '' };
    items[5] = { id: '5', type: 'sandbox_block', requestId: 'sandbox', agentId: 'a',
      source: 'permission', kind: 'read', target: '/synthetic', responded: false, timestamp: '' };
    render(items);
    const form = host.querySelector('[data-message-id="3"]')!;
    const input = form.querySelector('input')!;
    act(() => {
      input.value = 'draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    scroll(20_000);
    render([...items]);
    expect(host.querySelector('[data-message-id="3"] input')).toBe(input);
    expect(input.value).toBe('draft');
    for (const id of ['2', '3', '4', '5']) expect(host.querySelector(`[data-message-id="${id}"]`)).not.toBeNull();
  });

  it('pins focused subagent controls and exposes keyboard-accessible history navigation', () => {
    const items = messages(1000);
    items[998] = { id: '998', type: 'tool_call', toolCallId: 'sub', toolName: '__subagent__',
      args: { name: 'task', displayName: 'Synthetic task', agentId: 'child' },
      completed: true, timestamp: '' };
    render(items);
    const row = host.querySelector<HTMLElement>('[data-message-id="998"]')!;
    const control = row.querySelector<HTMLElement>('[tabindex], button')!;
    expect(control).not.toBeNull();
    act(() => control.focus());
    scroll(10_000);
    expect(host.querySelector('[data-message-id="998"]')).toBe(row);
    expect(document.activeElement).toBe(control);
    const earlier = [...host.querySelectorAll('button')].find(button => button.textContent === 'Earlier messages')!;
    expect(earlier.disabled).toBe(false);
    act(() => earlier.click());
    expect(host.querySelector<HTMLElement>('.chat-messages')!.scrollTop).toBeLessThan(10_000);
  });

  it('passes through the optional paging seam without making transport calls', () => {
    const loadOlder = vi.fn();
    act(() => root.render(<MessageList messages={messages(100)} {...handlers}
      historyPaging={{ hasOlder: true, loading: false, loadOlder, error: 'Synthetic paging failure' }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Synthetic paging failure');
    act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Load earlier history')!.click());
    expect(loadOlder).toHaveBeenCalledOnce();
  });
});
