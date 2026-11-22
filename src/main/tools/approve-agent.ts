import { defineTool } from '@microsoft/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

interface ApproveAgentArgs {
  agent_id: string;
  request_id?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createApproveAgentTool(ctx: WhimToolContext) {
  return defineTool<ApproveAgentArgs>('approve_whim_agent', {
    description:
      'Approve pending permission request(s) on a specific agent worker. If no request_id is provided, approves ALL pending requests on that agent.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent worker whose approvals should be resolved.',
        },
        request_id: {
          type: 'string',
          description: 'Optional specific pending request ID to approve.',
        },
      },
      required: ['agent_id'],
    },
    skipPermission: true,
    handler: async (args: ApproveAgentArgs): Promise<string> => {
      try {
        const agent = ctx.registry.get(args.agent_id);
        if (!agent) {
          return json({ error: `Agent not found: ${args.agent_id}` });
        }

        if (args.request_id) {
          if (!agent.pendingApprovals.has(args.request_id)) {
            return json({ error: `Pending request not found: ${args.request_id}` });
          }

          ctx.broker.resolvePermission(args.agent_id, args.request_id, true);
          return json({ agentId: args.agent_id, approvedCount: 1, requestIds: [args.request_id] });
        }

        const requestIds = Array.from(agent.pendingApprovals.keys());
        for (const requestId of requestIds) {
          ctx.broker.resolvePermission(args.agent_id, requestId, true);
        }

        return json({ agentId: args.agent_id, approvedCount: requestIds.length, requestIds });
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to approve agent requests' });
      }
    },
  });
}
