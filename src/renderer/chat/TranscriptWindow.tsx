import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/chat-types';
import { ChatHistoryPaging, hasPendingInteraction, ROW_GAP, TranscriptLayout } from './transcript-layout';

interface Props {
  messages: ChatMessage[];
  historyPaging?: ChatHistoryPaging;
  children: (message: ChatMessage) => React.ReactNode;
}

const MeasuredRow = memo(function MeasuredRow({ message, index, count, top, measure, children }: {
  message: ChatMessage;
  index: number;
  count: number;
  top: number;
  measure: (id: string, height: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const height = node.getBoundingClientRect().height;
      if (height > 0) measure(message.id, height + ROW_GAP);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.id, measure]);
  return (
    <div ref={ref} role="listitem" aria-posinset={index + 1} aria-setsize={count}
      data-message-id={message.id}
      style={{ position: 'absolute', top, left: 0, right: 0, display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  );
});

export function TranscriptWindow({ messages, historyPaging, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const measured = useRef(new Map<string, number>());
  const layoutRef = useRef<TranscriptLayout | null>(null);
  const previousMessages = useRef<ChatMessage[]>([]);
  const anchor = useRef<{ id?: string; offset: number; following: boolean }>({ offset: 0, following: true });
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [, invalidate] = useState(0);
  const [focusedId, setFocusedId] = useState<string>();
  const scrollFrame = useRef<number | undefined>(undefined);
  const layoutChanged = previousMessages.current !== messages &&
    (previousMessages.current.length !== messages.length ||
      previousMessages.current.some((message, index) => message.id !== messages[index]?.id));
  if (!layoutRef.current || layoutChanged) {
    layoutRef.current = new TranscriptLayout(messages, measured.current);
    const retained = layoutRef.current.positions;
    for (const id of measured.current.keys()) if (!retained.has(id)) measured.current.delete(id);
  }
  previousMessages.current = messages;
  const layout = layoutRef.current;
  const pendingIndices = useMemo(() => {
    const indices: number[] = [];
    messages.forEach((message, index) => { if (hasPendingInteraction(message)) indices.push(index); });
    return indices;
  }, [messages]);

  const captureAnchor = useCallback((top: number, following: boolean) => {
    const geometry = layoutRef.current!;
    const index = geometry.indexAt(top);
    anchor.current = { id: geometry.ids[index], offset: top - geometry.offset(index), following };
  }, []);

  const measure = useCallback((id: string, height: number) => {
    if (layoutRef.current?.measure(id, height)) {
      measured.current.set(id, height);
      invalidate(version => version + 1);
    }
  }, []);

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setViewport(previous => ({ ...previous, height: node.clientHeight || 600 }));
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  // Both prepends and late row/image/font measurements keep the same visible row.
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const saved = anchor.current;
    const index = saved.id ? layout.positions.get(saved.id) : undefined;
    const target = saved.following
      ? Math.max(0, layout.total - node.clientHeight)
      : index === undefined ? node.scrollTop : layout.offset(index) + saved.offset;
    node.scrollTop = Math.max(0, target);
    captureAnchor(node.scrollTop, saved.following);
    setViewport(previous => previous.top === node.scrollTop ? previous : { ...previous, top: node.scrollTop });
  });

  const scrollTo = (top: number, following = false) => {
    const node = container.current;
    if (!node) return;
    node.scrollTop = Math.max(0, Math.min(top, layout.total - node.clientHeight));
    captureAnchor(node.scrollTop, following);
    setViewport(previous => ({ ...previous, top: node.scrollTop }));
  };

  const effectiveTop = anchor.current.following ? Math.max(0, layout.total - viewport.height) :
    anchor.current.id && layout.positions.has(anchor.current.id)
      ? layout.offset(layout.positions.get(anchor.current.id)!) + anchor.current.offset : viewport.top;
  const range = layout.window(effectiveTop, viewport.height);
  const mounted = new Set<number>();
  for (let index = range.start; index < range.end; index++) mounted.add(index);
  // Never unmount an unanswered form or a focused control while it is being used.
  pendingIndices.forEach(index => mounted.add(index));
  const focusedIndex = focusedId ? layout.positions.get(focusedId) : undefined;
  if (focusedIndex !== undefined) mounted.add(focusedIndex);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {(range.start > 0 || range.end < messages.length || historyPaging?.hasOlder || pendingIndices.length > 0) && (
        <nav aria-label="Conversation navigation" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {historyPaging?.hasOlder && (
            <button onClick={historyPaging.loadOlder} disabled={historyPaging.loading}>
              {historyPaging.loading ? 'Loading earlier history...' : 'Load earlier history'}
            </button>
          )}
          <button disabled={range.start === 0} onClick={() => scrollTo(layout.offset(Math.max(0, range.start - 40)))}>
            Earlier messages
          </button>
          <button disabled={range.end === messages.length} onClick={() => scrollTo(layout.offset(range.end - 1))}>
            Later messages
          </button>
          <button onClick={() => scrollTo(layout.total, true)}>Latest messages</button>
          {pendingIndices.length > 0 && (
            <button onClick={() => {
              const next = pendingIndices.find(index => layout.offset(index) > effectiveTop + 1) ?? pendingIndices[0];
              scrollTo(layout.offset(next));
            }}>Pending requests ({pendingIndices.length})</button>
          )}
        </nav>
      )}
      {historyPaging?.error && <div role="alert">{historyPaging.error}</div>}
      <div className="chat-messages" ref={container} tabIndex={0} aria-label="Conversation"
        style={{ display: 'block', overflowAnchor: 'none', padding: 0 }}
        onFocusCapture={event => {
          const row = (event.target as HTMLElement).closest<HTMLElement>('[data-message-id]');
          setFocusedId(row?.dataset.messageId);
        }}
        onBlurCapture={event => {
          const row = (event.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>('[data-message-id]');
          setFocusedId(row?.dataset.messageId);
        }}
        onScroll={() => {
          const node = container.current!;
          captureAnchor(node.scrollTop, layout.total - node.scrollTop - node.clientHeight <= 100);
          if (scrollFrame.current === undefined) {
            scrollFrame.current = requestAnimationFrame(() => {
              scrollFrame.current = undefined;
              setViewport({ top: node.scrollTop, height: node.clientHeight || 600 });
            });
          }
        }}>
        <div role="list" aria-label="Messages" style={{ position: 'relative', height: layout.total }}>
          {[...mounted].sort((a, b) => a - b).map(index => (
            <MeasuredRow key={messages[index].id} message={messages[index]} index={index}
              count={messages.length} top={layout.offset(index)} measure={measure}>
              {children(messages[index])}
            </MeasuredRow>
          ))}
        </div>
      </div>
    </div>
  );
}
