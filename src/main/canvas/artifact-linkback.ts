/**
 * Writing a published report back into the document that asked for it.
 *
 * A report the user cannot find is the same as no report. The space list grows
 * a chip and the tray lists it, but the user asked for this one from inside a
 * document — that document is where they will look for the answer, so the link
 * goes there.
 *
 * Whim writes the link rather than instructing the agent to, for the same
 * reason the canvas contract exists at all: an agent that publishes and then
 * forgets to link has produced output nobody sees, and that failure is
 * invisible from the outside. Doing it host-side makes it unconditional.
 */
import * as fs from 'fs';
import { notifyAllWindows } from '../notify';
import { readCanvas, resolvePagePath, writePage } from '../workspace';
import { writeEditorFileWithMerge, writeMainCanvasWithMerge } from '../services/canvas-editor-state';

/** Heading of the section links are collected under. */
export const REPORTS_HEADING = '## Reports';

export interface ArtifactLink {
  spaceId: string;
  artifactId: string;
  title: string;
  status?: string;
}

/** The `whim://` URL that opens a report from a document. */
export function buildArtifactLinkUrl(spaceId: string, artifactId: string): string {
  return `whim://artifact/${encodeURIComponent(spaceId)}/${encodeURIComponent(artifactId)}`;
}

/** Escape the characters that would break out of a markdown link label. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1').replace(/\r?\n/g, ' ').trim();
}

/** Render one report as a list item. */
export function buildArtifactLinkLine(link: ArtifactLink): string {
  const label = escapeLinkText(link.title) || 'Report';
  const suffix = link.status ? ` — ${escapeLinkText(link.status)}` : '';
  return `- [${label}](${buildArtifactLinkUrl(link.spaceId, link.artifactId)})${suffix}`;
}

/**
 * Insert or refresh a report's link in a document.
 *
 * Matching is on the URL, not the title: a refreshed report keeps its id and
 * changes its title, so matching on the label would leave the document
 * accumulating a line per run all pointing at the same report.
 */
export function upsertArtifactLink(document: string, link: ArtifactLink): string {
  const line = buildArtifactLinkLine(link);
  const url = buildArtifactLinkUrl(link.spaceId, link.artifactId);
  const lines = document.split('\n');

  const existing = lines.findIndex(l => l.includes(url));
  if (existing !== -1) {
    if (lines[existing] === line) return document;
    lines[existing] = line;
    return lines.join('\n');
  }

  const headingIndex = lines.findIndex(l => l.trim() === REPORTS_HEADING);
  if (headingIndex === -1) {
    const body = document.replace(/\s+$/, '');
    const separator = body === '' ? '' : '\n\n';
    return `${body}${separator}${REPORTS_HEADING}\n\n${line}\n`;
  }

  // Append below the last list item of the section, so the newest report is at
  // the bottom and anything the user wrote under the heading stays put.
  let insertAt = headingIndex + 1;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim() !== '') insertAt = i + 1;
  }
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

export interface LinkArtifactParams {
  workspaceRoot: string;
  /** Real space id — never a synthetic page id. */
  spaceId: string;
  folder: string;
  link: ArtifactLink;
  /**
   * Page the comment was left on, when it was a child page rather than the
   * space's main canvas. The link follows the user to where they were reading.
   */
  pageName?: string;
}

/**
 * Write a report's link into the document the run was launched from.
 *
 * Both paths go through the editor merge helpers rather than writing the file
 * directly. The user is very likely still typing in this document — the run was
 * started from a comment on it — and a blind write would silently discard
 * whatever they added while the agent was working.
 */
export function linkArtifactIntoDocument(params: LinkArtifactParams): boolean {
  const { workspaceRoot, spaceId, folder, link, pageName } = params;

  try {
    if (pageName) {
      const resolved = resolvePagePath(workspaceRoot, folder, pageName);
      if ('error' in resolved) return false;

      const current = fs.existsSync(resolved.path) ? fs.readFileSync(resolved.path, 'utf-8') : '';
      const updated = upsertArtifactLink(current, link);
      if (updated === current) return false;

      const editorId = `__page__${spaceId}/${encodeURIComponent(pageName)}`;
      const result = writeEditorFileWithMerge(editorId, resolved.path, updated, contentToWrite => {
        const write = writePage(workspaceRoot, folder, pageName, contentToWrite);
        if ('error' in write) throw new Error(write.error);
      });
      if (!result.success) return false;

      // Child pages have no file watcher, so an open editor only learns about
      // this if we tell it.
      notifyAllWindows('canvas:content-updated', {
        spaceId: editorId,
        content: result.content ?? updated,
      });
      return true;
    }

    const current = readDocument(workspaceRoot, folder);
    const updated = upsertArtifactLink(current, link);
    if (updated === current) return false;

    return writeMainCanvasWithMerge(workspaceRoot, spaceId, folder, updated).success;
  } catch (err: any) {
    // A report that published but could not be linked is still a report. Log
    // and move on rather than failing the run over its last step.
    console.warn(`[canvas] could not link report ${link.artifactId} into space ${spaceId}: ${err?.message ?? err}`);
    return false;
  }
}

function readDocument(workspaceRoot: string, folder: string): string {
  try {
    return readCanvas(workspaceRoot, folder);
  } catch {
    return '';
  }
}
