import { getFonts } from 'font-list';
import { installedFontFamilies } from '../../shared/fonts';

export async function listInstalledFonts(): Promise<string[]> {
  const families = installedFontFamilies(await getFonts({ disableQuoting: true }));
  // Some platform helpers report failure as an empty list.
  if (families.length === 0) throw new Error('No installed fonts could be read from the operating system');
  return families;
}
