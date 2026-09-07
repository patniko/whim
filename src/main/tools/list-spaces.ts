import { defineTool } from '@github/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

type EmptyArgs = Record<string, never>;

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createListSpacesTool(ctx: WhimToolContext) {
  return defineTool<EmptyArgs>('list_whim_spaces', {
    description:
      "List all spaces (intents) in the current workspace. Shows each space's ID, description, status, and whether an agent is actively working on it.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    skipPermission: true,
    handler: async (): Promise<string> => {
      try {
        const spaces = (await ctx.getSpaces()).map((space) => {
          const workers = Array.from(ctx.registry.values()).filter((agent) => agent.spaceId === space.id);
          const activeWorkers = workers.filter(
            (agent) => agent.status === 'running' || agent.status === 'waiting-approval',
          );

          return {
            id: space.id,
            description: space.description,
            status: space.status,
            folder: space.folder,
            hasActiveWorker: activeWorkers.length > 0,
            activeWorkerCount: activeWorkers.length,
            activeWorkerIds: activeWorkers.map((agent) => agent.agentId),
          };
        });

        return json({ spaces });
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to list spaces' });
      }
    },
  });
}
