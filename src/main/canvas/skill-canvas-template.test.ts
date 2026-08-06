import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildSkillCanvasId,
  escapeHtml,
  loadSkillCanvasDefinition,
  renderSkillCanvas,
  renderTemplate,
  resolveSkillCanvasDefinition,
  MAX_TEMPLATE_BYTES,
} from './skill-canvas-template';

let workspace = '';

function writeSkillCanvas(
  skillId: string,
  definition: unknown,
  template: string | null = '<h1>{{title}}</h1>',
): string {
  const dir = path.join(workspace, '.agents', 'skills', skillId, 'canvas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'canvas.json'), typeof definition === 'string' ? definition : JSON.stringify(definition));
  if (template !== null) fs.writeFileSync(path.join(dir, 'template.html'), template);
  return dir;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-skill-canvas-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('renderTemplate', () => {
  it('substitutes a value', () => {
    expect(renderTemplate('<h1>{{title}}</h1>', { title: 'Open questions' })).toBe('<h1>Open questions</h1>');
  });

  it('escapes substituted values, since the data comes from a model', () => {
    const html = renderTemplate('<p>{{body}}</p>', { body: '<script>alert(1)</script>' });

    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes quotes so a value cannot break out of an attribute', () => {
    const html = renderTemplate('<a title="{{t}}">x</a>', { t: '" onmouseover="steal()' });

    expect(html).toBe('<a title="&quot; onmouseover=&quot;steal()">x</a>');
  });

  it('repeats a section over a list, which every report needs', () => {
    const html = renderTemplate('<ul>{{#items}}<li>{{name}}</li>{{/items}}</ul>', {
      items: [{ name: 'One' }, { name: 'Two' }],
    });

    expect(html).toBe('<ul><li>One</li><li>Two</li></ul>');
  });

  it('renders a list of plain values through {{.}}', () => {
    const html = renderTemplate('{{#tags}}<span>{{.}}</span>{{/tags}}', { tags: ['a', 'b'] });

    expect(html).toBe('<span>a</span><span>b</span>');
  });

  it('drops a section whose list is empty', () => {
    expect(renderTemplate('a{{#items}}<li>x</li>{{/items}}b', { items: [] })).toBe('ab');
  });

  it('treats a truthy value as a conditional', () => {
    expect(renderTemplate('{{#ok}}yes{{/ok}}', { ok: true })).toBe('yes');
    expect(renderTemplate('{{#ok}}yes{{/ok}}', { ok: false })).toBe('');
    expect(renderTemplate('{{#ok}}yes{{/ok}}', {})).toBe('');
  });

  it('reaches nested values by path', () => {
    expect(renderTemplate('{{summary.count}}', { summary: { count: 4 } })).toBe('4');
  });

  it('lets an item see the surrounding scope', () => {
    const html = renderTemplate('{{#items}}{{prefix}}:{{name}} {{/items}}', {
      prefix: 'Q',
      items: [{ name: 'one' }, { name: 'two' }],
    });

    expect(html).toBe('Q:one Q:two ');
  });

  it('renders a missing token as empty rather than leaving template syntax visible', () => {
    expect(renderTemplate('<p>{{nope}}</p>', {})).toBe('<p></p>');
  });

  it('renders numbers and booleans but not objects', () => {
    expect(renderTemplate('{{n}}|{{b}}|{{o}}', { n: 3, b: true, o: { a: 1 } })).toBe('3|true|');
  });

  it('nests sections', () => {
    const html = renderTemplate('{{#groups}}<h2>{{name}}</h2>{{#items}}<li>{{q}}</li>{{/items}}{{/groups}}', {
      groups: [{ name: 'Blocked', items: [{ q: 'Why?' }] }],
    });

    expect(html).toBe('<h2>Blocked</h2><li>Why?</li>');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could change markup', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('loadSkillCanvasDefinition', () => {
  it('loads a definition and namespaces its id by the owning skill', () => {
    writeSkillCanvas('open-questions', { id: 'digest', displayName: 'Digest', description: 'A digest' });

    const definition = loadSkillCanvasDefinition(workspace, 'open-questions');

    expect(definition).toMatchObject({
      canvasId: 'skill.open-questions.digest',
      templateId: 'digest',
      displayName: 'Digest',
      description: 'A digest',
    });
  });

  it('returns null when the skill ships no canvas', () => {
    expect(loadSkillCanvasDefinition(workspace, 'plain-skill')).toBeNull();
  });

  it('returns null when the definition is not valid JSON', () => {
    writeSkillCanvas('broken', '{not json');

    expect(loadSkillCanvasDefinition(workspace, 'broken')).toBeNull();
  });

  it('returns null when the template file is missing', () => {
    writeSkillCanvas('no-template', { id: 'digest' }, null);

    expect(loadSkillCanvasDefinition(workspace, 'no-template')).toBeNull();
  });

  it('rejects an id that could collide with the built-in namespace', () => {
    writeSkillCanvas('bad-id', { id: 'Not Valid!' });

    expect(loadSkillCanvasDefinition(workspace, 'bad-id')).toBeNull();
  });

  it('refuses a template outside the skill\'s own canvas folder', () => {
    writeSkillCanvas('escaper', { id: 'digest', template: '../../../../etc/passwd' });

    expect(loadSkillCanvasDefinition(workspace, 'escaper')).toBeNull();
  });

  it('refuses a template larger than the limit', () => {
    writeSkillCanvas('huge', { id: 'digest' }, 'x'.repeat(MAX_TEMPLATE_BYTES + 1));

    expect(loadSkillCanvasDefinition(workspace, 'huge')).toBeNull();
  });

  it('defaults the id and template name so a minimal definition works', () => {
    writeSkillCanvas('minimal', {});

    expect(loadSkillCanvasDefinition(workspace, 'minimal')).toMatchObject({
      templateId: 'report',
      canvasId: buildSkillCanvasId('minimal', 'report'),
    });
  });
});

describe('resolveSkillCanvasDefinition', () => {
  it('accepts the short id a skill writes in its frontmatter', () => {
    writeSkillCanvas('questions', { id: 'digest' });

    expect(resolveSkillCanvasDefinition(workspace, 'questions', 'digest')?.templateId).toBe('digest');
  });

  it('accepts the namespaced id the runtime sees', () => {
    writeSkillCanvas('questions', { id: 'digest' });

    expect(resolveSkillCanvasDefinition(workspace, 'questions', 'skill.questions.digest')).not.toBeNull();
  });

  it('refuses a declared id the skill does not actually ship', () => {
    writeSkillCanvas('questions', { id: 'digest' });

    expect(resolveSkillCanvasDefinition(workspace, 'questions', 'something-else')).toBeNull();
  });
});

describe('renderSkillCanvas', () => {
  it('renders the skill\'s own template', () => {
    writeSkillCanvas('questions', { id: 'digest' }, '<h1>{{title}}</h1><ul>{{#items}}<li>{{q}}</li>{{/items}}</ul>');
    const definition = loadSkillCanvasDefinition(workspace, 'questions')!;

    const html = renderSkillCanvas(definition, { title: 'Open questions', items: [{ q: 'Ship it?' }] });

    expect(html).toBe('<h1>Open questions</h1><ul><li>Ship it?</li></ul>');
  });
});
