import React from 'react';
import { spaceStore } from '../state/space-store';
import { useStore } from './useStore';
import { formatDueDate } from './list-utils';

export interface FocusBannerProps {
  onComplete: (spaceId: string) => void;
  onClear: () => void;
}

/**
 * "Focused space" banner. Mirrors updateFocusBanner() in legacy app.ts.
 * The component renders its contents only when a space is focused; when
 * unfocused it renders the standard "hidden" structure so CSS visibility
 * stays consistent with the legacy markup.
 */
export function FocusBanner({ onComplete, onClear }: FocusBannerProps): React.ReactElement {
  const { focusedSummary: focused } = useStore(spaceStore);

  if (!focused) {
    return <div className="focus-banner hidden" />;
  }

  const dueInfo = formatDueDate(focused.due_at_utc, focused.due_at);
  const hasDue = dueInfo.text !== '';

  return (
    <div className="focus-banner">
      <div className="focus-label">🎯 FOCUSED</div>
      <div className="focus-content">
        <div className="focus-desc">{focused.description}</div>
        <div className="focus-meta">
          {focused.client ? <span>👤 {focused.client}</span> : null}
          {hasDue ? <span className={`due-badge ${dueInfo.overdue ? 'overdue' : ''}`}>📅 {dueInfo.text}</span> : null}
        </div>
      </div>
      <button type="button" className="focus-action" title="Complete" onClick={() => onComplete(focused.id)}>✓</button>
      <button type="button" className="focus-action" title="Unfocus" onClick={onClear}>✕</button>
    </div>
  );
}
