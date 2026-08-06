/**
 * The instruction contract for canvas-producing runs.
 *
 * Registering a canvas only makes the tools available; nothing about it makes a
 * model use them. Left to its own devices an agent will happily summarise its
 * findings in chat and finish, which for a scheduled run means the work
 * happened and nobody ever sees it. The contract states the obligation
 * explicitly and names the failure modes we care about.
 */
import { WHIM_REPORT_CANVAS_ID, WHIM_CANVAS_PROVIDER_ID } from './sdk-canvas-provider';

/** Appended to a canvas-enabled run's instructions. */
export function buildCanvasContract(): string {
  return [
    '',
    '## Report artifact (required)',
    '',
    `This run must leave behind exactly one report. Whim provides a canvas called \`${WHIM_REPORT_CANVAS_ID}\``,
    `from the \`${WHIM_CANVAS_PROVIDER_ID}\` provider for this.`,
    '',
    '1. Write your report as a single self-contained HTML file inside this space folder,',
    '   for example `report.html`.',
    '2. Call `open_canvas` with that canvas and a `title` describing the report.',
    '3. Call `invoke_canvas_action` with the `publish` action, passing the file path relative to',
    '   the space folder, plus a `title` and a short `status` such as "7 open questions".',
    '4. Do not finish until `publish` has returned successfully.',
    '',
    'Requirements for the HTML:',
    '',
    '- Static HTML and inline CSS only. Scripts, fonts, stylesheets and images loaded over the',
    '  network are blocked when the report is displayed, so anything you link will simply not render.',
    '- Link out with ordinary `<a href="https://...">` links; they open in the browser when clicked.',
    '- Make it skimmable: what was found, why it matters, and where to follow up.',
    '',
    'Two cases people get wrong:',
    '',
    '- If you found nothing, still publish a report that says so. A missing report is',
    '  indistinguishable from a run that failed.',
    '- If `publish` returns an error, say so plainly in your final message and explain what',
    '  failed. Do not finish as if the report exists.',
    '',
    'To refresh a report from an earlier run, reuse the same `artifactId` rather than creating',
    'a new one.',
  ].join('\n');
}

/** Whether an instructions block already carries the contract. */
export function hasCanvasContract(instructions: string): boolean {
  return instructions.includes('## Report artifact (required)');
}

/** Append the contract to a run's instructions, once. */
export function withCanvasContract(instructions: string): string {
  if (hasCanvasContract(instructions)) return instructions;
  return `${instructions.trimEnd()}\n${buildCanvasContract()}\n`;
}
