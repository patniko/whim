/** Viewport-space rectangle (subset of DOMRect) used to position floating UI. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** Selection info surfaced to the host for the selection toolbar. */
export interface SelectionInfo {
  text: string;
  from: number;
  to: number;
  rect: Rect;
}

/** Active `@`-mention query surfaced to the host for the suggestion popup. */
export interface MentionQuery {
  query: string;
  from: number;
  to: number;
  rect: Rect;
}

/** Inline formatting marks supported by the editor controls. */
export type FormatMark = 'strong' | 'emphasis' | 'inlineCode' | 'strikethrough';
