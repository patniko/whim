# MXC Sandbox Flow (End-to-End)

This document walks through what happens when a user `@mention`s a persona that
has the **🔒 Sandboxed** flag checked, from canvas comment to sandbox-aware
agent execution and bubble-up of denials. Pair this with
[`mxc-sandbox-schema.md`](./mxc-sandbox-schema.md), which covers the data shape.

---

## High-level architecture

```
┌─────────────────────── whim (Electron host) ──────────────────────────┐
│                                                                          │
│  Renderer                       Main process                              │
│  ─────────                       ────────────                             │
│  Canvas comment ──@mention──►  agent-handlers.ts ──►  comment-workflow.ts │
│                                                          │                │
│                                       resolveSandboxPolicy(persona)       │
│                                                          │                │
│                                       buildSandboxConfigs(agentId,…)      │
│                                                          │                │
│                                       client.createSession({              │
│                                         configDir: <agent>/on,            │
│                                         hooks: { onPreToolUse, … },       │
│                                         onPermissionRequest, …            │
│                                       })                                  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ stdio / IPC
                                   ▼
┌──────────────── copilot-agent-runtime (subprocess) ─────────────────────┐
│                                                                          │
│  Reads ${configDir}/config.json (UserSettings.sandbox.enabled = true)    │
│                                                                          │
│  Tool dispatch ──► interactiveShell ──► spawnSandboxedShell              │
│                                                  │                        │
│                                        @microsoft/mxc-sdk                 │
│                                                  │                        │
└──────────────────────────────────────────────────┼───────────────────────┘
                                                   │
                                                   ▼
                                         ┌──────────────────────┐
                                         │ wxc-exec.exe (MXC)   │
                                         │  AppContainer        │
                                         │  ‣ filesystem policy │
                                         │  ‣ network firewall  │
                                         └──────────────────────┘
```

### Two enforcement layers

1. **Process-level (MXC)** — applies *only* to the shell tool. The wxc-exec
   AppContainer enforces filesystem and network policy at the OS level.
2. **Host-level (whim)** — applies to SDK-mediated tools (`view`, `edit`,
   `create`, `glob`, `grep`, `show_file`, `applyPatch`, `str_replace_editor`)
   and host-side custom tools (`web_fetch`). MXC does not see these because
   they run inside the runtime process. whim gates them via
   `onPermissionRequest` and `hooks.onPreToolUse`.

These two layers cooperate so the user's mental model — "the agent is confined
to the intent folder" — holds even though MXC alone wouldn't enforce it.

### Enforcement modes (`SandboxPolicy.enforcementMode`)

The persona-level policy can run with the host-side guards turned off so MXC
is the sole enforcer for the shell tool.  This is **only** intended as a way
to verify that MXC is doing the work — production personas should leave the
default (`'both'`) on.

| Mode | Read-only shell classifier | Path-policy `onPreToolUse` | `onPermissionRequest` | `[SANDBOX MODE]` system prompt | Post-tool MXC denial detector | MXC AppContainer |
|------|----|----|----|----|----|----|
| `both` (default) | ✅ runs | ✅ runs | ✅ path-aware (bubbles up out-of-scope writes) | ✅ appended | ✅ runs | ✅ runs |
| `mxc-only` | ❌ skipped | ❌ skipped | ✅ **auto-approve all** (MXC is sole gate) | ❌ omitted | ✅ runs | ✅ runs |

In both modes the on-/off-config dirs are still pre-materialized; the renderer
bubble-up still fires for post-tool MXC denials; and MCP / `web_fetch`
filtering is still tied to the existing `allowMcpServers` / `allowWebFetch`
policy bits (independent of `enforcementMode`).

In `mxc-only` the agent is **not** told it's running sandboxed — the
`[SANDBOX MODE] You are running in a sandboxed environment …` system-prompt
fragment that `'both'` mode appends is suppressed. This is deliberate: the
whole point of `mxc-only` is to verify MXC's OS-level enforcement, and an
agent that knows it's restricted can sidestep the verification by avoiding
the very calls we want MXC to deny. See
`SANDBOX_SYSTEM_PROMPT` / `SANDBOX_WORKSPACE_SYSTEM_PROMPT` in
`src/main/agents/sandbox-policies.ts` and the gates in
`src/main/agents/comment-workflow.ts` and `src/main/agents/sdk-runner.ts`.

For the same reason, `mxc-only` also installs an **auto-approve permission
handler** (`InteractionBroker.createMxcOnlyPermissionHandler`) so SDK
permission requests (`read` / `write` / `shell` / `mcp` / `url`) never bubble
up to the user as `agent:approval-needed`. Each auto-approval is logged with
the `mxc-only:auto-approve` layer tag so the trace is still discoverable.
For shell tools the call then proceeds to MXC's AppContainer at the OS
level, where actual denials surface via the post-tool detector
(`mxc:shell-denial-suspected`). For path-bearing SDK tools that MXC does
not see (view/edit/create/glob/grep) the call simply succeeds — that's
what "unrestricted in this mode" means in the table above. If the user
clicks "Disable sandbox" on a post-tool denial bubble-up, the auto-approve
handler falls back to the regular interactive handler so the user regains
control after explicitly opting out.

### Per-layer denial logging

Every host-side and detected-MXC denial is logged with a `SandboxLayer` tag
(see [`mxc-sandbox-schema.md`](./mxc-sandbox-schema.md#sandbox-layer-taxonomy))
via `logSandboxLayerDenial(layer, …)` in `sandbox-policies.ts`. The same tag
is sent to the renderer in the `agent:sandbox-blocked` event, where the
bubble-up banner shows it as `Enforced by: MXC (mxc:…)` or
`Enforced by: host (host:…)`.

---

## Sequence: launching a sandboxed comment agent

1. **User types `@persona-handle …`** in a canvas comment.
2. **Renderer** dispatches `intentAPI.launchCommentAgent(intentId, body, quote, …, personaHandle, threadIndex)`.
3. **Main / agent-handlers.ts** looks up the persona, resolves the workspace and intent
   folder, and calls `comment-workflow.ts:launchCommentAgent`.
4. **`launchCommentAgent`**:
   - `persona.sandboxed === true` and `IS_WINDOWS` → enter the sandbox path.
   - `policy = resolveSandboxPolicy(persona)` (override or default).
   - Probe whether the resolved CLI is mxc-capable; if not, log a warning event
     to the chat and fall back to **host-side path enforcement only** (no
     `configDir`).
   - `{ onDir, offDir } = buildSandboxConfigs(agentId, intentDir, policy)`
     writes `${userData}/sandbox-config/<agentId>/{on,off}/config.json`.
   - Filter `mcpServers` to `{}` if `!policy.allowMcpServers`.
   - Filter `getCustomTools()` to drop `web_fetch` if `!policy.allowWebFetch`.
   - `client.createSession({ configDir: onDir, hooks, … })`.
5. **Runtime** loads `${onDir}/config.json`, sees `sandbox.enabled = true`,
   primes its shell-spawn path through `spawnSandboxedShell` for any future
   shell tool calls.

---

## Sequence: tool call inside the sandbox

### Case A — Path-bearing SDK tool (e.g., `edit`, `view`, `create`)

```
agent → tool call
  └──► hooks.onPreToolUse (whim host)
        ├── isPathInScope(target, policy) === true
        │     └── return undefined (allow); SDK proceeds → runs Node fs op
        │
        └── isPathInScope(target, policy) === false
              ├── emit `agent:sandbox-blocked` IPC
              ├── await user choice {allow-once | allow-for-session | disable}
              └── return permissionDecision per choice
```

Notes:

- `onPreToolUse` returning `'deny'` **short-circuits the permission flow**;
  the SDK will not also fire `onPermissionRequest` for the same tool call.
- The hook returns a Promise that doesn't resolve until the user clicks one of
  the bubble-up buttons. Until then the agent is paused on that tool call.

### Case B — Permission-driven tool (`read`, `write`, `mcp`, `url`)

```
agent → tool call
  └──► onPermissionRequest (whim host, sandbox-aware version)
        ├── kind === 'read' / 'write' and path in scope → return 'approve-once'
        ├── kind === 'mcp' and !policy.allowMcpServers → bubble-up
        ├── kind === 'url'  and not in url-allow → bubble-up
        ├── kind === 'shell' → fall through to interactive handler
        └── path/target NOT in scope → bubble-up
```

When the user resolves a bubble-up:

| Decision | Action |
|---|---|
| `allow-once` | Resolve the pending permission request as `approve-once`. SDK proceeds. |
| `allow-for-session` | Add target to per-agent host allow list (`AgentRecord.sandboxAllowList`); resolve as `approve-once`. Future requests for the same target auto-approve **on the host side**. |
| `disable` | Run `disableSandboxForSession(agentId)` (see below). |

> **Important:** "Allow for session" is only offered for host-enforced denials
> (SDK file tools, MCP, URL, web_fetch). For **shell** denials, MXC still
> enforces its OS-level policy regardless of any host-side allow list — the
> button is hidden to avoid misleading the user.

### Case C — Shell tool (`bash`)

```
agent → shell tool call
  └──► hooks.onPreToolUse (whim host)
        ├── existing read-only classifier (defense in depth)
        │     └── obvious destructive command → bubble-up
        │
        └── otherwise → proceed
              └──► onPermissionRequest with kind='shell' (interactive)
                    └──► runtime spawns shell via spawnSandboxedShell
                          └──► wxc-exec.exe enforces MXC filesystem / network
                                ├── allowed → command runs, output returned
                                └── denied  → exit code / stderr surface
                                        └──► hooks.onPostToolUse heuristic
                                              └──► best-effort detection of
                                                   MXC denial → bubble-up
                                                   with `source: 'shell-denial-suspected'`
```

The `onPostToolUse` shell-denial heuristic matches strings like
`Access is denied.`, `wxc-exec`, exit code `0xC0000022`, etc. It is **soft** —
the UI must label the prompt "Possible sandbox denial" and offer an
"Ignore" option.

---

## Bubble-up resolution: `disable` (most invasive)

```
1. Cancel pending approval / pre-tool-use Promises (resolve-as-deny first to
   release them; we'll re-prompt the agent right after).
2. Read record.sandboxConfigs.offDir.
3. await client.resumeSession(record.sessionId, {
     configDir: offDir,
     // same handlers, hooks, mcpServers (if user opted in via override),
     // tools, etc.
   })
4. record.session = newSession
5. setupAgentEventListeners(newSession, record)
6. record.sandboxState = 'off'; persistence.updateStatus(record)
7. notifier.notifyRenderer(`chat:event:${agentId}`, {
     type: 'sandbox.disabled',
     reason: 'user-requested'
   })
8. await record.session.send({
     prompt: 'Sandbox is now disabled. Please retry your last operation.'
   })
```

The runtime sees the new `configDir`, reads `${offDir}/config.json` (which has
`sandbox.enabled = false`), and from the next shell call onward spawns
processes outside MXC.

> **Why an explicit off-dir, not "drop configDir"?** Dropping `configDir` would
> revert `COPILOT_HOME` to the user's global `~/.copilot`, mixing this agent's
> session state with everything else. Pre-materialized off-dir keeps the
> agent's state isolated.

---

## Cleanup

When an agent reaches `idle` / `failed` / aborted:

- `cleanupSandboxConfigs(agentId)` removes the per-agent `on/`+`off/`
  directories.
- Pending bubble-up Promises are resolved (rejected) by
  `InteractionBroker.clearPendingInteractions`.

---

## Known gaps

1. **Shell adds extra RW paths.** `spawnSandboxedShell` merges in tool, profile,
   and temp paths beyond the user's policy (`sandboxSpawn.ts:73-89`). The
   intent folder is the *additional* RW; the agent can also reach those extra
   paths from inside MXC. We document this and recommend an upstream issue to
   make the extras opt-in.
2. **Shell denial detection is heuristic.** The runtime has no structured
   `sandboxDenied` signal yet. The `onPostToolUse` matcher is best-effort and
   may mis-classify normal failures.
3. **`allowedHosts` not yet wired.** Runtime schema today doesn't include it,
   so we drop it from the whim policy v1 and re-enable when the runtime
   adds support.
4. **MCP / `web_fetch` are removed, not policy-checked.** Sandboxed agents
   default to no MCP and no `web_fetch`. A future revision can add per-server
   MCP allow lists and host-enforced URL policies for `web_fetch`.
5. **Cross-platform.** macOS / Linux / WSL containment is not addressed. v1
   gates the sandbox path on `IS_WINDOWS` only.
6. **Live MXC policy mutation.** MXC has no "update policy" API; we re-create
   the session via `resumeSession(offDir)` to swap policies.

---

## How to verify MXC is actually doing the enforcement

Because the default `enforcementMode: 'both'` stacks several host-side guards
in front of MXC, a "the agent can't write to my Desktop" experiment usually
fails at layer 1 (read-only classifier) or layer 2 (path-policy) and never
exercises MXC at all. Use `mxc-only` mode with the recipes below to verify
MXC is enforcing.

> **Setup**
> 1. Create or pick a sandboxed persona and set `Enforcement mode` to
>    *"MXC only (test mode)"* in the policy editor.
> 2. Make sure the resolved CLI bundles `@microsoft/mxc-sdk` — the launch logs
>    a warning when it doesn't (see `isCliMxcCapable()` in `session.ts`).
> 3. Run the persona on Windows. Sandbox is gated on `IS_WINDOWS`.

### Recipe 1 — read outside scope

Prompt the agent: `Get-Content C:\Users\<other>\Documents\file.txt`

| Mode | Expected layer | Notes |
|---|---|---|
| `both` | `host:path-policy` | Read-only classifier passes (`Get-Content` is read-only); the path-policy hook fires. **MXC never runs.** |
| `mxc-only` | `mxc:shell-denial-suspected` | The classifier and path hook are skipped. MXC's AppContainer denies the file open; output contains `Access is denied.` / `0xC0000022`; the post-tool detector bubbles up. **This proves MXC enforced.** |

### Recipe 2 — write outside scope

Prompt the agent: `Set-Content C:\Users\<you>\Desktop\foo.txt 'hi'`

| Mode | Expected layer |
|---|---|
| `both` | `host:readonly-classifier` (writes are not in the read-only allow list) |
| `mxc-only` | `mxc:shell-denial-suspected` (MXC AppContainer denies the file create) |

### Recipe 3 — outbound network

With `allowOutbound: false`, prompt: `Invoke-WebRequest https://example.com`

| Mode | Expected layer |
|---|---|
| `both` | `host:readonly-classifier` |
| `mxc-only` | `mxc:shell-denial-suspected` (MXC firewall blocks) |

### What to look at

- **Bubble-up banner.** The renderer shows `Enforced by: MXC (mxc:…)` or
  `Enforced by: host (host:…)` directly under the title. If you only ever see
  `host:*`, you're not testing MXC.
- **Main process logs.** Each denial logs a tagged warn line via
  `logSandboxLayerDenial`, e.g.
  `[sandbox][mxc:shell-denial-suspected] tool=bash target=Set-Content … reason=matched pattern "Access is denied."`.
- **Process tree.** When MXC actually runs the shell, the spawned process is
  `wxc-exec.exe` (not `pwsh.exe`). `Get-Process | Where-Object Name -like 'wxc*'`
  during a sandboxed shell call confirms the OS-level isolation is in effect.

### Caveat — what `mxc-only` does NOT cover

MXC only sandboxes shells. Path-bearing SDK tools (`view`, `edit`, `create`,
`glob`, `grep`, `show_file`, `applyPatch`, `str_replace_editor`) and the
custom `web_fetch` tool go through Node `fs` / `fetch` inside the runtime
process and are **not** seen by MXC. In `mxc-only` mode those tools become
effectively unrestricted (the path-policy hook is off). This is exactly what
you want when verifying MXC's shell enforcement, but it's why `mxc-only` is
not a production setting.

---

## References

- Schema: [`mxc-sandbox-schema.md`](./mxc-sandbox-schema.md)
- Upstream MXC policy spec: `../../mxc/docs/sandbox-policy/v1/policy.md`
- Runtime sandbox spawn: `../../copilot-agent-runtime/src/core/sandbox/sandboxSpawn.ts`
- SDK hook types:
  `node_modules/@microsoft/copilot-sdk/dist/types.d.ts` (`SessionHooks`,
  `PreToolUseHookOutput`, `PermissionRequest`)
