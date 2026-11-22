import { defineTool } from '@microsoft/copilot-sdk';
import type { InteractionBroker } from '../agents/interaction-broker';

interface AskUserRegistryRecord {
  agentId: string;
  spaceId?: string;
  commentContext?: { threadId: string | null };
}

interface AskUserArgs {
  question: string;
  choices?: string[];
  allow_freeform?: boolean;
}

/**
 * Creates an ask_user tool bound to a specific agent session.
 * The tool lets the agent ask the user a question and wait for a response,
 * presented via the UserInputTile in the chat UI.
 */
export function createAskUserTool(
  agentId: string,
  broker: InteractionBroker,
  registry?: { get(agentId: string): AskUserRegistryRecord | undefined },
) {
  return defineTool<AskUserArgs>('ask_user', {
    description: [
      'Ask the user a question and wait for their response.',
      'Use this tool when you need to ask the user questions during execution. This allows you to:',
      '1. Gather user preferences or requirements',
      '2. Clarify ambiguous instructions',
      '3. Get decisions on implementation choices as you work',
      '4. Offer choices to the user about what direction to take',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question to ask the user. Ensure only one question is asked at a time — do not bundle multiple questions together.',
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of choices for a multiple choice question. Prefer providing choices when possible.',
        },
        allow_freeform: {
          type: 'boolean',
          description:
            'Whether to allow freeform text input in addition to choices. Defaults to true.',
        },
      },
      required: ['question'],
    },
    overridesBuiltInTool: true,
    skipPermission: true,
    handler: async (args: AskUserArgs): Promise<string> => {
      const { question, choices, allow_freeform } = args;
      const allowFreeform = allow_freeform ?? true;

      const hasChoices = choices && choices.length > 0;
      if (!hasChoices && !allowFreeform) {
        return 'Error: Must provide choices or allow freeform input.';
      }

      try {
        const response = await broker.requestUserInput(registry?.get(agentId) ?? agentId, {
          question,
          choices,
          allowFreeform,
        });

        if (!response.answer) {
          return 'User skipped question';
        }

        const prefix = response.wasFreeform ? 'User responded' : 'User selected';
        return `${prefix}: ${response.answer}`;
      } catch (err: any) {
        return `Error asking user: ${err.message || 'Unknown error'}`;
      }
    },
  });
}
