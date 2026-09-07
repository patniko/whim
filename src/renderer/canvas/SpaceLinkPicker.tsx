import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getAPI } from '../ipc-client';
import { PageControls } from '../views/PageControls';
import type { SpacePage } from '../../shared/paging';

export interface SpaceResult {
  id: string;
  description: string;
  status: string;
}

interface SpaceLinkPickerProps {
  onSelect: (space: SpaceResult) => void;
  onDismiss: () => void;
}

export function SpaceLinkPicker({ onSelect, onDismiss }: SpaceLinkPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SpaceResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState<SpacePage | null>(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const generation = ++request.current;
    const result = await getAPI().listSpacePage({ query, cursor, filter: 'all' });
    if (generation !== request.current) return;
    setPage(result);
    setResults(result.items);
    setSelectedIndex(0);
  }, [query]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    request.current++;
    const timer = setTimeout(() => {
      setError('');
      void loadPage().catch(failure => setError(failure instanceof Error ? failure.message : 'Search failed'));
    }, 200);
    return () => { clearTimeout(timer); request.current++; };
  }, [loadPage]);

  // Click outside to dismiss
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onDismiss]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        onSelect(results[selectedIndex]);
      }
    }
  }, [results, selectedIndex, onSelect, onDismiss]);

  // Scroll selected item into view
  useEffect(() => {
    const el = containerRef.current?.querySelector('.space-link-picker-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div className="space-link-picker-overlay">
      <div className="space-link-picker" ref={containerRef}>
        <input
          ref={inputRef}
          className="space-link-picker-input"
          type="text"
          placeholder="Search spaces to link…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="space-link-picker-results">
          {error && <p role="alert">{error}</p>}
          {results.length === 0 && query && (
            <div className="space-link-picker-empty">No spaces found</div>
          )}
          {results.map((space, i) => (
            <div
              key={space.id}
              className={`space-link-picker-item${i === selectedIndex ? ' selected' : ''}${space.status === 'done' ? ' done' : ''}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => onSelect(space)}
            >
              <span className="space-link-picker-status">
                {space.status === 'done' ? '✓' : '○'}
              </span>
              <span className="space-link-picker-desc">{space.description || 'Untitled'}</span>
            </div>
          ))}
        </div>
        {page && <PageControls nextCursor={page.nextCursor} scope={query} load={loadPage} />}
      </div>
    </div>
  );
}
