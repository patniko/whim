# Sandbox Implementation Overview

This document summarizes the sandbox implementation across the three layers — **Whim** (Electron client), **copilot-sdk** (SDK), and **copilot-agent-runtime** (runtime) — covering what's been built, the end-to-end flows, and remaining gaps.

> **SDK 2.0 option names:** the flows below use the SDK 1.x flat names. With `@microsoft/copilot-sdk` 2.0, `onPermissionRequest` is `permissions.onRequest`, `hooks` is `hooks.handlers`, `onUserInputRequest`/`onElicitationRequest` live under `interaction`, `mcpServers` is `mcp.servers`, and runtime enforcement is pushed with `session.rpc.options.update({ permissions: { sandbox } })`.

---

## Architecture

The sandbox confines agents to a restricted execution environment so they can only access files, network, and tools that the user's policy allows. Enforcement is split across two cooperating layers:

```
┌──────────────────────────── Whim (Electron) ─────────────────────────────┐
│                                                                          │
│  Renderer                        Main process                            │
│  ────────                        ────────────                            │
│  ApprovalTile (Approve/Deny)     InteractionBroker                       │
│  Sandbox block banners           SandboxPolicies (host-side guards)      │
│       ▲                          sdk-runner / comment-workflow            │
│       │ IPC events               sandboxLaunch (config materialization)   │
│       │                                │                                 │
│       └────────── agent:sandbox-blocked│                                 │
│                   chat:event:*         │                                 │
└────────────────────────────────────────┼─────────────────────────────────┘
                                         │ SDK client.createSession({
                                         │   configDir, hooks, onPermissionRequest
                                         │ })
                                         ▼
┌────────────────────────── copilot-sdk (Node) ────────────────────────────┐
│                                                                          │
│  CopilotSession                                                          │
│  ├── onPermissionRequest callback (provided by Whim)                     │
│  ├── hooks.onPreToolUse / onPostToolUse (provided by Whim)               │
│  └── RPC: session.permissions.handlePendingPermissionRequest             │
│                                                                          │
│  Events: permission.requested → permission.completed                     │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ stdio / IPC
                                   ▼
┌──────────────── copilot-agent-runtime (subprocess) ──────────────────────┐
│                                                                          │
│  Session tool dispatch                                                   │
│  ├── preToolUse hooks → allow / deny / ask                               │
│  ├── IFC policy engine (integrity flow control)                          │
│  └── interactiveShell → spawnSandboxedShell → @microsoft/mxc-sdk         │
│                                                                          │
│  Reads ${configDir}/config.json (sandbox.enabled, filesystem, network)   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
                         ┌──────────────────────┐
                         │ wxc-exec.exe (MXC)    │
                         │  AppContainer          │
                         │  ‣ filesystem policy   │
                         │  ‣ network firewall    │
                         └────────────────────────┘
```

### Layer 1: Host-side (Whim main process)

Applies to **all** tools — both SDK-mediated file tools (`view`, `edit`, `create`, `glob`, `grep`, `show_file`, `applyPatch`, `str_replace_editor`) and custom tools (`web_fetch`). These tools run inside the runtime's Node process, so MXC never sees them. Whim gates them via `onPreToolUse` hooks and `onPermissionRequest` callbacks.

### Layer 2: Process-level (MXC AppContainer)

Applies **only** to the shell tool. The runtime spawns shell commands through `wxc-exec.exe`, which creates a Windows AppContainer with filesystem and network restrictions at the OS level.

Both layers cooperate so the user's mental model — "the agent is confined to the intent folder" — holds even though MXC alone wouldn't enforce it for non-shell tools.

---

## What's Been Implemented

### Whim Client

| Area | Status | Details |
|------|--------|---------|
| Persona sandbox toggle | ✅ Done | Checkbox "Run in sandbox" in Persona editor |
| Per-persona policy override | ✅ Done | Full `SandboxPolicy` editor in Persona tab |
| Global default policy | ✅ Done | `AppConfig.sandboxDefaultPolicy` |
| Sandbox config materialization | ✅ Done | Pre-writes `on/` and `off/` config dirs per agent |
| Host-side path enforcement hook | ✅ Done | `createSandboxPathPolicyHook` in `onPreToolUse` |
| Path-aware permission handler | ✅ Done | `createPathAwareSandboxPermissionHandler` auto-approves in-scope, bubbles up out-of-scope |
| MXC-only test mode | ✅ Done | `createMxcOnlyPermissionHandler` auto-approves all, MXC is sole enforcer |
| Sandbox block UI | ✅ Done | `ApprovalTile` with Allow once / Allow for session / Disable |
| Sandbox layer display | ✅ Done | Banner shows `Enforced by: MXC (mxc:…)` or `host (host:…)` |
| Disable sandbox mid-session | ✅ Done | `disableSandboxForSession` resumes with `offDir` config |
| Per-agent session allow lists | ✅ Done | Paths, MCP servers, URLs, web_fetch tracked per agent |
| Native notification on block | ✅ Done | OS notification when window is unfocused |
| Post-tool MXC denial detection | ✅ Done | Heuristic pattern matching on shell output |
| Sandbox denial logging | ✅ Done | Per-layer tagged logging via `logSandboxLayerDenial` |
| MCP filtering | ✅ Done | `allowMcpServers: false` strips MCP servers from session |
| Web fetch filtering | ✅ Done | `allowWebFetch: false` removes `web_fetch` custom tool |
| Network policy passthrough | ✅ Done | `allowOutbound` / `allowLocalNetwork` → runtime config |
| Enforcement mode control | ✅ Done | `both` (default) vs `mxc-only` (test) |
| System prompt injection | ✅ Done | `[SANDBOX MODE]` fragment appended in `both` mode |
| Config cleanup on agent exit | ✅ Done | `cleanupSandboxConfigs` removes per-agent dirs |

### Copilot SDK

| Area | Status | Details |
|------|--------|---------|
| `onPermissionRequest` callback | ✅ Done | Required on `createSession` / `resumeSession` |
| Permission request types | ✅ Done | Rich union: `shell`, `write`, `read`, `mcp`, `url`, `memory`, `custom-tool`, `hook`, etc. |
| Permission decision types | ✅ Done | `approved`, `approved-for-session`, `approved-for-location`, `cancelled`, denial kinds |
| `permission.requested` event | ✅ Done | Emitted by runtime, routed to client callback |
| `permission.completed` event | ✅ Done | Signals UI to dismiss prompt |
| `approveAll` helper | ✅ Done | Server-side short-circuit for auto-approval |
| `setApproveAll` / `resetSessionApprovals` RPC | ✅ Done | Programmatic control |
| `skipPermission` on custom tools | ✅ Done | Per-tool opt-out of permission prompts |
| `configDir` passthrough | ✅ Done | Forwarded to runtime as `COPILOT_HOME` |
| Hooks: `onPreToolUse` / `onPostToolUse` | ✅ Done | Client-provided hooks injected into tool pipeline |
| Protocol v2 `no-result` rejection | ✅ Done | Back-compat only; v2 errors on `no-result` |

### Copilot Agent Runtime

| Area | Status | Details |
|------|--------|---------|
| Sandbox config schema | ✅ Done | `UserSettings.sandbox` with `enabled`, `filesystem`, `network` fields |
| Shell sandboxing via MXC | ✅ Done | `spawnSandboxedShell` → `@microsoft/mxc-sdk` → `wxc-exec.exe` |
| IFC policy engine | ✅ Done | Blocks write-capable tools when context label is untrusted |
| Hook pipeline (`preToolUse`) | ✅ Done | `allow` / `deny` / `ask` decisions |
| Permission event emission | ✅ Done | `permission.requested` / `permission.completed` events |
| `ask` → deny in non-interactive mode | ✅ Done | CCA/headless mode auto-denies `ask` |
| Fail-closed on hook errors | ✅ Done | Hook exceptions → deny |
| `configDir` as `COPILOT_HOME` | ✅ Done | Session-isolated config reading |
| Filesystem policy merging | ✅ Done | Merges user policy with tool/profile/temp paths |

---

## End-to-End Flows

### Flow 1: Agent launch with sandbox enabled

```
1. User @mentions a sandboxed persona in a canvas comment
2. Whim main resolves persona → persona.sandboxed === true && IS_WINDOWS
3. resolveSandboxPolicy(persona) → override or global default
4. Probe CLI for MXC capability (isCliMxcCapable)
   └─ If not capable: warn in chat, fall back to host-only enforcement
5. buildSandboxConfigs(agentId, intentDir, policy) writes:
   └─ ${userData}/sandbox-config/<agentId>/on/config.json  (enabled=true)
   └─ ${userData}/sandbox-config/<agentId>/off/config.json (enabled=false)
6. Filter MCP servers (if !allowMcpServers → {})
7. Filter custom tools (if !allowWebFetch → drop web_fetch)
8. SDK client.createSession({
     configDir: onDir,
     hooks: { onPreToolUse, onPostToolUse },
     onPermissionRequest: pathAwareSandboxPermissionHandler
   })
9. Runtime loads ${onDir}/config.json → sandbox.enabled = true
10. Agent starts executing with sandbox active
```

### Flow 2: Sandbox blocks a path-bearing SDK tool (e.g. `edit` outside scope)

This is the most common sandbox interaction — the agent tries to edit a file outside the allowed policy paths and the user must decide what to do.

```
Agent emits tool call (e.g. edit /Users/foo/Desktop/secret.txt)
  │
  ▼
Runtime fires hooks.onPreToolUse
  │
  ▼
Whim's createSandboxPathPolicyHook runs:
  ├── isPathInScope(target, policy) checks:
  │   ├── intent folder (if scopeToSpaceFolder)
  │   ├── extraReadwritePaths
  │   ├── extraReadonlyPaths (for reads)
  │   └── per-agent session allowList
  │
  ├── IN SCOPE → return undefined (allow), SDK proceeds
  │
  └── OUT OF SCOPE:
      ├── logSandboxLayerDenial('host:path-policy', ...)
      ├── InteractionBroker.emitSandboxBlock(record, {
      │     source: 'pre-tool',
      │     kind: 'write',
      │     target: '/Users/foo/Desktop/secret.txt',
      │     layer: 'host:path-policy'
      │   })
      ├── IPC → renderer: 'agent:sandbox-blocked' (shows ApprovalTile)
      ├── IPC → renderer: 'chat:event:<agentId>' type='sandbox.blocked'
      ├── Native notification (if window unfocused)
      │
      ▼
      Agent PAUSES — Promise does not resolve until user clicks
      │
      ▼
      User sees ApprovalTile with buttons:
      ┌─────────────────────────────────────────────┐
      │ 🔒 Sandbox blocked: write                    │
      │ Target: /Users/foo/Desktop/secret.txt         │
      │ Enforced by: host (host:path-policy)          │
      │                                               │
      │ [Allow once] [Allow for session] [Disable]    │
      └─────────────────────────────────────────────┘
```

**Resolution paths:**

| User clicks | What happens |
|-------------|--------------|
| **Allow once** | Hook resolves → SDK proceeds with this one call. Future calls to the same target still blocked. |
| **Allow for session** | Target added to `record.sandbox.allowList.paths`. Hook resolves → SDK proceeds. Future calls to this path auto-approve on host side. |
| **Disable** | `disableSandboxForSession(agentId)` runs (see Flow 5). This call is approved so the runtime unblocks, then the session is swapped to `offDir`. |

> **Note:** `onPreToolUse` returning `deny` **short-circuits** the permission flow — the SDK will not also fire `onPermissionRequest` for the same tool call.

### Flow 3: Sandbox blocks a permission-driven request (read/write/mcp/url)

When the runtime itself asks for permission (not via a hook), the SDK's `onPermissionRequest` callback fires instead.

```
Runtime needs permission (e.g. write to a file path)
  │
  ▼
SDK emits permission.requested event
  │
  ▼
SDK calls Whim's onPermissionRequest callback:
  createPathAwareSandboxPermissionHandler evaluates:
  │
  ├── kind='read' and path in scope → auto-approve
  ├── kind='write' and path in scope → auto-approve
  ├── kind='write' and path NOT in scope → bubble up via emitSandboxBlock
  ├── kind='mcp' and !allowMcpServers → bubble up (unless in allowList)
  ├── kind='url' → bubble up
  ├── kind='shell' → fall through to interactive handler (user gets
  │                   standard approve/deny prompt, then MXC enforces)
  └── yolo mode → auto-approve all
```

**Key difference from Flow 2:** Permission-driven requests go through `onPermissionRequest`, not `onPreToolUse`. The user experience is identical (same `ApprovalTile`), but the plumbing differs.

### Flow 4: Shell command blocked by MXC

Shell commands bypass host-side path enforcement and run inside the MXC AppContainer. Denials are detected heuristically after the fact.

```
Agent emits shell tool call (e.g. bash: Set-Content C:\Desktop\foo.txt)
  │
  ▼
Whim's onPreToolUse runs read-only classifier (defense-in-depth):
  ├── Obvious destructive command → bubble up immediately
  └── Otherwise → proceed to permission handler
  │
  ▼
onPermissionRequest with kind='shell' → interactive handler
  └── User approves → proceed
  │
  ▼
Runtime spawns shell via spawnSandboxedShell:
  └── @microsoft/mxc-sdk → wxc-exec.exe (AppContainer)
      │
      ├── ALLOWED → command runs, output returned normally
      │
      └── DENIED → exit code / stderr surfaces
          (e.g. "Access is denied.", exit 0xC0000022)
          │
          ▼
          Whim's onPostToolUse hook runs:
          createSandboxShellDenialHook matches denial patterns:
          ├── "Access is denied."
          ├── "wxc-exec"
          ├── exit code 0xC0000022
          └── other heuristic patterns
              │
              ▼
              emitSandboxBlock(record, {
                source: 'post-tool-shell',
                kind: 'shell',
                layer: 'mxc:shell-denial-suspected'
              })
              │
              ▼
              User sees banner: "Possible sandbox denial"
              Buttons: [Allow once] [Disable]
              (No "Allow for session" — MXC would still enforce)
```

> **Important:** Shell denials only offer `allow-once` and `disable` — not `allow-for-session`. Even if the host allow list included the path, MXC's AppContainer would still block it at the OS level.

### Flow 5: User disables sandbox mid-session

When the user clicks **Disable** on any sandbox block prompt:

```
1. InteractionBroker resolves the pending block as 'disable'
2. sdk-runner.disableSandboxForSession(agentId):
   a. broker.clearPendingInteractions(record)
      └── Drains all pending approval/interactive callbacks (deny/cancel)
   b. client.resumeSession(record.sessionId, {
        configDir: offDir,           // sandbox.enabled = false
        onPermissionRequest: standardHandler,  // no longer path-aware
        ...same tools, MCP, etc.
      })
   c. record.sandbox.state = 'off'
   d. setupAgentEventListeners(newSession, record)
   e. IPC → renderer: 'sandbox.disabled' event
   f. newSession.send({ prompt: 'Sandbox is now disabled. Please retry...' })
3. Runtime reloads config from offDir → sandbox.enabled = false
4. Future shell calls spawn outside MXC
5. Future permission requests go through standard (non-sandbox) handler
```

> **Why an explicit off-dir?** Dropping `configDir` would revert `COPILOT_HOME` to the user's global `~/.copilot`, mixing the agent's session state with other sessions. The pre-materialized off-dir keeps the agent isolated.

### Flow 6: Enforcement mode — `mxc-only` (test mode)

Used to verify that MXC's OS-level enforcement actually works, without host-side guards intercepting first.

```
enforcementMode: 'mxc-only'
  │
  ├── onPreToolUse hook: NOT installed
  ├── onPermissionRequest: createMxcOnlyPermissionHandler
  │   └── Auto-approves everything (logged with 'mxc-only:auto-approve')
  ├── [SANDBOX MODE] system prompt: NOT appended
  │   └── Agent has no awareness sandbox exists (intentional — prevents
  │       self-restriction that would avoid the calls we want MXC to deny)
  └── Post-tool MXC denial detector: still runs
      └── Bubbles up with 'mxc:shell-denial-suspected' when patterns match
```

**Caveat:** In `mxc-only` mode, path-bearing SDK tools (`view`, `edit`, etc.) become effectively unrestricted since MXC only sees shell commands.

---

## Data Types

### SandboxPolicy (Whim)

```typescript
interface SandboxPolicy {
  scopeToSpaceFolder: boolean;      // RW access to intent folder (default: true)
  extraReadwritePaths: string[];
  extraReadonlyPaths: string[];
  extraDeniedPaths: string[];
  allowMcpServers: boolean;         // default: false
  allowWebFetch: boolean;           // default: false
  allowOutbound: boolean;           // default: false
  allowLocalNetwork: boolean;       // default: false
  enforcementMode: 'both' | 'mxc-only';  // default: 'both'
}
```

### SandboxBlockRequest (Whim → Renderer IPC)

```typescript
interface SandboxBlockRequest {
  requestId: string;
  agentId: string;
  source: 'permission' | 'pre-tool' | 'post-tool-shell';
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
  toolName?: string;
  target: string;
  intention?: string;
  allowedDecisions?: ('allow-once' | 'allow-for-session' | 'disable')[];
  layer?: SandboxLayer;
}
```

### SandboxLayer (denial attribution)

| Tag | Source | Fires for |
|-----|--------|-----------|
| `host:readonly-classifier` | Pre-tool shell hook | Non-read-only shell command in `both` mode |
| `host:path-policy` | Pre-tool path hook | SDK file tools outside policy paths |
| `host:web-fetch` | Pre-tool hook | `web_fetch` when `allowWebFetch=false` |
| `host:permission` | Permission handler | Runtime read/write/mcp/url outside policy |
| `mxc-only:auto-approve` | MXC-only handler | Auto-approval breadcrumb (logged, not a denial) |
| `mxc:shell-denial-suspected` | Post-tool heuristic | Shell output matched MXC denial patterns |

### Runtime sandbox config

```typescript
// In ${configDir}/config.json → sandbox block
sandbox?: {
  enabled?: boolean;
  filesystem?: {
    readwritePaths?: string[];
    readonlyPaths?: string[];
    deniedPaths?: string[];
    clearPolicyOnExit?: boolean;
  };
  network?: {
    allowOutbound?: boolean;
    allowLocalNetwork?: boolean;
  };
}
```

### SDK permission types

The SDK exposes a rich union for `PermissionRequest` with variants: `shell`, `write`, `read`, `mcp`, `url`, `memory`, `custom-tool`, `hook`, `extension-management`, `extension-permission-access`. Whim's handlers primarily use `kind`, `path`/`fileName`, `command`, `url`, `serverName`, and `intention` fields from these.

Decision results: `approved`, `approved-for-session`, `approved-for-location`, `cancelled`, plus denial kinds (`denied-by-rules`, `denied-by-user`, `denied-by-policy`, `denied-by-hook`).

---

## Known Gaps

### Critical / High Priority

| # | Gap | Impact | Repos affected |
|---|-----|--------|----------------|
| 1 | **Shell denial detection is heuristic** | The runtime has no structured `sandboxDenied` signal. The `onPostToolUse` matcher uses string patterns (`"Access is denied."`, `0xC0000022`, `wxc-exec`, `"Failed to start <shell> process"`) which may mis-classify normal failures as sandbox denials or miss real ones. Tool-name gating lives in `isShellToolName()` (covers bash/shell/powershell/pwsh/local_shell + read_/write_/stop_/list_ variants). | Runtime, Whim |
| 2 | **Cross-platform support: Windows only** | Sandbox is gated on `IS_WINDOWS`. macOS, Linux, and WSL have no containment. Agents on non-Windows platforms run unsandboxed regardless of persona settings. | All |
| 3 | **`allowedHosts` not wired** | MXC supports per-host network allow lists, but the runtime's schema doesn't include `allowedHosts`. Whim drops it from the v1 policy. Users cannot selectively allow specific hosts while blocking general outbound. | Runtime, Whim |
| 4 | **Path-bearing SDK tools unrestricted in `mxc-only` mode** | Since MXC only sandboxes shells, tools like `view`/`edit`/`create` bypass containment in `mxc-only` mode. This is by design for testing but could confuse users who enable it without understanding the limitation. | Whim (docs) |

### Medium Priority

| # | Gap | Impact | Repos affected |
|---|-----|--------|----------------|
| 5 | **Shell sandbox adds extra RW paths beyond policy** | `spawnSandboxedShell` merges tool, profile, and temp paths that aren't in the user's explicit policy. The agent can access these paths from inside MXC. | Runtime |
| 6 | **MCP/web_fetch are removed, not policy-checked** | Sandboxed agents simply don't get MCP or `web_fetch` tools rather than having per-server or per-URL allow lists. No granular control. | Whim |
| 7 | **No live policy mutation** | MXC has no "update policy" API. Changing sandbox config requires `resumeSession` with a new `configDir`. Policy changes mid-conversation require a session swap. | Runtime, SDK |
| 8 | **Shell sandboxing is PowerShell only** | The MXC integration only supports PowerShell. Bash, cmd, or other shells are not sandboxed even on Windows. | Runtime |
| 9 | **`ask` not supported in non-interactive (CCA) mode** | When the runtime is running headless (cloud coding agent), `ask` permission decisions are auto-denied. No way to escalate to a remote user. | Runtime |
| 10 | **SDK `PermissionRequest` type mismatch** | The public `PermissionRequest` type in `types.ts` is much simpler than the generated wire union. Client handlers may only see the simplified shape unless using lower-level/generated types. | SDK |

### Low Priority / Future Work

| # | Gap | Impact | Repos affected |
|---|-----|--------|----------------|
| 11 | **No sandbox settings page** | Configuration is only accessible through the Persona editor. No centralized sandbox management view. | Whim |
| 12 | **Policy file discovery is Phase 2** | The runtime's `policyFileDiscovery.ts` marks sandbox-aware policy discovery as "Phase 2" (not yet implemented). | Runtime |
| 13 | **No direct "approve/deny by request ID" helper on `CopilotSession`** | The SDK flow is callback-driven. There's no imperative `session.approvePermission(requestId)` method; clients must use the lower-level `session.rpc.permissions.*` RPC calls. | SDK |

---

## Verification Recipes

To verify MXC is actually enforcing (not just host-side guards), use `enforcementMode: 'mxc-only'`:

1. **Read outside scope:** `Get-Content C:\Users\<other>\Documents\file.txt`
   - `both` mode: blocked by `host:path-policy` (MXC never runs)
   - `mxc-only`: blocked by `mxc:shell-denial-suspected` (proves MXC enforced)

2. **Write outside scope:** `Set-Content C:\Users\<you>\Desktop\foo.txt 'hi'`
   - `both` mode: blocked by `host:readonly-classifier`
   - `mxc-only`: blocked by `mxc:shell-denial-suspected`

3. **Outbound network** (with `allowOutbound: false`): `Invoke-WebRequest https://example.com`
   - `both` mode: blocked by `host:readonly-classifier`
   - `mxc-only`: blocked by `mxc:shell-denial-suspected` (MXC firewall)

**What to look for:**
- Bubble-up banner should show `Enforced by: MXC (mxc:…)` not `host:*`
- Main process logs: `[sandbox][mxc:shell-denial-suspected] tool=bash …`
- Process tree: `wxc-exec.exe` should be visible during sandboxed shell calls

---

## Key Source Files

### Whim
- `src/shared/ipc-contract.ts` — `SandboxPolicy`, `SandboxLayer`, `DEFAULT_SANDBOX_POLICY`
- `src/main/agents/sandbox-policies.ts` — Host-side hooks, path checking, denial logging
- `src/main/agents/sandbox-launch.ts` — Config materialization (`buildSandboxConfigs`)
- `src/main/agents/interaction-broker.ts` — Block emission, user resolution, permission handlers
- `src/main/agents/sdk-runner.ts` — `disableSandboxForSession`, session creation with sandbox
- `src/main/agents/comment-workflow.ts` — Sandboxed comment agent launch
- `src/main/agents/agent-notifier.ts` — Native notification on sandbox block
- `src/renderer/chat/ApprovalTile.tsx` — Approval UI component
- `src/main/config.ts` — Default policy storage, persona model

### SDK
- `nodejs/src/types.ts` — `PermissionRequest`, `PermissionRequestResult`, `PermissionHandler`
- `nodejs/src/session.ts` — Permission callback wiring, RPC dispatch
- `nodejs/src/generated/rpc.ts` — Wire protocol for permission decisions
- `nodejs/src/generated/session-events.ts` — `permission.requested`, `permission.completed`

### Runtime
- `src/core/sandbox/sandboxSpawn.ts` — MXC shell spawning
- `src/core/sandbox/sandboxConfig.ts` — Sandbox config types
- `src/core/persistence/userSettings.ts` — `UserSettings.sandbox` schema
- `src/core/hooks.ts` — Hook pipeline (`allow`/`deny`/`ask`)
- `src/core/session.ts` — Tool dispatch, permission event emission
- `src/ifc/policy.ts` — IFC policy engine
- `src/tools/interactiveShell.ts` — Shell tool sandbox branch

---

## Related Docs

- [`mxc-sandbox-flow.md`](./mxc-sandbox-flow.md) — Detailed end-to-end flow with sequence diagrams
- [`mxc-sandbox-schema.md`](./mxc-sandbox-schema.md) — Config schema from MXC → runtime → Whim
