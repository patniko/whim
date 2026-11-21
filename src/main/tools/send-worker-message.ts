import { defineTool } from '@microsoft/copilot-sdk';
import type { WhimToolContext } from './whim-tool-types';

interface SendWorkerMessageArgs {
  agent_id: string;
  message: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createSendWorkerMessageTool(ctx: WhimToolContext) {
  return defineTool<SendWorkerMessageArgs>('send_whim_worker_message', {
    description:
      'Send a follow-up message to a specific agent worker. Use this to provide guidance, redirect focus, or give additional instructions to a running worker.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent worker to message.',
        },
        message: {
          type: 'string',
          description: 'The follow-up message to send.',
        },
      },
      required: ['agent_id', 'message'],
    },
    skipPermission: true,
    handler: async (args: SendWorkerMessageArgs): Promise<string> => {
      try {
        const result = await ctx.sendChatMessage(args.agent_id, args.message);
        return json(result.error ? { error: result.error } : { ok: true });
      } catch (err: any) {
        return json({ error: err?.message || 'Failed to send worker message' });
      }
    },
  });
}
