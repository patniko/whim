/**
 * A canvas backed by a skill's own report template.
 *
 * The built-in `whim-report` canvas asks the model to write HTML. That works,
 * but the output looks different every run and the model spends effort on
 * presentation rather than findings. When a skill ships a template, the model
 * supplies *data* instead: the report looks the same each time, comparisons
 * across runs are meaningful, and every value we substitute is escaped, so
 * markup from a model or an upstream integration cannot reach the page.
 *
 * Data still arrives by reference. The agent writes a JSON file with its
 * ordinary tools and passes the path, for the same reason the built-in canvas
 * takes an HTML path: the runtime persists action input in durable session
 * events and replays it on reconnect.
 */
import * as fs from 'fs';
import { createCanvas, type Canvas } from '@github/copilot-sdk';
import {
  ARTIFACT_FILE,
  CANVASES_DIR,
  MAX_DATA_BYTES,
  bindArtifact,
  getArtifact,
  publishArtifact,
  resolveArtifactDir,
  resolveInsideSpace,
  toArtifactId,
  isValidArtifactId,
  CanvasArtifactError,
  writeArtifactFile,
} from './artifact-store';
import { buildArtifactUrl } from './artifact-protocol';
import { renderSkillCanvas, type SkillCanvasDefinition } from './skill-canvas-template';
import type { CanvasProviderEvents, CanvasRunContext } from './sdk-canvas-provider';

const DEFAULT_ARTIFACT_ID = 'report';

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveArtifactId(
  input: Record<string, unknown> | undefined,
  run: CanvasRunContext,
  fallback = DEFAULT_ARTIFACT_ID,
): string {
  // See `pinnedArtifactId` on CanvasRunContext: the host owns the id for runs
  // where the model cannot know what distinguishes one report from another.
  if (run.pinnedArtifactId) return run.pinnedArtifactId;

  const requested = readString(input, 'artifactId');
  // Validated, not slugified: slugifying makes "Q&A" and "Q A" the same
  // directory, so one report silently overwrites another.
  if (requested) {
    if (!isValidArtifactId(requested)) {
      throw new CanvasArtifactError(
        'invalid_artifact_id',
        `artifactId must be lowercase letters, digits and hyphens (got "${requested}")`,
      );
    }
    return requested;
  }
  const title = readString(input, 'title');
  return title ? toArtifactId(title, fallback) : fallback;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read the model-written JSON payload for a render. */
function readRenderData(run: CanvasRunContext, relativePath: string): Record<string, unknown> {
  const dataPath = resolveInsideSpace(run.workspaceRoot, run.folder, relativePath);
  if (!fs.existsSync(dataPath) || !fs.statSync(dataPath).isFile()) {
    throw new Error(`No data file at ${relativePath}`);
  }
  if (fs.statSync(dataPath).size > MAX_DATA_BYTES) {
    throw new Error(`Data file is over the ${MAX_DATA_BYTES} byte limit`);
  }

  const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The data file must contain a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Build a canvas that renders one skill's template. */
export function createSkillTemplateCanvas(
  run: CanvasRunContext,
  definition: SkillCanvasDefinition,
  events: CanvasProviderEvents = {},
): Canvas {
  return createCanvas({
    id: definition.canvasId,
    displayName: definition.displayName,
    description:
      `${definition.description} Write your findings to a JSON file in the space, then call ` +
      '`render` with its path — this skill supplies the layout, so do not write HTML yourself.' +
      // The model cannot see the template, so without the author's documented
      // shape it is guessing token names and the report renders blank.
      (definition.dataShape
        ? `\n\nThe JSON file must have this shape. Each value below describes what to put ` +
          `there, it is not real data:\n\n${definition.dataShape}`
        : ''),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title shown in the window and the space list.' },
        artifactId: {
          type: 'string',
          description: 'Optional stable id. Reuse it across runs to refresh one report. '
            + 'Lowercase letters, digits and hyphens only.',
        },
        status: { type: 'string', description: 'Short status line, e.g. "7 open questions".' },
      },
    },
    actions: [
      {
        name: 'render',
        description:
          'Render this skill\'s report template from a JSON file you have already written, and ' +
          'publish the result. The path must be relative to the space folder. Call this before finishing.',
        inputSchema: {
          type: 'object',
          required: ['dataPath'],
          properties: {
            dataPath: {
              type: 'string',
              description: 'Path to the JSON payload, relative to the space folder.',
            },
            title: { type: 'string', description: 'Title shown in the window and the space list.' },
            status: { type: 'string', description: 'Short status line, e.g. "7 open questions".' },
            artifactId: { type: 'string', description: 'Report to publish into. Defaults to the opened one.' },
          },
        },
        handler: async ctx => {
          const input = ctx.input as Record<string, unknown> | undefined;
          const relativeDataPath = readString(input, 'dataPath');
          if (!relativeDataPath) {
            return { ok: false, error: 'A relative `dataPath` to the JSON payload is required.' };
          }

          try {
            const artifactId = resolveArtifactId(input, run);
            const title = readString(input, 'title')
              ?? getArtifact(run.workspaceRoot, run.folder, artifactId)?.title
              ?? definition.displayName;
            const data = readRenderData(run, relativeDataPath);
            const html = renderSkillCanvas(definition, data);

            // Render straight into the artifact's own directory so publishing
            // is an import of a file that already lives where it belongs.
            const dir = resolveArtifactDir(run.workspaceRoot, run.folder, artifactId);
            writeArtifactFile(dir, ARTIFACT_FILE, html);

            const { artifact, changed } = await publishArtifact({
              workspaceRoot: run.workspaceRoot,
              folder: run.folder,
              spaceId: run.spaceId,
              artifactId,
              title,
              sourceRelativePath: `${CANVASES_DIR}/${artifactId}/${ARTIFACT_FILE}`,
              dataRelativePath: relativeDataPath,
              ...(readString(input, 'status') !== undefined ? { status: readString(input, 'status') } : {}),
              ...(run.runId ? { runId: run.runId } : {}),
              ...(run.skillId ? { skillId: run.skillId } : {}),
            });

            events.onPublished?.(artifact, { instanceId: ctx.instanceId, run, changed });
            return {
              ok: true,
              artifactId: artifact.artifactId,
              url: buildArtifactUrl(run.spaceId, artifact.artifactId),
              changed,
            };
          } catch (err) {
            // The model has to be able to report a failed render rather than
            // finishing as though the report exists.
            return { ok: false, error: describeError(err) };
          }
        },
      },
    ],
    open: async ctx => {
      const input = ctx.input as Record<string, unknown> | undefined;
      const artifactId = resolveArtifactId(input, run);
      const title = readString(input, 'title') ?? definition.displayName;

      const artifact = await bindArtifact({
        workspaceRoot: run.workspaceRoot,
        folder: run.folder,
        spaceId: run.spaceId,
        artifactId,
        title,
        instanceId: ctx.instanceId,
        canvasId: definition.canvasId,
        ...(run.skillId ? { skillId: run.skillId } : {}),
      });

      events.onBound?.(artifact, { instanceId: ctx.instanceId, run });

      return {
        url: buildArtifactUrl(run.spaceId, artifact.artifactId),
        title: artifact.title,
        status: artifact.published ? (artifact.status ?? 'Ready') : 'Waiting for content',
      };
    },
    onClose: ctx => {
      events.onClosed?.({ instanceId: ctx.instanceId, run });
    },
  });
}
