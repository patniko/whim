/**
 * Shared sandbox-launch setup used by both canvas-comment launches
 * (space-folder scope) and Workers-tab quick-launch (workspace-root scope).
 *
 * Encapsulates the persona-sandbox glue that was originally inlined in
 * comment-workflow.ts: policy resolution, sandbox config materialization,
 * MCP/web-fetch filtering, allow-list state, and the pre/post-tool hooks
 * that drive the bubble-up dialog.
 */

import { type AgentPersona, resolveSandboxPolicy } from '../config';
import { buildSandboxConfigs, buildRuntimeSandboxConfig, type SandboxConfigDirs } from '../ai';
import { getAllMcpServers } from '../mcp';
import { getCustomTools, type CustomToolsContext } from '../tools';
import type { SandboxPolicy } from '../../shared/ipc-contract';
import { AgentRegistry, type SandboxRuntimeState } from './agent-registry';
import { InteractionBroker } from './interaction-broker';
import {
  resolvePathPolicy,
  createSandboxPathPolicyHook,
  createSandboxShellDenialHook,
  createSandboxShellDenialFailureHook,
  normalizePath,
  type SandboxLayer,
} from './sandbox-policies';

type McpServersMap = ReturnType<typeof getAllMcpServers>;

export interface SandboxLaunchSetup {
  isSandboxed: boolean;
  /** Resolved policy when sandboxed. */
  policy: SandboxPolicy | null;
  /** Sandbox config dirs to pass to client.createSession({ configDir }). */
  sandboxConfigs: SandboxConfigDirs | null;
  /**
   * Unwrapped runtime sandbox config to pass to
   * `session.rpc.options.update({ permissions: { sandbox } })` after
   * createSession. The runtime does NOT auto-load sandbox enforcement from
   * configDir; only options.update actually toggles MXC. Null when not sandboxed.
   */
  runtimeSandboxConfig: { enabled: boolean; userPolicy: Record<string, unknown> } | null;
  /** Filtered MCP servers (empty object if MCP is denied). */
  mcpServers: McpServersMap;
  /** Filtered custom tools list (drops web_fetch if denied). */
  customTools: ReturnType<typeof getCustomTools>;
  /** Runtime state to store on the AgentRecord. */
  sandboxState: SandboxRuntimeState | undefined;
  /** SDK hook handlers (onPreToolUse, onPostToolUse) when sandboxed; passed as `hooks.handlers`. */
  hooks: Record<string, unknown> | undefined;
  /**
   * Resolved enforcement mode. `'both'` for non-sandboxed personas (the value
   * is unused there) so callers can spread without checking.
   */
  enforcementMode: 'both' | 'mxc-only';
}

/**
 * Build the sandbox setup for a persona-driven session. Returns a
 * pass-through (`isSandboxed: false`) result for non-sandboxed personas or
 * non-Windows hosts so callers can spread the result unconditionally.
 *
 * The hooks closures capture `agentId` so they can look up the live
 * `AgentRecord.sandbox` state on every tool use — this lets the user
 * disable sandbox mid-session via the bubble-up dialog.
 */
/**
 * Shared sandbox-launch setup used by both canvas-comment launches
 * (space-folder scope) and Workers-tab quick-launch (workspace-root scope).
 *
 * Encapsulates the persona-sandbox glue that was originally inlined in
 * comment-workflow.ts: policy resolution, sandbox config materialization,
 * MCP/web-fetch filtering, allow-list state, and the pre/post-tool hooks
 * that drive the bubble-up dialog.
 *
 * The returned `enforcementMode` mirrors `policy.enforcementMode` and lets
 * call sites pick the right `onPermissionRequest` factory:
 *   - `'both'` (default) → `createPathAwareSandboxPermissionHandler`
 *   - `'mxc-only'` → `createPermissionHandler` (no host-side path checks).
 *
 * In `'mxc-only'` mode this function still pre-materializes the on/off
 * config dirs and returns the path policy in `sandboxState`, so the
 * bubble-up dialog and the post-tool MXC-denial detector both stay wired.
 * Only the host-side `onPreToolUse` (read-only classifier + path-policy
 * hook) is suppressed.
 */
export function buildSandboxLaunchSetup(opts: {
  agentId: string;
  workingDir: string;
  persona: AgentPersona;
  registry: AgentRegistry;
  broker: InteractionBroker;
  customToolsContext?: CustomToolsContext;
}): SandboxLaunchSetup {
  const { agentId, workingDir, persona, registry, broker, customToolsContext } = opts;
  const allMcpServers = getAllMcpServers();
  const allCustomTools = getCustomTools(customToolsContext ?? { agentId, broker });

  const isSandboxed = persona.sandboxed === true;

  if (!isSandboxed) {
    return {
      isSandboxed: false,
      policy: null,
      sandboxConfigs: null,
      runtimeSandboxConfig: null,
      mcpServers: allMcpServers,
      customTools: allCustomTools,
      sandboxState: undefined,
      hooks: undefined,
      enforcementMode: 'both',
    };
  }

  const policy = resolveSandboxPolicy(persona);
  const sandboxConfigs = buildSandboxConfigs(agentId, workingDir, policy);
  const runtimeSandboxConfig = buildRuntimeSandboxConfig(true, workingDir, policy);
  const enforcementMode = policy.enforcementMode === 'mxc-only' ? 'mxc-only' : 'both';

  // High-level launch summary — the "which config is being loaded?" question
  // the user is most likely asking. The materialization side already logs
  // the JSON contents; this line gives the per-agent "where + which mode".
  console.log(
    `[sandbox] Launching sandboxed agent ${agentId} ` +
    `persona=@${persona.handle} mode=${enforcementMode} ` +
    `configDir=${sandboxConfigs?.onDir ?? '<none>'} workingDir=${workingDir}`,
  );

  const mcpServers = !policy.allowMcpServers ? {} : allMcpServers;
  const customTools = !policy.allowWebFetch
    ? allCustomTools.filter((t: any) => t?.name !== 'web_fetch' && t?.name !== 'web-fetch')
    : allCustomTools;

  const sandboxState: SandboxRuntimeState = {
    policy: resolvePathPolicy(workingDir, policy),
    configs: sandboxConfigs!,
    state: 'on',
    allowMcpServers: policy.allowMcpServers,
    allowWebFetch: policy.allowWebFetch,
    allowOutbound: policy.allowOutbound,
    allowList: { paths: new Set<string>(), resources: new Set<string>(), webFetch: false },
  };

  const onBlock = async (info: { toolName: string; kind: 'read' | 'write' | 'web-fetch' | 'shell'; target: string; requiresWrite: boolean; layer: SandboxLayer }) => {
    const livingRecord = registry.get(agentId);
    if (!livingRecord) return { permissionDecision: 'deny' as const };
    const resolution = await broker.emitSandboxBlock(livingRecord, {
      source: 'pre-tool',
      kind: info.kind,
      toolName: info.toolName,
      target: info.target,
      allowedDecisions: info.kind === 'shell' ? ['allow-once', 'disable'] : ['allow-once', 'allow-for-session', 'disable'],
      layer: info.layer,
    });
    if (resolution.decision === 'allow-once' || resolution.decision === 'disable') {
      return { permissionDecision: 'allow' as const };
    }
    if (resolution.decision === 'allow-for-session' && livingRecord.sandbox) {
      if (info.kind === 'web-fetch') {
        livingRecord.sandbox.allowList.webFetch = true;
      } else {
        livingRecord.sandbox.allowList.paths.add(normalizePath(info.target));
      }
      return { permissionDecision: 'allow' as const };
    }
    return { permissionDecision: 'deny' as const };
  };

  // The post-tool MXC-denial detector stays wired in BOTH modes — it's how the
  // user finds out that MXC actually blocked something at the OS level.
  //
  // BOTH success- and failure-side hooks are wired: the SDK splits post-tool
  // dispatch by result type and only fires `onPostToolUse` for successful
  // results. Sandbox denials (e.g. MXC AppContainer refusing to spawn
  // powershell.exe → "Failed to start powershell process") surface as
  // *failures*, so without `onPostToolUseFailure` the detector would
  // silently skip the exact case we need it to handle.
  const postToolHookArgs = {
    isDisabled: () => registry.get(agentId)?.sandbox?.state === 'off',
    allowOutbound: () => registry.get(agentId)?.sandbox?.allowOutbound ?? false,
    onBlock: async (info: { toolName: string; target: string; matchedPattern: string; kind: 'high' | 'medium' | 'network'; layer: SandboxLayer }) => {
      const livingRecord = registry.get(agentId);
      if (!livingRecord) return;
      await broker.emitSandboxBlock(livingRecord, {
        source: 'post-tool-shell',
        kind: 'shell',
        toolName: info.toolName,
        target: info.target,
        intention: info.kind === 'high'
          ? `Sandbox blocked this command: "${info.matchedPattern}"`
          : info.kind === 'network'
            ? `Sandbox network restriction: "${info.matchedPattern}"`
            : `Possible sandbox denial: "${info.matchedPattern}"`,
        // post-tool fires AFTER the tool already ran and was denied by MXC.
        // `allow-once` would be a no-op (the failure result has already been
        // delivered to the assistant; there is nothing to gate). Offer only
        // `disable`, which actually changes runtime state AND fires a retry
        // prompt via `disableSandboxForSession`. The renderer adds an
        // "Ignore" button separately for explicit dismissal.
        allowedDecisions: ['disable'],
        layer: info.layer,
      });
    },
  };
  const postTool = createSandboxShellDenialHook(postToolHookArgs);
  const postToolFailure = createSandboxShellDenialFailureHook(postToolHookArgs);

  // In mxc-only mode, suppress the host-side pre-tool hook entirely so the
  // read-only shell classifier and path-policy hook don't intercept calls
  // before MXC sees them.  MCP/web_fetch filtering still applies (those
  // happen above by stripping tools from `customTools`/`mcpServers`).
  const hooks: Record<string, unknown> | undefined = enforcementMode === 'mxc-only'
    ? { onPostToolUse: postTool, onPostToolUseFailure: postToolFailure }
    : {
        onPreToolUse: createSandboxPathPolicyHook({
          policy: sandboxState.policy,
          allowWebFetch: policy.allowWebFetch,
          isDisabled: () => registry.get(agentId)?.sandbox?.state === 'off',
          allowList: () => registry.get(agentId)?.sandbox?.allowList ?? sandboxState.allowList,
          onBlock,
        }),
        onPostToolUse: postTool,
        onPostToolUseFailure: postToolFailure,
      };

  return {
    isSandboxed: true,
    policy,
    sandboxConfigs,
    runtimeSandboxConfig,
    mcpServers,
    customTools,
    sandboxState,
    hooks,
    enforcementMode,
  };
}
