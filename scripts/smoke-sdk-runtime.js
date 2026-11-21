const fs = require('fs');
const os = require('os');
const path = require('path');

const [appPath, transport] = process.argv.slice(2);
if (!appPath || !['stdio', 'inprocess'].includes(transport)) {
  throw new Error('Usage: smoke-sdk-runtime.js <app-directory-or-asar> <stdio|inprocess>');
}
const { CopilotClient, RuntimeConnection } = require(require.resolve('@microsoft/copilot-sdk', { paths: [appPath] }));
const { getBundledSdkRuntimePaths } = require(path.join(appPath, 'dist/main/copilot-runtime-path'));
const { startRuntimeClient } = require(path.join(appPath, 'dist/main/sdk-runtime-start'));
const { InMemoryFsProvider } = require(path.join(appPath, 'dist/main/agents/in-memory-fs-provider'));
const runtime = getBundledSdkRuntimePaths(appPath);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-sdk-smoke-'));

/** Owned runtime connection with its own state directory. */
function connection(baseDirectory) {
  return transport === 'inprocess'
    ? RuntimeConnection.forInProcess({ baseDirectory })
    : RuntimeConnection.forSpawnedStdio({ path: runtime.executable, baseDirectory });
}

async function main() {
  try {
    // Repeat to exercise FFI host teardown/restart, not just native-library load.
    for (let iteration = 0; iteration < 2; iteration++) {
      const options = {
        mode: 'empty',
        runtime: connection(path.join(directory, String(iteration))),
        github: { useLoggedInUser: false },
      };
      const client = new CopilotClient(options);
      const ephemeral = new CopilotClient({
        ...options,
        runtime: connection(path.join(directory, `${iteration}-ephemeral`)),
        sessionFs: { initialCwd: '/', sessionStatePath: '/.session-state', conventions: 'posix' },
      });
      try {
        const entrypoint = transport === 'inprocess' ? runtime.executable : undefined;
        await startRuntimeClient(client, entrypoint);
        await startRuntimeClient(ephemeral, entrypoint);
        const status = await client.getStatus();
        if (!status.version || !status.protocolVersion) throw new Error('Runtime returned an invalid status');
        await client.ping('whim-package-smoke');
        // No model request is made. A local, unused BYOK endpoint keeps this
        // lifecycle smoke independent of login state and external services.
        const session = await ephemeral.createSession({
          workingDirectory: '/',
          model: 'smoke/smoke-model',
          tools: { availableTools: [] },
          inference: {
            providers: [{ name: 'smoke', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused-smoke-key' }],
            models: [{ provider: 'smoke', id: 'smoke-model' }],
          },
          github: { capi: { enabled: false } },
          permissions: { onRequest: () => ({ kind: 'reject' }) },
          state: { createSessionFsProvider: () => new InMemoryFsProvider() },
        });
        await session.disconnect();
        const ephemeralErrors = await ephemeral.stop();
        if (ephemeralErrors.length) throw new AggregateError(ephemeralErrors, 'Ephemeral runtime cleanup failed');
        await client.ping('primary-still-running');
        console.log(`${transport}: native runtime ${status.version}, protocol ${status.protocolVersion}`);
      } finally {
        const errors = (await Promise.all([client.stop(), ephemeral.stop()])).flat();
        if (errors.length) throw new AggregateError(errors, 'Native runtime cleanup failed');
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
