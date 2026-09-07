import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getSpace, assignSpaceFolder, createCanvasAgent, updateCanvasAgentStatus } from './storage';
import { checkCopilotCli, checkCliCompatibility } from './session';
import { createSpaceFolder } from './workspace';
import { CanvasAgent } from '../shared/types';
import { launchInTerminal as platformLaunchInTerminal, shellEscapeDouble } from './platform/terminal';

export interface AgentLaunchResult {
  success: boolean;
  agent?: CanvasAgent;
  error?: string;
}

/**
 * Launch a Copilot CLI session in interactive mode (-i) for a specific
 * text selection on the canvas. The workspace dir is the space folder
 * so copilot can read canvas.md directly.
 */
export async function launchCanvasAgent(
  spaceId: string,
  selectedText: string,
  workspaceRoot: string
): Promise<AgentLaunchResult> {
  const cli = await checkCopilotCli();
  if (!cli) {
    return { success: false, error: 'Copilot CLI not found' };
  }

  const compat = checkCliCompatibility();
  if (!compat.compatible) {
    return {
      success: false,
      error: `Copilot CLI ${compat.version || 'unknown'} is not compatible. Please update to ${compat.minVersion} or later (run: copilot update).`,
    };
  }

  const space = (await getSpace(spaceId));
  if (!space) {
    return { success: false, error: 'Space not found' };
  }

  // Ensure space has a workspace folder
  let folder = space.folder;
  if (!folder) {
    folder = createSpaceFolder(workspaceRoot, spaceId, space.description);
    (await assignSpaceFolder(spaceId, folder));
  }

  const cwd = path.join(workspaceRoot, folder);
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  const agentId = uuidv4();
  const now = new Date().toISOString();

  const agent: CanvasAgent = {
    id: agentId,
    space_id: spaceId,
    selected_text: selectedText,
    session_id: agentId,
    pid: null,
    status: 'running',
    created_at: now,
    updated_at: now,
  };

  // Build the prompt for copilot -i
  const prompt = `Read canvas.md for full context, then address this: ${selectedText}`;

  // Launch copilot -i in terminal
  const pid = await launchInteractive(cli, cwd, agentId, prompt);
  agent.pid = pid;

  // Record in database
  (await createCanvasAgent(agent));

  console.log(`[canvas-agent] Launched interactive agent ${agentId} for space ${spaceId} (PID ${pid || 'unknown'})`);
  return { success: true, agent };
}

async function launchInteractive(cli: string, cwd: string, agentId: string, prompt: string): Promise<number | null> {
  const escapedPrompt = shellEscapeDouble(prompt);
  const result = await platformLaunchInTerminal({
    command: cli,
    args: ['-i', `\\"${escapedPrompt}\\"`],
    cwd,
  });

  const pid = result.pid ?? null;

  // On macOS, resolve the real PID asynchronously
  if (process.platform === 'darwin' && pid === 0) {
    setTimeout(async () => {
      try {
        const output = execSync(`pgrep -nf "copilot.*-i"`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const realPid = parseInt(output);
        if (realPid && !isNaN(realPid)) {
          (await updateCanvasAgentStatus(agentId, 'running', realPid));
        }
      } catch { /* process may not have started yet */ }
    }, 2000);
  }

  return pid;
}
