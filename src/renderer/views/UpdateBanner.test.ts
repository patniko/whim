// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { UpdateState } from '../../shared/types';
import { isUpdateBannerVisible, mountUpdateBanner, unmountUpdateBanner } from './UpdateBanner';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(async () => {
    unmountUpdateBanner();
  });
  delete (window as any).whimAPI;
  document.body.innerHTML = '';
});

describe('UpdateBanner visibility', () => {
  it('only shows actionable update states', () => {
    const visibleStatuses: UpdateState['status'][] = ['available', 'downloading', 'downloaded', 'error'];
    const hiddenStatuses: UpdateState['status'][] = ['idle', 'checking', 'up-to-date', 'disabled'];

    for (const status of visibleStatuses) {
      expect(isUpdateBannerVisible({ status }, false)).toBe(true);
    }

    for (const status of hiddenStatuses) {
      expect(isUpdateBannerVisible({ status }, false)).toBe(false);
    }
  });

  it('stays hidden after dismissal', () => {
    expect(isUpdateBannerVisible({ status: 'available' }, true)).toBe(false);
    expect(isUpdateBannerVisible(null, false)).toBe(false);
  });

  it('renders the download action and reports bottom-bar visibility', async () => {
    const downloadUpdate = vi.fn();
    const visibilityChanges: boolean[] = [];
    (window as any).whimAPI = {
      getUpdateState: () => Promise.resolve({ status: 'available', version: '0.0.16' }),
      onUpdateStateChanged: () => () => {},
      downloadUpdate,
    };

    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      mountUpdateBanner(container, {
        onVisibilityChange: (visible) => visibilityChanges.push(visible),
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    const downloadButton = container.querySelector<HTMLButtonElement>('.update-banner__btn');
    expect(downloadButton?.textContent).toBe('Download');
    expect(visibilityChanges).toContain(true);

    downloadButton?.click();
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });
});
