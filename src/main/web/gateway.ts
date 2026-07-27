import type { IpcCommandChannel } from '../../shared/ipc-contract';
import type { AgentAnchor, CreateSpaceInput, Space } from '../../shared/types';
import * as path from 'path';
import {
  assignSpaceFolder,
  createSpace,
  getSpace,
  isInitialized,
  listSpaceEvents,
  listSpaces,
  searchSpaces,
} from '../database';
import { classifyInput, listAvailableModels, resolveDateWithAI } from '../ai';
import { getConfigValue, DEFAULT_PERSONAS, type AgentPersona } from '../config';
import { materializeSpaceCanvas, scheduleAutoCommit } from '../workspace';
import { processSpaceInBackground } from '../services/space-processing';
import { notifyAllWindows } from '../notify';
import { rememberCanvasEditorContent, writeMainCanvasWithMerge } from '../services/canvas-editor-state';
import { resolveCommentLaunchTarget } from '../services/comment-launch-target';

export const WEB_REMOTE_COMMAND_ALLOWLIST = [
  'space:create',
  'space:classify',
  'space:resolve-date',
  'space:list',
  'space:search',
  'space:events',
  'space:update',
  'space:delete',
  'space:unarchive',
  'agent:list-all',
  'agent:get-history',
  'agent:abort',
  'agent:delete-session',
  'chat:send-message',
  'agent:approve',
  'agent:respond-user-input',
  'agent:respond-elicitation',
  'agent:resolve-sandbox',
  'agent:quick-launch',
  'agent:launch-cloud',
  'agent:launch',
  'agent:launch-from-comment',
  'agent:list',
  'personas:list',
  'models:list',
  'canvas:read',
  'canvas:write',
  'canvas:close',
  'canvas:has-content',
  'canvas:history',
  'canvas:preview-version',
  'canvas:restore',
  'canvas:list-pages',
  'canvas:read-page',
  'canvas:write-page',
  'canvas:create-page',
  'workspace:git-status',
  'workspace:git-push',
  'workspace:git-pull',
] as const satisfies readonly IpcCommandChannel[];

export type WebRemoteCommandChannel = typeof WEB_REMOTE_COMMAND_ALLOWLIST[number];

const ALLOWLIST = new Set<string>(WEB_REMOTE_COMMAND_ALLOWLIST);

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

type Handler = (args: unknown[]) => Promise<unknown> | unknown;

const HANDLERS: Record<WebRemoteCommandChannel, Handler> = {
  'space:create': createSpaceFromArgs,
  'space:classify': classifySpaceFromArgs,
  'space:resolve-date': resolveDateFromArgs,
  'space:list': () => isInitialized() ? listSpaces() : [],
  'space:search': (args) => isInitialized() ? searchSpaces(expectString(args, 0, 'query')) : [],
  'space:events': (args) => listSpaceEvents(expectOptionalNumber(args, 0, 'limit') ?? 100),
  'space:update': async (args) => {
    if (!isInitialized()) return null;
    const { applySpaceUpdate } = await import('../services/space-mutations');
    return applySpaceUpdate(expectString(args, 0, 'id'), expectRecord(args[1], 'updates'));
  },
  'space:delete': async (args) => {
    if (!isInitialized()) return false;
    const { deleteSpaceFull } = await import('../services/space-mutations');
    return deleteSpaceFull(expectString(args, 0, 'id'));
  },
  'space:unarchive': async (args) => {
    if (!isInitialized()) return null;
    const { unarchiveSpaceFull } = await import('../services/space-mutations');
    return unarchiveSpaceFull(expectString(args, 0, 'id'));
  },
  'agent:list-all': async () => {
    const { listAllAgents } = await import('../agent-service');
    return listAllAgents();
  },
  'agent:get-history': async (args) => {
    const { getAgentHistory } = await import('../agent-service');
    return getAgentHistory(expectString(args, 0, 'agentId'));
  },
  'agent:abort': async (args) => {
    const { abortAgent } = await import('../agent-service');
    await abortAgent(expectString(args, 0, 'agentId'));
  },
  'agent:delete-session': async (args) => {
    const { deleteAgent } = await import('../agent-service');
    const agentId = expectString(args, 0, 'agentId');
    await deleteAgent(agentId);
    return { ok: true };
  },
  'chat:send-message': async (args) => {
    const { sendChatMessage } = await import('../agent-service');
    return sendChatMessage(
      expectString(args, 0, 'agentId'),
      expectString(args, 1, 'prompt'),
      expectOptionalAttachments(args[2]),
    );
  },
  'agent:approve': async (args) => {
    const { approveAgent } = await import('../agent-service');
    approveAgent(
      expectString(args, 0, 'agentId'),
      expectString(args, 1, 'requestId'),
      expectBoolean(args, 2, 'approved'),
    );
  },
  'agent:respond-user-input': async (args) => {
    const { respondToUserInput } = await import('../agent-service');
    respondToUserInput(
      expectString(args, 0, 'agentId'),
      expectString(args, 1, 'requestId'),
      expectString(args, 2, 'answer'),
      expectBoolean(args, 3, 'wasFreeform'),
    );
  },
  'agent:respond-elicitation': async (args) => {
    const action = expectString(args, 2, 'action');
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw invalidArg('action must be accept, decline, or cancel');
    }
    const { respondToElicitation } = await import('../agent-service');
    respondToElicitation(
      expectString(args, 0, 'agentId'),
      expectString(args, 1, 'requestId'),
      action,
      expectOptionalRecord(args[3]),
    );
  },
  'agent:resolve-sandbox': async (args) => {
    const decision = expectString(args, 2, 'decision');
    if (decision !== 'allow-once' && decision !== 'allow-for-session' && decision !== 'disable') {
      throw invalidArg('decision must be allow-once, allow-for-session, or disable');
    }
    const { resolveSandboxBlock } = await import('../agent-service');
    await resolveSandboxBlock(expectString(args, 0, 'agentId'), expectString(args, 1, 'requestId'), decision);
    return { ok: true };
  },
  'agent:quick-launch': quickLaunchFromArgs,
  'agent:launch-cloud': launchCloudFromArgs,
  'agent:launch': launchAgentFromArgs,
  'agent:launch-from-comment': launchFromCommentArgs,
  'agent:list': async (args) => {
    const { listAgents } = await import('../agent-service');
    return listAgents(expectString(args, 0, 'spaceId'));
  },
  'personas:list': () => {
    const personas = (getConfigValue('personas') || []) as AgentPersona[];
    return personas.length > 0 ? personas : DEFAULT_PERSONAS;
  },
  'models:list': () => listAvailableModels(),
  'canvas:read': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const resolved = await resolveCanvasFolder(spaceId);
    if ('error' in resolved) return { content: '', error: resolved.error };
    const { readCanvas } = await import('../workspace');
    const content = readCanvas(resolved.workspace, resolved.folder);
    rememberCanvasEditorContent(spaceId, content);
    return { content };
  },
  'canvas:has-content': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { hasContent: false };
    const space = getSpace(spaceId);
    if (!space) return { hasContent: false };
    if (!space.folder) return { hasContent: !!(space.body && space.body.trim()) };
    const { readCanvas } = await import('../workspace');
    return { hasContent: readCanvas(workspace, space.folder).trim().length > 0 };
  },
  'canvas:write': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const content = expectStringAllowEmpty(args, 1, 'content');
    const resolved = await resolveCanvasFolder(spaceId);
    if ('error' in resolved) return { error: resolved.error };
    const { scheduleAutoCommit } = await import('../workspace');
    const result = writeMainCanvasWithMerge(resolved.workspace, spaceId, resolved.folder, content);
    scheduleAutoCommit(resolved.workspace);
    return result;
  },
  'canvas:close': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const content = expectStringAllowEmpty(args, 1, 'content');
    const resolved = await resolveCanvasFolder(spaceId);
    if ('error' in resolved) return null;
    const { scheduleAutoCommit } = await import('../workspace');
    writeMainCanvasWithMerge(resolved.workspace, spaceId, resolved.folder, content);
    scheduleAutoCommit(resolved.workspace);
    return null;
  },
  'canvas:history': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { commits: [], error: 'no_workspace' };
    const space = getSpace(spaceId);
    if (!space || !space.folder) return { commits: [], error: 'not_found' };
    const { getSpaceHistory } = await import('../workspace');
    return { commits: await getSpaceHistory(workspace, space.folder) };
  },
  'canvas:preview-version': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const sha = expectString(args, 1, 'sha');
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { content: '', error: 'no_workspace' };
    const space = getSpace(spaceId);
    if (!space || !space.folder) return { content: '', error: 'not_found' };
    const { getSpaceVersionContent } = await import('../workspace');
    return getSpaceVersionContent(workspace, space.folder, sha);
  },
  'canvas:restore': async (args) => {
    const spaceId = expectString(args, 0, 'spaceId');
    const sha = expectString(args, 1, 'sha');
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { success: false, error: 'no_workspace' };
    const space = getSpace(spaceId);
    if (!space || !space.folder) return { success: false, error: 'not_found' };
    const { restoreSpaceVersion, readCanvas } = await import('../workspace');
    const { updateCanvasContent } = await import('../database');
    const result = await restoreSpaceVersion(workspace, space.folder, sha);
    if (result.success) updateCanvasContent(spaceId, readCanvas(workspace, space.folder));
    return result;
  },
  'canvas:list-pages': async (args) => {
    const resolved = await resolveCanvasFolder(expectString(args, 0, 'spaceId'));
    if ('error' in resolved) return { pages: [], error: resolved.error };
    const { listPages } = await import('../workspace');
    return { pages: listPages(resolved.workspace, resolved.folder) };
  },
  'canvas:read-page': async (args) => {
    const resolved = await resolveCanvasFolder(expectString(args, 0, 'spaceId'));
    if ('error' in resolved) return { content: '', error: resolved.error };
    const { readPage } = await import('../workspace');
    const result = readPage(resolved.workspace, resolved.folder, expectString(args, 1, 'pageName'));
    return 'error' in result ? { content: '', error: result.error } : { content: result.content };
  },
  'canvas:write-page': async (args) => {
    const resolved = await resolveCanvasFolder(expectString(args, 0, 'spaceId'));
    if ('error' in resolved) return { error: resolved.error };
    const { writePage, scheduleAutoCommit } = await import('../workspace');
    const result = writePage(resolved.workspace, resolved.folder, expectString(args, 1, 'pageName'), expectStringAllowEmpty(args, 2, 'content'));
    if ('error' in result) return { error: result.error };
    scheduleAutoCommit(resolved.workspace);
    return { success: true };
  },
  'canvas:create-page': async (args) => {
    const resolved = await resolveCanvasFolder(expectString(args, 0, 'spaceId'));
    if ('error' in resolved) return { success: false, page: '', error: resolved.error };
    const { createPage, scheduleAutoCommit } = await import('../workspace');
    const result = createPage(resolved.workspace, resolved.folder, expectString(args, 1, 'pageName'));
    if ('error' in result) return { success: false, page: '', error: result.error };
    scheduleAutoCommit(resolved.workspace);
    return { success: true, page: result.page };
  },
  'workspace:git-status': async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { available: false, unavailableReason: 'not-a-repo', branch: null, ahead: 0, behind: 0 };
    const { getGitSyncStatus } = await import('../workspace');
    return getGitSyncStatus(workspace);
  },
  'workspace:git-push': async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'no_workspace' };
    const { gitPush, getGitSyncStatus } = await import('../workspace');
    const result = await gitPush(workspace);
    void getGitSyncStatus(workspace).then((status) => notifyAllWindows('workspace:git-sync-changed', status)).catch(() => {});
    return result;
  },
  'workspace:git-pull': async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'no_workspace' };
    const { gitPull, getGitSyncStatus } = await import('../workspace');
    const result = await gitPull(workspace);
    void getGitSyncStatus(workspace).then((status) => notifyAllWindows('workspace:git-sync-changed', status)).catch(() => {});
    return result;
  },
};

export function isAllowedWebRemoteCommand(channel: string): channel is WebRemoteCommandChannel {
  return ALLOWLIST.has(channel);
}

export async function invokeWebRemoteCommand(channel: string, args: unknown[]): Promise<unknown> {
  if (!isAllowedWebRemoteCommand(channel)) {
    throw new GatewayError('channel_not_allowed', 403, `Channel is not available over web remote: ${channel}`);
  }
  if (!Array.isArray(args)) {
    throw invalidArg('args must be an array');
  }

  const result = await HANDLERS[channel](args);
  return JSON.parse(JSON.stringify(result ?? null));
}

function createSpaceFromArgs(args: unknown[]): Space | { error: string } {
  if (!isInitialized()) return { error: 'no_workspace' };
  const input = expectRecord<CreateSpaceInput>(args[0], 'input');
  if (typeof input.body !== 'string' || !input.body.trim()) {
    throw invalidArg('input.body must be a non-empty string');
  }

  const space = createSpace({ body: input.body });
  const workspace = getConfigValue('workspace');
  if (workspace && space.folder) {
    const folder = space.folder;
    void materializeSpaceCanvas(workspace, folder, space.body)
      .then(() => scheduleAutoCommit(workspace))
      .catch((err) => console.error('[web-remote] Canvas materialization failed:', err));
  }

  processSpaceInBackground(space.id, space.body || space.description, space.updated_at);
  return space;
}

async function classifySpaceFromArgs(args: unknown[]): Promise<{ type: 'space' | 'query'; answer?: string }> {
  const text = expectString(args, 0, 'text');
  if (!isInitialized()) return { type: 'space' };
  const recent = listSpaces().map(i => ({
    description: i.description,
    status: i.status,
    due_at: i.due_at,
    completed_at: i.completed_at,
  }));
  return classifyInput(text, recent);
}

function resolveDateFromArgs(args: unknown[]): Promise<{ due_at: string; due_at_utc: string | null } | null> {
  return resolveDateWithAI(expectString(args, 0, 'dateText'));
}

async function quickLaunchFromArgs(args: unknown[]): Promise<unknown> {
  const prompt = expectString(args, 0, 'prompt');
  const personaHandle = expectOptionalString(args, 1, 'personaHandle');
  const workspace = getConfigValue('workspace');
  if (!workspace) return { error: 'no_workspace' };

  let persona: AgentPersona | undefined;
  if (personaHandle) {
    const allPersonas = ((getConfigValue('personas') as AgentPersona[]) || []);
    persona = allPersonas.find(p => p.handle === personaHandle);
    if (!persona) return { error: `Persona @${personaHandle} not found` };
  }

  if (persona?.runLocation === 'cca') {
    return launchCcaQuickAgent(prompt, workspace, persona);
  }

  const { launchQuickAgent } = await import('../agent-service');
  return launchQuickAgent(prompt, workspace, persona);
}

async function launchCloudFromArgs(args: unknown[]): Promise<unknown> {
  const spaceId = expectString(args, 0, 'spaceId');
  const prompt = expectString(args, 1, 'prompt');
  const workspace = getConfigValue('workspace');
  if (!workspace) return { error: 'no_workspace' };
  return launchCloudAgent(spaceId, prompt, workspace, null);
}

async function launchAgentFromArgs(args: unknown[]): Promise<unknown> {
  const spaceId = expectString(args, 0, 'spaceId');
  const selectedText = expectString(args, 1, 'selectedText');
  const anchor = expectAnchor(args[2], selectedText);
  const options = expectOptionalRecord(args[3]) as { repo?: string; model?: string } | undefined;
  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized()) return { error: 'no_workspace' };
  const space = getSpace(spaceId);
  if (!space) return { error: 'space_not_found' };

  let folder = space.folder;
  if (!folder) {
    const { initSpaceCanvas } = await import('../workspace');
    folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
    assignSpaceFolder(spaceId, folder);
  }

  const { launchAgent } = await import('../agent-service');
  return launchAgent(spaceId, selectedText, anchor, workspace, folder, options);
}

/**
 * Persona-aware canvas agent launch — mirrors the desktop `agent:launch-from-comment`
 * handler. Routes `cca` personas to the cloud, everything else to a local comment
 * agent bound to the canvas document.
 */
async function launchFromCommentArgs(args: unknown[]): Promise<unknown> {
  const spaceId = expectString(args, 0, 'spaceId');
  const commentBody = expectString(args, 1, 'commentBody');
  const quotedText = expectStringAllowEmpty(args, 2, 'quotedText');
  const anchor = expectAnchor(args[3], quotedText || commentBody);
  const personaHandle = expectString(args, 4, 'personaHandle');
  const threadId = typeof args[5] === 'string' ? args[5] : null;

  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized()) return { error: 'no_workspace' };

  const target = resolveCommentLaunchTarget(spaceId, workspace);
  if ('error' in target) return { error: target.error };

  const personas = (getConfigValue('personas') as AgentPersona[]) || [];
  const persona = personas.find((p) => p.handle === personaHandle);
  if (!persona) return { error: 'persona_not_found' };

  if (persona.runLocation === 'cca') {
    const documentPath = target.documentPath ? path.relative(workspace, target.documentPath) : `${target.folder}/canvas.md`;
    const prompt = `${persona.instructions}\n\nDocument: ${documentPath}\nComment: "${commentBody}"\nOn text: "${quotedText}"`;
    return launchCloudAgent(target.launchSpaceId, prompt, workspace, persona.handle, {
      quotedText,
      threadId,
    });
  }

  const { launchCommentAgent } = await import('../agent-service');
  return launchCommentAgent(target.launchSpaceId, commentBody, quotedText, anchor, persona, threadId, workspace, target.folder, {
    documentPath: target.documentPath,
    documentDisplayName: target.documentDisplayName,
    documentLabel: target.documentLabel,
  });
}

/**
 * Resolve the on-disk canvas folder for a space, materializing it if a folder
 * name was recorded at creation but the folder/canvas isn't on disk yet. Mirrors
 * the desktop canvas IPC handlers so web edits land in the same place.
 */
async function resolveCanvasFolder(spaceId: string): Promise<{ workspace: string; folder: string } | { error: string }> {
  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized()) return { error: 'no_workspace' };
  const space = getSpace(spaceId);
  if (!space) return { error: 'space_not_found' };

  const { initSpaceCanvas, ensureSpaceCanvas } = await import('../workspace');
  let folder = space.folder;
  if (!folder) {
    folder = initSpaceCanvas(workspace, spaceId, space.description, space.body);
    assignSpaceFolder(spaceId, folder);
  } else {
    ensureSpaceCanvas(workspace, folder, space.body);
  }
  return { workspace, folder };
}

async function launchCcaQuickAgent(prompt: string, workspace: string, persona: AgentPersona): Promise<unknown> {
  const fullPrompt = `${persona.instructions}\n\n${prompt}`;
  return launchCloudAgent(null, fullPrompt, workspace, persona.handle);
}

async function launchCloudAgent(
  spaceId: string | null,
  prompt: string,
  workspace: string,
  personaHandle: string | null,
  options?: { quotedText?: string; threadId?: string | null },
): Promise<unknown> {
  const { launchTrackedCloudAgent } = await import('../cloud-agent-poller');
  return launchTrackedCloudAgent({
    spaceId,
    prompt,
    workspace,
    personaHandle,
    quotedText: options?.quotedText,
    threadId: options?.threadId,
  });
}

function invalidArg(message: string): GatewayError {
  return new GatewayError('invalid_args', 400, message);
}

function expectString(args: unknown[], index: number, name: string): string {
  const value = args[index];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArg(`${name} must be a non-empty string`);
  }
  return value;
}

function expectStringAllowEmpty(args: unknown[], index: number, name: string): string {
  const value = args[index];
  if (typeof value !== 'string') throw invalidArg(`${name} must be a string`);
  return value;
}

function expectAnchor(value: unknown, fallbackQuote: string): AgentAnchor {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      quote: typeof record.quote === 'string' ? record.quote : fallbackQuote,
      prefix: typeof record.prefix === 'string' ? record.prefix : '',
      suffix: typeof record.suffix === 'string' ? record.suffix : '',
    };
  }
  return { quote: fallbackQuote, prefix: '', suffix: '' };
}

function expectOptionalString(args: unknown[], index: number, name: string): string | undefined {
  const value = args[index];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalidArg(`${name} must be a string`);
  return value;
}

function expectBoolean(args: unknown[], index: number, name: string): boolean {
  const value = args[index];
  if (typeof value !== 'boolean') throw invalidArg(`${name} must be a boolean`);
  return value;
}

function expectOptionalNumber(args: unknown[], index: number, name: string): number | undefined {
  const value = args[index];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidArg(`${name} must be a number`);
  return value;
}

function expectRecord<T extends object = Record<string, unknown>>(value: unknown, name: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArg(`${name} must be an object`);
  }
  return value as T;
}

function expectOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return expectRecord<Record<string, unknown>>(value, 'content');
}

function expectOptionalAttachments(value: unknown): Array<{ type: 'file'; path: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidArg('attachments must be an array');
  return value.map((entry) => {
    const item = expectRecord<Record<string, unknown>>(entry, 'attachment');
    if (item.type !== 'file' || typeof item.path !== 'string' || !item.path.trim()) {
      throw invalidArg('attachments must contain file paths');
    }
    return { type: 'file' as const, path: item.path };
  });
}
