import { defineTool } from '@microsoft/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

interface SetYoloAgentArgs {
  agent_id: string;
  enabled: boolean;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createSetYoloAgentTool(ctx: WhimToolContext) {
  return defineTool<SetYoloAgentArgs>('set_yolo_whim_agent', {
    description:
      'Enable or disable yolo mode (automatic approval of all permission requests) on a specific agent worker.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent worker to update.',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether yolo mode should be enabled.',
        },
      },
      required: ['agent_id', 'enabled'],
    },
    skipPermission: true,
    handler: async (args: SetYoloAgentArgs): Promise<string> => {
      try {
        return json(await ctx.setYoloMode(args.agent_id, args.enabled));
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to update yolo mode' });
      }
    },
  });
}
