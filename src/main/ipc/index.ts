import { registerSpaceHandlers } from './space-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerCanvasHandlers } from './canvas-handlers';
import { registerCanvasArtifactHandlers } from './canvas-artifact-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerChatHandlers } from './chat-handlers';
import { registerWorkspaceHandlers } from './workspace-handlers';
import { registerSkillHandlers } from './skill-handlers';
import { registerExportHandlers } from './export-handlers';

export function registerIpcHandlers(): void {
  registerSpaceHandlers();
  registerAgentHandlers();
  registerCanvasHandlers();
  registerCanvasArtifactHandlers();
  registerSettingsHandlers();
  registerChatHandlers();
  registerWorkspaceHandlers();
  registerSkillHandlers();
  registerExportHandlers();
}

// Re-export typed handler utilities
export { registerHandler, registerMessage, sendToAllWindows } from './typed-handler';

// Re-export validators (previously re-exported from ipc.ts)
export { validateMcpServers, validateCliTools } from '../validators';
