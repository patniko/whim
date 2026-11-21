import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MCPServerConfig } from '@microsoft/copilot-sdk';
import { getConfigValue, type CustomMcpServer } from './config';

export interface DiscoveredMcpServer {
  name: string;
  source: 'config' | 'plugin';
  type: string;
  command?: string;
  url?: string;
}

/**
 * Discover MCP servers from the filesystem:
 *  1. ~/.copilot/mcp-config.json
 *  2. ~/.copilot/installed-plugins/{name}/{version}/.mcp.json
 */
export function discoverMCPServers(): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  const copilotDir = join(homedir(), '.copilot');

  // 1. ~/.copilot/mcp-config.json
  const mcpConfigPath = join(copilotDir, 'mcp-config.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers);
    } catch { /* skip malformed config */ }
  }

  // 2. Installed plugins (~/.copilot/installed-plugins/*/*/.mcp.json)
  const pluginsDir = join(copilotDir, 'installed-plugins');
  if (existsSync(pluginsDir)) {
    try {
      for (const ns of readdirSync(pluginsDir)) {
        const nsDir = join(pluginsDir, ns);
        try {
          for (const plugin of readdirSync(nsDir)) {
            const mcpPath = join(nsDir, plugin, '.mcp.json');
            if (existsSync(mcpPath)) {
              try {
                const cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'));
                if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers);
              } catch { /* skip */ }
            }
          }
        } catch { /* skip unreadable namespace dir */ }
      }
    } catch { /* skip */ }
  }

  return servers;
}

/** Convert user-added custom MCP servers to SDK-compatible format */
function customToSdkFormat(custom: CustomMcpServer[]): Record<string, MCPServerConfig> {
  const result: Record<string, MCPServerConfig> = {};
  for (const s of custom) {
    if (s.type === 'http' || s.type === 'sse') {
      if (s.url) {
        result[s.name] = {
          type: s.type,
          url: s.url,
          tools: s.tools.length > 0 ? s.tools : ['*'],
        };
      }
    } else {
      if (s.command) {
        result[s.name] = {
          type: 'stdio',
          command: s.command,
          args: s.args || [],
          tools: s.tools.length > 0 ? s.tools : ['*'],
        };
      }
    }
  }
  return result;
}

/** Get all MCP servers (discovered + user-added) merged for SDK use */
export function getAllMcpServers(): Record<string, MCPServerConfig> {
  const discovered = discoverMCPServers();
  const custom = customToSdkFormat(getConfigValue('mcpServers') || []);
  // Custom servers override discovered ones with the same name
  return { ...discovered, ...custom };
}

/** Get sanitized list of discovered MCPs for renderer display (no secrets) */
export function listDiscoveredMcpServers(): DiscoveredMcpServer[] {
  const copilotDir = join(homedir(), '.copilot');
  const result: DiscoveredMcpServer[] = [];

  // From mcp-config.json
  const mcpConfigPath = join(copilotDir, 'mcp-config.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      if (cfg.mcpServers) {
        for (const [name, server] of Object.entries(cfg.mcpServers)) {
          const s = server as any;
          result.push({
            name,
            source: 'config',
            type: s.type || 'stdio',
            command: s.command,
            url: s.url,
          });
        }
      }
    } catch { /* skip */ }
  }

  // From installed plugins
  const pluginsDir = join(copilotDir, 'installed-plugins');
  if (existsSync(pluginsDir)) {
    try {
      for (const ns of readdirSync(pluginsDir)) {
        const nsDir = join(pluginsDir, ns);
        try {
          for (const plugin of readdirSync(nsDir)) {
            const mcpPath = join(nsDir, plugin, '.mcp.json');
            if (existsSync(mcpPath)) {
              try {
                const cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'));
                if (cfg.mcpServers) {
                  for (const [name, server] of Object.entries(cfg.mcpServers)) {
                    const s = server as any;
                    result.push({
                      name,
                      source: 'plugin',
                      type: s.type || 'stdio',
                      command: s.command,
                      url: s.url,
                    });
                  }
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return result;
}
