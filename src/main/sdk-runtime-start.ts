import type { CopilotClient } from '@microsoft/copilot-sdk';

let inProcessStartup: Promise<void> = Promise.resolve();

/**
 * SDK 2.0's in-process connection has no library-path option: `start()` reads
 * `COPILOT_CLI_PATH` from the live host environment, otherwise it resolves the
 * platform package next to the SDK, which is an ASAR path that native dlopen
 * cannot read in packaged builds. Pin it to our physical, unpacked runtime
 * rather than an inherited CLI override. Serialize startups and restore the
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
