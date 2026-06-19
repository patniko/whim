import React, { useEffect, useState, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpdateState } from '../../shared/types';

function getApi(): any {
  return typeof window === 'undefined' ? undefined : (window as any).whimAPI;
}

interface UpdateBannerProps {
  onVisibilityChange?: (visible: boolean) => void;
}

export function isUpdateBannerVisible(state: UpdateState | null, dismissed: boolean): boolean {
  if (!state || dismissed) return false;
  return state.status === 'available'
    || state.status === 'downloading'
    || state.status === 'downloaded'
    || state.status === 'error';
}

function UpdateBanner({ onVisibilityChange }: UpdateBannerProps) {
  const api = getApi();
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Seed from the current state in case an event (e.g. an early error or a
    // ready-to-install update) fired before this component mounted.
    const currentState = api?.getUpdateState?.();
    currentState?.then((s: UpdateState) => {
      setState((prev) => prev ?? s);
    }).catch(() => {});

    if (!api?.onUpdateStateChanged) return;
    const unsub = api.onUpdateStateChanged((s: UpdateState) => {
      setState(s);
      // Re-show the banner whenever a new actionable state arrives.
      if (s.status === 'available' || s.status === 'downloaded' || s.status === 'error') {
        setDismissed(false);
      }
    });
    return unsub;
  }, [api]);

  const handleInstall = useCallback(() => {
    api?.installUpdate();
  }, [api]);

  const handleDownload = useCallback(() => {
    api?.downloadUpdate();
  }, [api]);

  const handleRetry = useCallback(() => {
    api?.checkForUpdate();
  }, [api]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const visible = isUpdateBannerVisible(state, dismissed);

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [onVisibilityChange, visible]);

  useEffect(() => {
    return () => onVisibilityChange?.(false);
  }, [onVisibilityChange]);

  if (!visible || !state) return null;

  const { status, version, progress, error } = state;

  if (status === 'available') {
    return (
      <div className="update-banner update-banner--available">
        <span className="update-banner__text">
          A new version{version ? ` (v${version})` : ''} is available
        </span>
        <button type="button" className="update-banner__btn" onClick={handleDownload}>Download</button>
        <button type="button" className="update-banner__dismiss" onClick={handleDismiss} title="Dismiss">✕</button>
      </div>
    );
  }

  if (status === 'downloading') {
    return (
      <div className="update-banner update-banner--downloading">
        <span className="update-banner__text">
          Downloading update{version ? ` (v${version})` : ''}… {progress != null ? `${progress}%` : ''}
        </span>
        <div className="update-banner__progress">
          <div className="update-banner__progress-bar" style={{ width: `${progress ?? 0}%` }} />
        </div>
      </div>
    );
  }

  if (status === 'downloaded') {
    return (
      <div className="update-banner update-banner--ready">
        <span className="update-banner__text">
          Update ready{version ? ` (v${version})` : ''} — restart to apply
        </span>
        <button type="button" className="update-banner__btn" onClick={handleInstall}>Restart Now</button>
        <button type="button" className="update-banner__btn update-banner__btn--ghost" onClick={handleDismiss}>Later</button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="update-banner update-banner--error">
        <span className="update-banner__text">
          Update failed{error ? `: ${error}` : ''}
        </span>
        <button type="button" className="update-banner__btn" onClick={handleRetry}>Retry</button>
        <button type="button" className="update-banner__dismiss" onClick={handleDismiss} title="Dismiss">✕</button>
      </div>
    );
  }

  // idle / checking / up-to-date / disabled are surfaced in Settings, not as a banner.
  return null;
}

let root: Root | null = null;

export function mountUpdateBanner(container: HTMLElement, props: UpdateBannerProps = {}): void {
  if (root) root.unmount();
  root = createRoot(container);
  root.render(<UpdateBanner {...props} />);
}

export function unmountUpdateBanner(): void {
  if (root) {
    root.unmount();
    root = null;
  }
}
