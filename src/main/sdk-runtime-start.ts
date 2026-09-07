import type { CopilotClient } from '@github/copilot-sdk';

let inProcessStartup: Promise<void> = Promise.resolve();

/**
 * SDK 1.0.13 accepts an FFI library location only through the host environment.
 * Pin it to our physical, unpacked runtime, not an inherited CLI override or an
 * ASAR path that native dlopen cannot read. Serialize startups and restore the
 * host environment before letting the next caller start.
 */
export function startRuntimeClient(client: CopilotClient, inProcessEntrypoint?: string): Promise<void> {
  if (!inProcessEntrypoint) return client.start();
  const startup = inProcessStartup.then(async () => {
    const previous = process.env.COPILOT_CLI_PATH;
    process.env.COPILOT_CLI_PATH = inProcessEntrypoint;
    try {
      await client.start();
    } finally {
      if (previous === undefined) delete process.env.COPILOT_CLI_PATH;
      else process.env.COPILOT_CLI_PATH = previous;
    }
  });
  // Failure is returned to the caller; the queue must still accept later starts.
  inProcessStartup = startup.then(() => {}, () => {});
  return startup;
}
