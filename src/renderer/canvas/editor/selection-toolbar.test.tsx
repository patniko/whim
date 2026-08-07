// @vitest-environment happy-dom
//
// The selection toolbar is the only route to commenting, forking and extracting
// a passage, and until recently it was mouse-only. These lock in that every
// item is reachable from the keyboard and that the accelerators live and die
// with the selection rather than staying armed over the whole document.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { SelectionToolbar } from './CommentUI';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RECT = { left: 40, top: 40, width: 80, height: 16, right: 120, bottom: 56 };

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<React.ComponentProps<typeof SelectionToolbar>>) {
  const merged = {
    rect: RECT,
    onFormat: vi.fn(),
    onComment: vi.fn(),
    ...props,
  } as React.ComponentProps<typeof SelectionToolbar>;
  act(() => { root.render(<SelectionToolbar {...merged} />); });
  return merged;
}

/** Dispatch a Cmd+Shift+<key> chord, as macOS reports it. */
function press(key: string, opts: { shift?: boolean } = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: true,
      shiftKey: opts.shift ?? false,
      bubbles: true,
      cancelable: true,
    }));
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('SelectionToolbar', () => {
  it('starts a comment from the keyboard', () => {
    const onComment = vi.fn();
    render({ onComment });

    press('m', { shift: true });

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it('runs fork and extract from the keyboard when they are offered', () => {
    const onFork = vi.fn();
    const onExtract = vi.fn();
    render({ onFork, onExtract });

    press('f', { shift: true });
    press('o', { shift: true });

    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onExtract).toHaveBeenCalledTimes(1);
  });

  it('leaves bold and italic to the editor keymap', () => {
    const onFormat = vi.fn();
    render({ onFormat });

    press('b');
    press('i');

    expect(onFormat).not.toHaveBeenCalled();
  });

  it('claims the marks the editor keymap does not provide', () => {
    const onFormat = vi.fn();
    render({ onFormat });

    press('x', { shift: true });
    press('e');

    expect(onFormat).toHaveBeenCalledWith('strikethrough');
    expect(onFormat).toHaveBeenCalledWith('inlineCode');
  });

  it('stops listening once the selection is gone', () => {
    const onComment = vi.fn();
    render({ onComment });
    act(() => { root.render(<></>); });

    press('m', { shift: true });

    expect(onComment).not.toHaveBeenCalled();
  });

  it('walks the buttons with the arrow keys', () => {
    render({ onFork: vi.fn() });
    const toolbar = document.querySelector('.md-selection-toolbar') as HTMLElement;
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    buttons[0].focus();

    act(() => {
      toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(document.activeElement).toBe(buttons[1]);
  });

  it('names every action for screen readers and shows its shortcut', () => {
    render({ onFork: vi.fn(), onExtract: vi.fn() });
    const buttons = Array.from(document.querySelectorAll('.md-selection-toolbar button'));

    expect(buttons).toHaveLength(7);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.getAttribute('title')).toMatch(/\(⌘/);
    }
  });
});
