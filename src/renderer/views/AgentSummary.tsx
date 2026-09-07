import React from 'react';
import { spaceStore } from '../state/space-store';
import { agentStore } from '../state/agent-store';
import { useStore } from './useStore';

/**
 * Summary banner above the Agents list. Mirrors renderAgentSummary() in
 * legacy app.ts. Visibility is controlled by the parent (it only renders
 * when the Agents filter is active).
 */
export function AgentSummary(): React.ReactElement {
  const { spaces, page: spacePage } = useStore(spaceStore);
  const { agents, page } = useStore(agentStore);

  const running = page ? page.counts.running + page.counts.waiting : agents.filter(a => a.status === 'running' || a.status === 'waiting-approval').length;
  const completed = page?.counts.completed ?? agents.filter(a => a.status === 'completed').length;
  const failed = page?.counts.failed ?? agents.filter(a => a.status !== 'running' && a.status !== 'waiting-approval' && a.status !== 'completed').length;
  const openTasks = spacePage?.counts.open ?? spaces.filter(s => s.status !== 'done').length;
  const scheduled = spacePage?.counts.scheduled ?? spaces.filter(s => s.due_at_utc || s.due_at).length;
  const recurring = spacePage?.counts.recurring ?? spaces.filter(s => s.recurrence).length;

  const lines: string[] = [];

  if (running + completed + failed === 0) {
    lines.push('No agents are active right now.');
  } else {
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} ${running === 1 ? 'agent is' : 'agents are'} currently working`);
    if (completed > 0) parts.push(`${completed} recently completed`);
    if (failed > 0) parts.push(`${failed} need${failed === 1 ? 's' : ''} attention`);
    if (parts.length > 0) lines.push(parts.join(', and ') + '.');
  }

  const taskParts: string[] = [];
  if (openTasks > 0) taskParts.push(`${openTasks} open ${openTasks === 1 ? 'task' : 'tasks'}`);
  if (scheduled > 0) taskParts.push(`${scheduled} scheduled ${scheduled === 1 ? 'item' : 'items'} coming up`);
  if (recurring > 0) taskParts.push(`${recurring} recurring`);

  if (taskParts.length > 0) {
    lines.push('You have ' + taskParts.join(", and there's ") + '.');
  }

  return (
    <>
      <div className="agent-summary-header">
        <span className="summary-icon">✦</span>
        Summary
      </div>
      <div className="agent-summary-body">
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <br /> : null}
            {line}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}
