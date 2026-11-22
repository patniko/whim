import { defineTool } from '@microsoft/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

type EmptyArgs = Record<string, never>;

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createListWorkersTool(ctx: WhimToolContext) {
  return defineTool<EmptyArgs>('list_whim_workers', {
    description:
      "List all active agent workers in the workspace. Shows each worker's ID, space, status, yolo mode, pending approval count, and summary.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    skipPermission: true,
    handler: async (): Promise<string> => {
      try {
        const workers = Array.from(ctx.registry.values())
          .filter((agent) => agent.agentId !== ctx.agentId)
          .map((agent) => ({
            agentId: agent.agentId,
            spaceId: agent.spaceId,
            status: agent.status,
            summary: agent.summary,
            yoloMode: agent.yoloMode ?? false,
            pendingApprovalCount: agent.pendingApprovals.size,
            remoteEnabled: agent.remote?.enabled ?? false,
          }));

        return json({ workers });
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to list workers' });
      }
    },
  });
}
