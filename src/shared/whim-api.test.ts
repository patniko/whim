import { describe, expect, it, vi } from 'vitest';
import { createWhimAPI, type IpcTransport } from './whim-api';

function api() {
  const transport: IpcTransport = {
    invoke: vi.fn().mockResolvedValue({}),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    platform: 'test',
  };
  return { transport, client: createWhimAPI(transport) };
}

describe('scheduled skill transport', () => {
  it('carries timezone, intent, and scoped source consent through either transport', async () => {
    const { client, transport } = api();
    const options = {
      timeZone: 'America/Los_Angeles',
      intent: 'Look for unanswered mentions',
      readOnlyServers: ['chat'],
      migrateToCanvas: true,
    };
    await client.setSkillSchedule('missed-messages', 'daily', '09:00', null, options);
    expect(transport.invoke).toHaveBeenCalledWith(
      'skill:set-schedule', 'missed-messages', 'daily', '09:00', null, options,
    );
  });

  it('exposes sanitized schedule source discovery on the shared API', async () => {
    const { client, transport } = api();
    await client.listSkillScheduleSources();
    expect(transport.invoke).toHaveBeenCalledWith('skill:schedule-sources');
  });
});
