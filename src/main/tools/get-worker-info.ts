import { defineTool } from '@microsoft/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

interface GetWorkerInfoArgs {
  agent_id: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function summarizeEvent(event: any): { type: string; summary: string } | null {
  const data = event?.data ?? event ?? {};
  const type = data.type ?? event?.type;

  if (type === 'assistant.message') {
    const content = data.content ?? data.message ?? '';
    return {
      type,
      summary: truncate(content || 'Assistant responded'),
    };
  }

  if (type === 'tool_call' || type === 'tool.start' || type === 'tool.execution_start') {
    const toolName = data.toolName ?? data.name ?? 'unknown_tool';
    return {
      type: 'tool_call',
      summary: `Called ${toolName}`,
    };
  }

  return null;
}

export function createGetWorkerInfoTool(ctx: WhimToolContext) {
  return defineTool<GetWorkerInfoArgs>('get_whim_worker_info', {
    description:
      'Get detailed information about a specific agent worker, including its original goal, current status, pending approvals, and recent activity summary.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent worker to inspect.',
        },
      },
      required: ['agent_id'],
    },
    skipPermission: true,
    handler: async (args: GetWorkerInfoArgs): Promise<string> => {
      try {
        const agent = ctx.registry.get(args.agent_id);
        if (!agent) {
          return json({ error: `Agent not found: ${args.agent_id}` });
        }

        const history = await ctx.getAgentHistory(args.agent_id);
        const pendingApprovals = Array.from(agent.pendingApprovals.entries()).map(([requestId, approval]) => ({
          requestId,
          permissionKind: approval.permissionKind,
          intention: approval.intention,
          path: approval.path,
        }));

        const result: Record<string, unknown> = {
          agentId: agent.agentId,
          spaceId: agent.spaceId,
          status: agent.status,
          originalGoal: agent.selectedText,
          summary: agent.summary,
          yoloMode: agent.yoloMode ?? false,
          remote: agent.remote ?? { enabled: false, remoteSteerable: false },
          pendingApprovals,
          recentActivity: [],
        };

        if ('error' in history) {
          result.historyError = history.error;
          return json(result);
        }

        result.restarted = history.restarted ?? false;
        result.recentActivity = history.events
          .map((event) => summarizeEvent(event))
          .filter((event): event is { type: string; summary: string } => !!event)
          .slice(-5);

        return json(result);
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to get worker info' });
      }
    },
  });
}
