import type { ScheduledInvocation } from '../../shared/skill-schedule';

export function buildScheduledInstructions(
  skillName: string,
  intent: string,
  invocation: ScheduledInvocation,
  previousCanvas?: string,
): string {
  const sources = invocation.readOnlyServers.length
    ? invocation.readOnlyServers.map(name => `- ${name}`).join('\n')
    : 'No external sources have been authorized. Do not imply that external sources were searched.';

  return [
    `Run the ${skillName} skill unattended. Nobody is waiting to answer questions or approve tools.`,
    'Read skill-instructions.md in this space: it is the instruction snapshot for this occurrence.',
    intent ? `Additional request:\n${intent}` : '',
    `Scheduled for ${invocation.scheduledAt} (${invocation.timeZone}).`,
    '',
    '## Sources and scope',
    sources,
    'Search every relevant authorized source using its read-only MCP tools. Read thread context before',
    'deciding an item still needs attention. Unread does not necessarily mean unanswered.',
    'Do not send messages, mark source messages read, modify external systems, run shell commands,',
    'or ask for approval. If access is missing or a tool is denied, record that limitation and continue',
    'with the sources you can access. Never report an unavailable source as having no results.',
    invocation.lastSuccessfulAt
      ? `The last successful run completed at ${invocation.lastSuccessfulAt}. Start with that coverage point,`
        + ' overlap the search window to catch late-arriving messages, and explicitly state the actual window searched.'
      : 'For the first run, choose and state a reasonable lookback window for this skill.',
    previousCanvas
      ? `Read the previous result at ${JSON.stringify(previousCanvas)} before assembling this one.`
        + ' Preserve stable source/thread IDs, checked-off or dismissed items, and user-authored drafts.'
        + ' If it is an older report-based space, also read its reports/ files for the previous findings.'
        + ' Do not modify the previous space. Recheck unresolved items and distinguish new findings.'
      : '',
    '',
    '## Result on the space canvas (required)',
    'Use publish_scheduled_result to save the result directly to this space. A chat response alone',
    'does not deliver the result. This output contract takes precedence over any HTML/report-template',
    'publishing directions in the skill: no separate report or canvas window is needed.',
    'Supply Markdown body, a short summary, outcome, and coverage for every authorized source.',
    'For each follow-up include who is waiting, what they need, why it is unresolved, a suggested',
    'next step, and a direct source link. Use checkboxes with stable source references when appropriate.',
    'Use outcome ready for useful complete results, empty only when searches succeeded with nothing',
    'to follow up on, partial when some sources could not be searched, or needs-connection when access',
    'prevented the work. An empty result must still be saved and explain what was searched.',
    'Do not finish until publish_scheduled_result succeeds. Do not overwrite this space using file tools.',
  ].filter(Boolean).join('\n');
}
