import React from "react";
import { TranscriptLayout } from "../chat/transcript-layout";

function MeasuredRow({
  id,
  top,
  index,
  total,
  measure,
  children,
}: {
  id: string;
  top: number;
  index: number;
  total: number;
  measure: (id: string, height: number) => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const node = ref.current!;
    const resize = () => {
      const height = node.getBoundingClientRect().height;
      if (height > 0) measure(id, height + 4);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, measure]);
  return (
    <div
      ref={ref}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={total}
      data-virtual-id={id}
      style={{ position: "absolute", top, left: 0, right: 0 }}
    >
      {children}
    </div>
  );
}

/** Uses the list's existing scroll parent; focused controls are never unmounted. */
export function VirtualRows<T>({
  rows,
  rowId,
  render,
  selectedIndex = -1,
  total = rows.length,
  offset = 0,
}: {
  rows: T[];
  rowId: (row: T) => string;
  render: (row: T, index: number) => React.ReactNode;
  selectedIndex?: number;
  total?: number;
  offset?: number;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const scroller = React.useRef<HTMLElement | null>(null);
  const measured = React.useRef(new Map<string, number>());
  const ids = rows.map(rowId);
  const signature = JSON.stringify(ids);
  const layout = React.useMemo(
    () =>
      new TranscriptLayout(
        ids.map((id) => ({ id })),
        measured.current,
      ),
    [signature],
  );
  const geometry = React.useRef(layout);
  geometry.current = layout;
  const [viewport, setViewport] = React.useState({ top: 0, height: 600 });
  const anchor = React.useRef<{ id?: string; offset: number }>({ offset: 0 });
  const documentScroll = React.useRef(false);
  const [focused, setFocused] = React.useState<string>();
  const [, redraw] = React.useState(0);
  const readViewport = React.useCallback(() => {
    const scroll = scroller.current!;
    const top =
      (documentScroll.current ? 0 : scroll.getBoundingClientRect().top) -
      container.current!.getBoundingClientRect().top;
    return {
      top,
      height: (documentScroll.current ? window.innerHeight : scroll.clientHeight) || 600,
    };
  }, []);
  const capture = React.useCallback(() => {
    const next = readViewport();
    const current = geometry.current;
    const index = current.indexAt(next.top);
    anchor.current = {
      id: next.top < current.total && next.top + next.height > 0 ? current.ids[index] : undefined,
      offset: next.top - current.offset(index),
    };
    setViewport((previous) =>
      Math.abs(previous.top - next.top) < 0.5 && previous.height === next.height ? previous : next,
    );
  }, [readViewport]);
  const measure = React.useCallback((id: string, height: number) => {
    if (!geometry.current.measure(id, height)) return;
    measured.current.set(id, height);
    redraw((value) => value + 1);
  }, []);
  React.useLayoutEffect(() => {
    let parent = container.current?.parentElement ?? null;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY))
      parent = parent.parentElement;
    scroller.current =
      parent ??
      (document.scrollingElement instanceof HTMLElement
        ? document.scrollingElement
        : document.documentElement);
    documentScroll.current = !parent;
    const scroll = scroller.current;
    const scrollTarget = parent ?? window;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      capture();
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    scrollTarget.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    update();
    return () => {
      scrollTarget.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  React.useLayoutEffect(() => {
    for (const id of measured.current.keys())
      if (!layout.positions.has(id)) measured.current.delete(id);
    const saved = anchor.current;
    const index = saved.id ? layout.positions.get(saved.id) : undefined;
    if (index !== undefined && scroller.current) {
      const difference = layout.offset(index) + saved.offset - readViewport().top;
      if (Math.abs(difference) > 0.5) scroller.current.scrollTop += difference;
    }
    capture();
  });
  React.useLayoutEffect(() => {
    if (selectedIndex < 0 || selectedIndex >= rows.length || !scroller.current) return;
    const top = layout.offset(selectedIndex);
    const bottom = layout.offset(selectedIndex + 1);
    const current = readViewport();
    if (top < current.top) scroller.current.scrollTop += top - current.top;
    else if (bottom > current.top + current.height)
      scroller.current.scrollTop += bottom - current.top - current.height;
    capture();
  }, [selectedIndex, layout]);
  const anchorIndex = anchor.current.id ? layout.positions.get(anchor.current.id) : undefined;
  const effectiveTop =
    anchorIndex === undefined ? viewport.top : layout.offset(anchorIndex) + anchor.current.offset;
  const range = layout.window(Math.max(0, effectiveTop), viewport.height);
  const mounted = new Set<number>();
  for (let i = range.start; i < range.end; i++) mounted.add(i);
  // In an inactive window focus() can change activeElement without a focus event.
  const activeRow = container.current?.contains(document.activeElement)
    ? document.activeElement?.closest<HTMLElement>("[data-virtual-id]")
    : null;
  const focusedId = activeRow?.dataset.virtualId ?? focused;
  const focusIndex = focusedId ? layout.positions.get(focusedId) : undefined;
  if (focusIndex !== undefined) mounted.add(focusIndex);
  if (selectedIndex >= 0 && selectedIndex < rows.length) mounted.add(selectedIndex);
  return (
    <div
      ref={container}
      role="list"
      style={{ height: layout.total, position: "relative", overflowAnchor: "none", flexShrink: 0 }}
      onFocusCapture={(event) =>
        setFocused(
          (event.target as HTMLElement).closest<HTMLElement>("[data-virtual-id]")?.dataset
            .virtualId,
        )
      }
      onBlurCapture={(event) =>
        setFocused(
          (event.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>("[data-virtual-id]")
            ?.dataset.virtualId,
        )
      }
    >
      {[...mounted]
        .sort((a, b) => a - b)
        .map((index) => (
          <MeasuredRow
            key={ids[index]}
            id={ids[index]}
            top={layout.offset(index)}
            index={offset + index}
            total={total}
            measure={measure}
          >
            {render(rows[index], index)}
          </MeasuredRow>
        ))}
    </div>
  );
}
