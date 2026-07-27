import { ipcMain, globalShortcut } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { setAIModel, listAvailableModels, listModelsDetailed, scheduleCopilotReinit, previewSandboxConfig, getRuntimeStatus, testRuntimeConnection } from '../ai';
import { resolveCopilotCliPath, invalidateCliPath, checkCliCompatibility, resolveCommandOnPath, resolveCmdToJs, isCliMxcCapable, discoverCopilotClis } from '../session';
import { getConfigValue, setConfigValue, getConfig, getResolvedHotkeys, DEFAULT_PERSONAS, DEFAULT_HOTKEYS, HOTKEY_LABELS, rotateWebRemoteToken, normalizeWebRemotePort, normalizeWebRemoteBindAddresses, listWebRemoteInterfaces, type AgentPersona, type CliRuntime, type CliSource, type HotkeyConfig } from '../config';
import { listDiscoveredMcpServers } from '../mcp';
import { validateMcpServers, validateCliTools, validateSandboxPolicy } from '../validators';
import { onAutoHideSidePaneChanged, broadcastHotkeysChanged } from '../window-manager';
import { setAutoDownload } from '../update-service';
import { getWebRemoteState, restartWebRemoteServer, syncWebRemoteServer } from '../web/server';

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (_event, key: string) => {
    const configKeyMap: Record<string, keyof ReturnType<typeof getConfig>> = {
      workspace_root: 'workspace',
      theme: 'theme',
      model: 'model',
      cli_path: 'cliPath',
      cli_source: 'cliSource',
      cli_server_url: 'cliServerUrl',
      cli_server_token: 'cliServerToken',
      auto_hide_side_pane: 'autoHideSidePane',
      auto_download_updates: 'autoDownloadUpdates',
      remoteAutoEnable: 'remoteAutoEnable',
      comment_trigger: 'commentTrigger',
      quick_start_completed: 'quickStartCompleted',
      onboarding_tips_seen: 'onboardingTipsSeen',
    };
    const configKey = configKeyMap[key];
    if (configKey) return getConfigValue(configKey);
    return null;
  });

  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    if (key === 'theme') {
      setConfigValue('theme', value as 'light' | 'dark' | 'system');
    } else if (key === 'model') {
      setConfigValue('model', value);
      await setAIModel(value);
    } else if (key === 'cli_path') {
      let resolved = value || null;
      if (resolved && !fs.existsSync(resolved)) {
        // Bare command name — try to resolve to full path
        const found = resolveCommandOnPath(resolved);
        if (found) resolved = resolveCmdToJs(found);
      }
      setConfigValue('cliPath', resolved);
      invalidateCliPath();
      // Reinitialize the SDK so it picks up the new CLI. Deliberately not
      // awaited: the settings UI writes cliPath and cliSource back to back, and
      // awaiting here would defeat the debounce and respawn the CLI twice.
      void scheduleCopilotReinit();
      return resolved;
    } else if (key === 'cli_source') {
      const allowed: CliSource[] = ['bundled', 'auto', 'path', 'server'];
      const next = (allowed as string[]).includes(value) ? (value as CliSource) : 'bundled';
      setConfigValue('cliSource', next);
      invalidateCliPath();
      void scheduleCopilotReinit();
      return next;
    } else if (key === 'cli_server_url') {
      const url = (value || '').trim() || null;
      setConfigValue('cliServerUrl', url);
      void scheduleCopilotReinit();
      return url;
    } else if (key === 'cli_server_token') {
      setConfigValue('cliServerToken', (value || '').trim() || null);
      void scheduleCopilotReinit();
    } else if (key === 'auto_hide_side_pane') {
      const enabled = value === 'true';
      setConfigValue('autoHideSidePane', enabled);
      onAutoHideSidePaneChanged();
    } else if (key === 'auto_download_updates') {
      const enabled = value === 'true';
      setConfigValue('autoDownloadUpdates', enabled);
      setAutoDownload(enabled);
    } else if (key === 'remoteAutoEnable') {
      setConfigValue('remoteAutoEnable', value === 'true');
    } else if (key === 'comment_trigger') {
      const next = value === 'hover-or-caret' ? 'hover-or-caret' : 'caret';
      setConfigValue('commentTrigger', next);
      return next;
    } else if (key === 'quick_start_completed') {
      setConfigValue('quickStartCompleted', value === 'true' || value === '1');
    } else if (key === 'onboarding_tips_seen') {
      setConfigValue('onboardingTipsSeen', value === 'true' || value === '1');
    }
  });

  ipcMain.handle('web-remote:get-state', async () => {
    return getWebRemoteState();
  });

  ipcMain.handle('web-remote:set-enabled', async (_event, enabled: boolean) => {
    setConfigValue('webRemoteEnabled', enabled === true);
    return syncWebRemoteServer();
  });

  ipcMain.handle('web-remote:set-config', async (_event, next: unknown) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return { error: 'invalid payload' };
    }

    const raw = next as { port?: unknown; bindAddresses?: unknown };
    if (raw.port !== undefined) {
      const port = normalizeWebRemotePort(raw.port);
      if (port !== Number(raw.port)) {
        return { error: 'Port must be between 1024 and 65535.' };
      }
      setConfigValue('webRemotePort', port);
    }

    if (raw.bindAddresses !== undefined) {
      const bindAddresses = normalizeWebRemoteBindAddresses(raw.bindAddresses);
      if (bindAddresses.length === 0) {
        return { error: 'Select at least one network interface.' };
      }
      setConfigValue('webRemoteBindAddresses', bindAddresses);
    }

    return restartWebRemoteServer();
  });

  ipcMain.handle('web-remote:regenerate-token', async () => {
    rotateWebRemoteToken();
    return restartWebRemoteServer();
  });

  ipcMain.handle('web-remote:list-interfaces', () => {
    return listWebRemoteInterfaces();
  });

  ipcMain.handle('cli:resolve-path', () => {
    return resolveCopilotCliPath();
  });

  ipcMain.handle('cli:check-version', () => {
    return checkCliCompatibility();
  });

  ipcMain.handle('cli:check-mxc-capable', () => {
    return { mxcCapable: isCliMxcCapable() };
  });

  ipcMain.handle('cli:runtime-status', () => {
    return getRuntimeStatus();
  });

  ipcMain.handle('cli:test-connection', async () => {
    return testRuntimeConnection();
  });

  ipcMain.handle('cli:discover', async () => {
    return discoverCopilotClis();
  });

  ipcMain.handle('models:list', async () => {
    return listAvailableModels();
  });

  ipcMain.handle('models:list-detailed', async () => {
    return listModelsDetailed();
  });

  // Agent Personas
  ipcMain.handle('personas:list', () => {
    let personas = (getConfigValue('personas') || []) as AgentPersona[];
    const seeded = getConfigValue('personasSeeded');
    const migratedV2 = getConfigValue('personasMigratedV2');

    // One-time migration of legacy runLocation values from before the
    // cca/cloud rename. Gated by `personasMigratedV2` so it never runs again
    // after the first pass — otherwise a user-saved `runLocation: 'cloud'`
    // would be reverted to `'cca'` on every subsequent list call.
    let migrated = false;
    if (!migratedV2) {
      personas = personas.map(p => {
        if ((p as any).runLocation === 'cloud-sandbox') {
          migrated = true;
          return { ...p, runLocation: 'cloud' as const };
        }
        // Old 'cloud' meant CCA (Copilot Coding Agent) — now 'cca'.
        // The old CCA persona never had ephemeral: true.
        if (p.runLocation === 'cloud' && p.ephemeral !== true) {
          migrated = true;
          return { ...p, runLocation: 'cca' as const };
        }
        return p;
      });
      // Also migrate old default handles
      personas = personas.map(p => {
        if (p.id === 'default-cloud' && p.handle === 'cloud' && p.runLocation === 'cca') {
          migrated = true;
          return { ...p, id: 'default-pr', handle: 'pr', emoji: p.emoji === '☁️' ? '🔀' : p.emoji };
        }
        if (p.id === 'default-sandbox-cloud' && p.handle === 'sandbox-cloud' && p.runLocation === 'cloud') {
          migrated = true;
          return { ...p, id: 'default-cloud', handle: 'cloud', emoji: p.emoji === '📦' ? '☁️' : p.emoji };
        }
        return p;
      });
      if (migrated) setConfigValue('personas', personas);
      setConfigValue('personasMigratedV2', true);
    }

    // One-time top-up: add @sandbox to existing installs that have already
    // been seeded (personasSeeded=true) but predate the demo persona.
    // Brand-new users hit the first-time seed block below, which already
    // contains @sandbox. Users who intentionally delete @sandbox after the
    // top-up are respected because the flag is set after the first attempt.
    const sandboxSeeded = getConfigValue('personasSandboxSeeded');
    if (seeded && !sandboxSeeded) {
      if (!personas.some((p: AgentPersona) => p.handle === 'sandbox')) {
        const def = DEFAULT_PERSONAS.find(p => p.handle === 'sandbox');
        if (def) {
          personas = [def, ...personas];
          setConfigValue('personas', personas);
        }
      }
      setConfigValue('personasSandboxSeeded', true);
    }

    if (!seeded) {
      // One-time seed: merge any defaults whose handle doesn't already exist
      const existing = new Set(personas.map((p: AgentPersona) => p.handle));
      const toAdd = DEFAULT_PERSONAS.filter(d => !existing.has(d.handle));
      const merged = [...toAdd, ...personas];
      setConfigValue('personas', merged);
      setConfigValue('personasSeeded', true);
      // First-time seed includes @sandbox via DEFAULT_PERSONAS, so the
      // existing-install top-up never needs to run for this user.
      setConfigValue('personasSandboxSeeded', true);
      return merged;
    }

    // After seeding, only guarantee @agent survives
    const hasDefault = personas.some((p: AgentPersona) => p.handle === 'agent');
    if (!hasDefault) {
      const agentDefault = DEFAULT_PERSONAS.find(p => p.handle === 'agent')!;
      const withDefault: AgentPersona[] = [{ ...agentDefault }, ...personas];
      setConfigValue('personas', withDefault);
      return withDefault;
    }
    return personas;
  });

  ipcMain.handle('personas:save', (_event, personas: unknown) => {
    if (!Array.isArray(personas)) return { error: 'invalid payload' };

    const seen = new Set<string>();
    const validated: AgentPersona[] = [];

    for (const p of personas) {
      if (!p || typeof p !== 'object') continue;
      const raw = p as Record<string, unknown>;

      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const handle = typeof raw.handle === 'string'
        ? raw.handle.trim().replace(/^@/, '').toLowerCase()
        : '';
      const instructions = typeof raw.instructions === 'string'
        ? raw.instructions.trim().slice(0, 2000)
        : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      const runLocation = raw.runLocation === 'cca' ? 'cca' as const
        : raw.runLocation === 'cloud' ? 'cloud' as const
        : 'local' as const;

      const emoji = typeof raw.emoji === 'string' ? raw.emoji.trim().slice(0, 8) : '';
      const cliRuntime = typeof raw.cliRuntime === 'string' ? raw.cliRuntime.trim() : '';

      if (!id || !HANDLE_RE.test(handle) || !instructions) continue;
      if (seen.has(handle)) continue;
      seen.add(handle);

      validated.push({
        id, handle, instructions, model, runLocation,
        ...(raw.sandboxed === true ? { sandboxed: true } : {}),
        ...(emoji ? { emoji } : {}),
        ...(cliRuntime ? { cliRuntime } : {}),
        ...(raw.sandboxed === true && raw.sandboxPolicyOverride !== undefined
          ? (() => {
              const override = validateSandboxPolicy(raw.sandboxPolicyOverride);
              return override ? { sandboxPolicyOverride: override } : {};
            })()
          : {}),
        ...(raw.yolo === true ? { yolo: true } : {}),
        ...(raw.ephemeral === true ? { ephemeral: true } : {}),
      });
    }

    // Protect @agent: ensure it cannot be removed
    const hasAgent = validated.some(p => p.handle === 'agent');
    if (!hasAgent) {
      const existing = (getConfigValue('personas') as AgentPersona[] || []).find((p: AgentPersona) => p.handle === 'agent');
      if (existing) {
        validated.unshift(existing);
      } else {
        const agentDefault = DEFAULT_PERSONAS.find(p => p.handle === 'agent')!;
        validated.unshift({ ...agentDefault });
      }
    }

    setConfigValue('personas', validated);
    return { ok: true };
  });

  // ── CLI Runtimes ─────────────────────────────────────────
  ipcMain.handle('runtimes:list', () => {
    return getConfigValue('cliRuntimes') || [];
  });

  ipcMain.handle('runtimes:save', (_event, runtimes: unknown) => {
    if (!Array.isArray(runtimes)) return { error: 'invalid payload' };

    const seen = new Set<string>();
    const validated: CliRuntime[] = [];

    for (const r of runtimes) {
      if (!r || typeof r !== 'object') continue;
      const raw = r as Record<string, unknown>;

      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 50) : '';
      const rPath = typeof raw.path === 'string' ? raw.path.trim() : '';

      if (!id || !label || !rPath) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      // Resolve bare command names to full paths
      let resolvedPath = rPath;
      if (!fs.existsSync(rPath)) {
        const found = resolveCommandOnPath(rPath);
        if (found) resolvedPath = resolveCmdToJs(found);
      }

      validated.push({ id, label, path: resolvedPath });
    }

    setConfigValue('cliRuntimes', validated);
    return { ok: true, runtimes: validated };
  });

  // ── MCP Servers ──────────────────────────────────────────
  ipcMain.handle('mcp:list-discovered', () => {
    return listDiscoveredMcpServers();
  });

  ipcMain.handle('mcp:list-custom', () => {
    return getConfigValue('mcpServers') || [];
  });

  ipcMain.handle('mcp:save-custom', (_event, servers: unknown) => {
    const result = validateMcpServers(servers);
    if ('error' in result) return result;
    setConfigValue('mcpServers', result);
    return { ok: true };
  });

  // ── CLI Tool Definitions ─────────────────────────────────
  ipcMain.handle('cli-tools:list', () => {
    return getConfigValue('cliTools') || [];
  });

  ipcMain.handle('cli-tools:save', (_event, tools: unknown) => {
    const result = validateCliTools(tools);
    if ('error' in result) return result;
    setConfigValue('cliTools', result);
    return { ok: true };
  });

  // ── Sandbox default policy ───────────────────────────────
  ipcMain.handle('sandbox:get-default', () => {
    return getConfigValue('sandboxDefaultPolicy');
  });

  ipcMain.handle('sandbox:save-default', (_event, policy: unknown) => {
    const validated = validateSandboxPolicy(policy);
    if (!validated) return { error: 'invalid payload' };
    setConfigValue('sandboxDefaultPolicy', validated);
    return { ok: true, policy: validated };
  });

  // Materializes the runtime-format config.json the same way buildSandboxConfigs
  // does at agent launch, writes it to a stable preview file under userData,
  // and opens it in the OS default editor via shell.openPath. Lets the user
  // see exactly what their policy translates into without spawning an agent.
  ipcMain.handle('sandbox:open-config-preview', async (_event, policy: unknown) => {
    const validated = validateSandboxPolicy(policy);
    if (!validated) return { error: 'invalid payload' };
    try {
      const { app, shell } = await import('electron');
      const previewDir = path.join(app.getPath('userData'), 'sandbox-config', 'preview');
      fs.mkdirSync(previewDir, { recursive: true });
      const previewPath = path.join(previewDir, 'config.json');
      const content = previewSandboxConfig(validated);
      fs.writeFileSync(previewPath, JSON.stringify(content, null, 2));
      const openErr = await shell.openPath(previewPath);
      if (openErr) {
        return { error: `Failed to open preview: ${openErr}` };
      }
      return { ok: true as const, path: previewPath };
    } catch (err: any) {
      return { error: err?.message || 'Failed to materialize sandbox config preview' };
    }
  });

  // ── Hotkeys ─────────────────────────────────────────────
  ipcMain.handle('hotkeys:get', () => {
    return getResolvedHotkeys();
  });

  // Whether the OS actually accepted the global toggle shortcut. The quick-start
  // tour asks the user to press it, so it needs to warn up front (and offer a
  // rebind) when another app is already holding the combo.
  ipcMain.handle('hotkeys:toggle-status', () => {
    const accelerator = getResolvedHotkeys().toggleWindow;
    const { isToggleShortcutRegistered } = require('../main');
    return { accelerator, registered: isToggleShortcutRegistered() as boolean };
  });

  ipcMain.handle('hotkeys:set', (_event, key: string, accelerator: string) => {
    if (!(key in DEFAULT_HOTKEYS)) {
      return { error: `Unknown hotkey: ${key}` };
    }
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      return { error: 'Accelerator cannot be empty' };
    }

    // Global shortcuts must include a real modifier (not just Shift alone)
    if (key === 'toggleWindow') {
      const parts = accelerator.split('+').map(p => p.trim());
      const hasRealModifier = parts.some(p =>
        ['CommandOrControl', 'Control', 'Command', 'Alt', 'Meta', 'Super'].includes(p)
      );
      if (!hasRealModifier) {
        return { error: 'Global shortcuts must include a modifier (Ctrl, Cmd, or Alt).' };
      }
    }

    const hotkeyKey = key as keyof HotkeyConfig;
    const previousOverrides = { ...(getConfigValue('hotkeys') || {}) };
    const overrides = { ...previousOverrides };

    // If it matches the default, remove the override instead of storing it
    if (accelerator === DEFAULT_HOTKEYS[hotkeyKey]) {
      delete overrides[hotkeyKey];
    } else {
      overrides[hotkeyKey] = accelerator;
    }
    setConfigValue('hotkeys', overrides);

    // Re-register global shortcut if toggleWindow changed
    if (hotkeyKey === 'toggleWindow') {
      const { registerToggleShortcut } = require('../main');
      const success = registerToggleShortcut(accelerator);
      if (!success) {
        // Revert to previous config state (not just delete override)
        setConfigValue('hotkeys', previousOverrides);
        return { error: `Failed to register shortcut "${accelerator}" — it may be held by another application.` };
      }
    }

    broadcastHotkeysChanged();
    return { ok: true as const };
  });

  ipcMain.handle('hotkeys:reset', (_event, key?: string) => {
    if (key && !(key in DEFAULT_HOTKEYS)) {
      return { error: `Unknown hotkey: ${key}` };
    }

    const overrides = { ...(getConfigValue('hotkeys') || {}) };
    if (key) {
      delete overrides[key as keyof HotkeyConfig];
    } else {
      // Reset all
      for (const k of Object.keys(overrides)) {
        delete overrides[k as keyof HotkeyConfig];
      }
    }
    setConfigValue('hotkeys', overrides);

    // Re-register global shortcut if toggleWindow was reset
    if (!key || key === 'toggleWindow') {
      const { registerToggleShortcut } = require('../main');
      registerToggleShortcut(DEFAULT_HOTKEYS.toggleWindow);
    }

    broadcastHotkeysChanged();
    return { ok: true as const, hotkeys: getResolvedHotkeys() };
  });
}
