import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('src/renderer/app.ts', 'utf8');

describe('legacy collection refresh wiring', () => {
  it('routes collection reads through the bridge, without per-space fallback fanout', () => {
    expect(app).not.toMatch(/whimAPI\.(?:list|listAllAgents|getActiveSessions|listSkills|listPersonas|listEvents)\(/);
    expect(app).not.toContain('scheduleAgentSpacesRefresh');
    expect(app).not.toContain('scheduleAgentListRefresh');
    expect(app).not.toContain('animateRefinement');
    expect(app.match(/installIpcBridge\(bridgeApi/g)).toHaveLength(1);
  });

  it('keeps legacy mirrors and intentional canvas/interaction subscribers', () => {
    for (const store of ['spaceStore', 'agentStore', 'skillStore', 'personaStore']) {
      expect(app).toContain(`${store}.subscribe(`);
    }
    for (const event of [
      'onAgentStatusChanged', 'onAgentApprovalNeeded', 'onAgentApprovalResolved',
      'onAgentUserInputRequested', 'onAgentUserInputResolved',
      'onAgentElicitationRequested', 'onAgentElicitationResolved',
      'onAgentPresenceStarted', 'onAgentPresenceEnded', 'onAgentReplyReady',
      'onAgentSandboxBlocked', 'onAgentSandboxResolved',
    ]) expect(app).toContain(`whimAPI.${event}(`);
    expect(app).toContain('async function refreshAgentDecorations()');
    expect(app).toContain('spaceStore.upsertSpace(space)');
  });

  it('wires native and browser visibility hydration and disables collection loading in auxiliary windows', () => {
    expect(app).toMatch(/isListVisible: \(\) => !isCanvasMode && !isSettingsMode && !document\.hidden/);
    const visibility = app.slice(app.indexOf("document.addEventListener('visibilitychange'"), app.indexOf('// ── Filter bar'));
    expect(visibility).toContain('refreshVisibleCollections()');
    const shown = app.slice(app.indexOf('whimAPI.onWindowShown('), app.indexOf('whimAPI.onWindowToggle('));
    expect(shown).toContain('refreshVisibleCollections()');
  });
});
