import { getConfigValue, type AppConfig } from '../config';

/**
 * Maps a renderer-facing setting name to its config field.
 *
 * This lived inside the `settings:get` IPC handler, which made it reachable
 * only from Electron. The web gateway needs exactly the same reads, and a
 * second copy of this mapping would be one more thing to drift.
 */
const SETTING_CONFIG_KEYS: Record<string, keyof AppConfig> = {
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

/**
 * Read a setting by its renderer-facing name.
 *
 * Unknown keys return null rather than throwing: the renderer reads settings
 * that predate this map, and an absent setting is meaningfully "unset".
 *
 * This performs no access control. Callers that serve a remote client must
 * consult `canReadSetting` first; see shared/settings-access.ts.
 */
export function readSetting(key: string): unknown {
  const configKey = SETTING_CONFIG_KEYS[key];
  return configKey ? getConfigValue(configKey) : null;
}
