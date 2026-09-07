import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { startRuntimeClient } from './sdk-runtime-start';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('startRuntimeClient', () => {
  it('leaves the host environment untouched for stdio', async () => {
    const client = new CopilotClient();
    vi.stubEnv('COPILOT_CLI_PATH', '/custom/cli');
    const start = vi.spyOn(client, 'start').mockResolvedValue();
    await startRuntimeClient(client);
    expect(start).toHaveBeenCalledOnce();
    expect(process.env.COPILOT_CLI_PATH).toBe('/custom/cli');
  });

  it('pins FFI to the physical bundled runtime, then restores the environment', async () => {
    const client = new CopilotClient({ connection: RuntimeConnection.forInProcess() });
    vi.stubEnv('COPILOT_CLI_PATH', '/custom/cli');
    const electronMode = process.env.ELECTRON_RUN_AS_NODE;
    vi.spyOn(client, 'start').mockImplementation(async () => {
      expect(process.env.COPILOT_CLI_PATH).toBe('/app.asar.unpacked/copilot-runtime');
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe(electronMode);
    });
    await startRuntimeClient(client, '/app.asar.unpacked/copilot-runtime');
    expect(process.env.COPILOT_CLI_PATH).toBe('/custom/cli');
  });

  it('restores an unset environment variable after a failed start', async () => {
    vi.stubEnv('COPILOT_CLI_PATH', undefined);
    const client = new CopilotClient({ connection: RuntimeConnection.forInProcess() });
    vi.spyOn(client, 'start').mockRejectedValue(new Error('native load failed'));
    await expect(startRuntimeClient(client, '/bundled/runtime')).rejects.toThrow('native load failed');
    expect(process.env.COPILOT_CLI_PATH).toBeUndefined();
  });

  it('serializes FFI startups even when an earlier startup fails', async () => {
    vi.stubEnv('COPILOT_CLI_PATH', '/original');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const first = new CopilotClient({ connection: RuntimeConnection.forInProcess() });
    const second = new CopilotClient({ connection: RuntimeConnection.forInProcess() });
    vi.spyOn(first, 'start').mockImplementation(async () => {
      await waiting;
      expect(process.env.COPILOT_CLI_PATH).toBe('/first');
      throw new Error('first failed');
    });
    const secondStart = vi.spyOn(second, 'start').mockImplementation(async () => {
      expect(process.env.COPILOT_CLI_PATH).toBe('/second');
    });
    const a = startRuntimeClient(first, '/first');
    const failure = expect(a).rejects.toThrow('first failed');
    const b = startRuntimeClient(second, '/second');
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();
    release();
    await failure;
    await b;
    expect(process.env.COPILOT_CLI_PATH).toBe('/original');
  });
});
