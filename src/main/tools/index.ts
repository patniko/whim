import type { Tool } from '@microsoft/copilot-sdk';
import type { InteractionBroker } from '../agents/interaction-broker';
import { createApproveAgentTool } from './approve-agent';
import { createAskUserTool } from './ask-user';
import { createGetWorkerInfoTool } from './get-worker-info';
import { createListSpacesTool } from './list-spaces';
import { createListWorkersTool } from './list-workers';
import { createSendWorkerMessageTool } from './send-worker-message';
import { createSetYoloAgentTool } from './set-yolo-agent';
import { webFetchTool } from './web-fetch';
import type { WhimToolContext } from './whim-tool-types';

export interface CustomToolsContext {
  agentId: string;
  broker: InteractionBroker;
  enableWhimTools?: boolean;
  registry?: WhimToolContext['registry'];
  getSpaces?: WhimToolContext['getSpaces'];
  setYoloMode?: WhimToolContext['setYoloMode'];
  sendChatMessage?: WhimToolContext['sendChatMessage'];
  getAgentHistory?: WhimToolContext['getAgentHistory'];
}

function hasWhimToolContext(
  context?: CustomToolsContext,
): context is CustomToolsContext &
  Required<Pick<CustomToolsContext, 'registry' | 'getSpaces' | 'setYoloMode' | 'sendChatMessage' | 'getAgentHistory'>> &
  { enableWhimTools: true } {
  return !!(
    context?.enableWhimTools &&
    context.registry &&
    context.getSpaces &&
    context.setYoloMode &&
    context.sendChatMessage &&
    context.getAgentHistory
  );
}

/** Returns all custom tools to register with SDK sessions. */
export function getCustomTools(context?: CustomToolsContext): Tool<any>[] {
  const tools: Tool<any>[] = [webFetchTool];
  if (!context) return tools;

  tools.push(createAskUserTool(context.agentId, context.broker, context.registry));

  if (hasWhimToolContext(context)) {
    const whimContext: WhimToolContext = {
      agentId: context.agentId,
      registry: context.registry,
      broker: {
        resolvePermission: (agentId: string, requestId: string, approved: boolean) => {
          context.broker.approveAgent(agentId, requestId, approved);
        },
      },
      getSpaces: context.getSpaces,
      setYoloMode: context.setYoloMode,
      sendChatMessage: context.sendChatMessage,
      getAgentHistory: context.getAgentHistory,
    };

    tools.push(
      createListSpacesTool(whimContext),
      createListWorkersTool(whimContext),
      createGetWorkerInfoTool(whimContext),
      createApproveAgentTool(whimContext),
      createSetYoloAgentTool(whimContext),
      createSendWorkerMessageTool(whimContext),
    );
  }

  return tools;
}
