/**
 * Skill-defined report templates.
 *
 * A skill can ship its own look for a report instead of asking the model to
 * hand-write HTML every run:
 *
 *   .agents/skills/<slug>/canvas/canvas.json    definition
 *   .agents/skills/<slug>/canvas/template.html  markup with {{tokens}}
 *
 * The model then supplies *data* rather than markup, which is both easier for
 * it to get right and far safer for us to render: every substituted value is
 * HTML-escaped, so nothing the model or an upstream integration produces can
 * inject markup into the report.
 */
import * as fs from 'fs';
import * as path from 'path';

export const SKILL_CANVAS_DIR = 'canvas';
export const SKILL_CANVAS_DEFINITION = 'canvas.json';
export const DEFAULT_TEMPLATE_FILE = 'template.html';

/** Hard ceiling on a template. Templates are authored, not generated. */
export const MAX_TEMPLATE_BYTES = 512 * 1024;

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface SkillCanvasDefinition {
  /** Canvas id as whim exposes it, namespaced by the owning skill. */
  canvasId: string;
  /** Id as the skill declared it, before namespacing. */
  templateId: string;
  skillId: string;
  displayName: string;
  description: string;
  /** Absolute path to the template file. */
  templatePath: string;
}

/**
 * Namespace a skill's template id.
 *
 * Skills are authored independently and will collide on obvious names like
 * "report", so the owning skill is part of the id the runtime sees.
 */
export function buildSkillCanvasId(skillId: string, templateId: string): string {
  return `skill.${skillId}.${templateId}`;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Load a skill's canvas definition, or `null` if it does not ship one or the
 * one it ships is unusable.
 *
 * Every rejection is logged: a skill author who mistypes a filename should find
 * out from the log rather than from a report that silently never appears.
 */
export function loadSkillCanvasDefinition(
  workspaceRoot: string,
  skillId: string,
): SkillCanvasDefinition | null {
  const canvasDir = path.join(workspaceRoot, '.agents', 'skills', skillId, SKILL_CANVAS_DIR);
  const definitionPath = path.join(canvasDir, SKILL_CANVAS_DEFINITION);
  if (!fs.existsSync(definitionPath)) return null;

  const definition = readJson(definitionPath);
  if (!definition) {
    console.warn(`[canvas] skill "${skillId}" has an unreadable ${SKILL_CANVAS_DEFINITION}`);
    return null;
  }

  const templateId = readString(definition, 'id') ?? 'report';
  if (!TEMPLATE_ID_RE.test(templateId)) {
    console.warn(`[canvas] skill "${skillId}" declares an invalid canvas id "${templateId}"`);
    return null;
  }

  const templateFile = readString(definition, 'template') ?? DEFAULT_TEMPLATE_FILE;
  // Confine the template to the skill's own canvas directory: a definition is
  // just a file in the workspace, and `../../` in it must not reach elsewhere.
  const templatePath = path.resolve(canvasDir, templateFile);
  const relative = path.relative(canvasDir, templatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    console.warn(`[canvas] skill "${skillId}" points at a template outside its canvas folder`);
    return null;
  }

  if (!fs.existsSync(templatePath) || !fs.statSync(templatePath).isFile()) {
    console.warn(`[canvas] skill "${skillId}" is missing its template at ${templateFile}`);
    return null;
  }

  if (fs.statSync(templatePath).size > MAX_TEMPLATE_BYTES) {
    console.warn(`[canvas] skill "${skillId}" ships a template over ${MAX_TEMPLATE_BYTES} bytes`);
    return null;
  }

  return {
    canvasId: buildSkillCanvasId(skillId, templateId),
    templateId,
    skillId,
    displayName: readString(definition, 'displayName') ?? readString(definition, 'name') ?? 'Report',
    description: readString(definition, 'description')
      ?? 'A report rendered from this skill\'s own template.',
    templatePath,
  };
}

/**
 * Resolve the template a run should use, given what its skill declared.
 *
 * A skill names its canvas in `SKILL.md` frontmatter, but the id whim exposes
 * is namespaced, so both spellings are accepted. A declared id that matches
 * nothing returns `null` and the caller falls back to the built-in report
 * rather than launching with a canvas the agent cannot open.
 */
export function resolveSkillCanvasDefinition(
  workspaceRoot: string,
  skillId: string,
  declaredCanvasId: string,
): SkillCanvasDefinition | null {
  const definition = loadSkillCanvasDefinition(workspaceRoot, skillId);
  if (!definition) return null;

  if (declaredCanvasId === definition.templateId || declaredCanvasId === definition.canvasId) {
    return definition;
  }

  console.warn(
    `[canvas] skill "${skillId}" declares canvas "${declaredCanvasId}" but ships "${definition.templateId}"`,
  );
  return null;
}

/** Escape a value for insertion into HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function lookup(scope: Record<string, unknown>, token: string): unknown {
  if (token === '.') return scope;
  let current: unknown = scope;
  for (const part of token.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const SECTION_RE = /\{\{#([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const TOKEN_RE = /\{\{([a-zA-Z0-9_.]+|\.)\}\}/g;

/**
 * Render a template against a data object.
 *
 * Two constructs, deliberately: `{{token}}` for a value and
 * `{{#list}}…{{/list}}` for repetition, which every report needs. Anything
 * richer would be a templating language, and a templating language whose input
 * comes from a model is a liability rather than a feature.
 *
 * A token with no matching data renders as empty rather than leaving `{{x}}`
 * visible in the report — a gap in a report reads as "nothing found", which is
 * true, whereas raw template syntax reads as a bug.
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  const renderScope = (body: string, scope: Record<string, unknown>): string =>
    body
      .replace(SECTION_RE, (_match, token: string, inner: string) => {
        const value = lookup(scope, token);

        if (Array.isArray(value)) {
          return value
            .map(item => renderScope(
              inner,
              item !== null && typeof item === 'object'
                ? { ...scope, ...item as Record<string, unknown>, '.': item }
                : { ...scope, '.': item },
            ))
            .join('');
        }

        // A non-array truthy value makes the section a conditional, which is
        // what an author writing {{#hasFindings}} expects.
        if (value === null || value === undefined || value === false || value === '') return '';
        if (typeof value === 'object') return renderScope(inner, { ...scope, ...value as Record<string, unknown> });
        return renderScope(inner, scope);
      })
      .replace(TOKEN_RE, (_match, token: string) => {
        const raw = token === '.' ? scope['.'] : lookup(scope, token);
        return escapeHtml(stringify(raw));
      });

  return renderScope(template, data);
}

/** Render a definition's template against data read from the run. */
export function renderSkillCanvas(
  definition: SkillCanvasDefinition,
  data: Record<string, unknown>,
): string {
  return renderTemplate(fs.readFileSync(definition.templatePath, 'utf-8'), data);
}
