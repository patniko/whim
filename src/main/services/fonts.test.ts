import { describe, expect, it, vi } from 'vitest';
import { getFonts } from 'font-list';
import { listInstalledFonts } from './fonts';

vi.mock('font-list', () => ({ getFonts: vi.fn() }));

describe('listInstalledFonts', () => {
  it('requests unquoted OS family names and removes duplicate styles', async () => {
    vi.mocked(getFonts).mockResolvedValue(['Apex Serif', 'Arial', 'Apex Serif']);
    expect(await listInstalledFonts()).toEqual(['Apex Serif', 'Arial']);
    expect(getFonts).toHaveBeenCalledWith({ disableQuoting: true });
  });

  it('surfaces enumeration errors', async () => {
    vi.mocked(getFonts).mockRejectedValue(new Error('OS query failed'));
    await expect(listInstalledFonts()).rejects.toThrow('OS query failed');
  });

  it('treats an empty helper result as a failure', async () => {
    vi.mocked(getFonts).mockResolvedValue([]);
    await expect(listInstalledFonts()).rejects.toThrow('No installed fonts');
  });
});
