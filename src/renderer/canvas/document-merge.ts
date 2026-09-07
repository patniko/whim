import { splitComments, joinComments } from './editor/comments';
import { serializeFrontmatter, tryParseFrontmatter } from '../../shared/frontmatter';
import { mergeInWorker } from './merge-client';

/** Rendered canvases retain disk-authoritative comments/properties; raw text
 * and save acknowledgements merge the whole document without normalization. */
export async function mergeCanvasDocument(
  base: string, local: string, disk: string,
  wholeDocument: boolean, hasFrontmatter: boolean, signal?: AbortSignal,
) {
  const parse = (full: string) => hasFrontmatter ? tryParseFrontmatter(full) : null;
  let full: string;
  let synchronizedDisk = disk;
  if (wholeDocument) {
    full = (await mergeInWorker(base, local, disk, signal)).merged;
  } else {
    const diskParsed = parse(disk);
    const diskSplit = splitComments(diskParsed?.body ?? disk);
    const baseBody = splitComments(parse(base)?.body ?? base).body;
    const localBody = splitComments(parse(local)?.body ?? local).body;
    const body = (await mergeInWorker(baseBody, localBody, diskSplit.body, signal)).merged;
    const diskRegion = joinComments(diskSplit.body, diskSplit.threads);
    synchronizedDisk = hasFrontmatter ? serializeFrontmatter(diskParsed?.frontmatter ?? {}, diskRegion) : diskRegion;
    const region = joinComments(body, diskSplit.threads);
    full = hasFrontmatter ? serializeFrontmatter(diskParsed?.frontmatter ?? {}, region) : region;
  }
  const parsed = parse(full);
  return { full, synchronizedDisk, ...splitComments(parsed?.body ?? full), frontmatter: parsed?.frontmatter };
}
