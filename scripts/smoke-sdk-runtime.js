const fs = require('fs');
const os = require('os');
const path = require('path');

const [appPath, transport] = process.argv.slice(2);
if (!appPath || !['stdio', 'inprocess'].includes(transport)) {
  throw new Error('Usage: smoke-sdk-runtime.js <app-directory-or-asar> <stdio|inprocess>');
}
const { CopilotClient, RuntimeConnection } = require(require.resolve('@github/copilot-sdk', { paths: [appPath] }));
const { getBundledSdkRuntimePaths } = require(path.join(appPath, 'dist/main/copilot-runtime-path'));
const { startRuntimeClient } = require(path.join(appPath, 'dist/main/sdk-runtime-start'));
const { InMemoryFsProvider } = require(path.join(appPath, 'dist/main/agents/in-memory-fs-provider'));
const runtime = getBundledSdkRuntimePaths(appPath);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-sdk-smoke-'));

async function main() {
  try {
    // Repeat to exercise FFI host teardown/restart, not just native-library load.
    for (let iteration = 0; iteration < 2; iteration++) {
      const options = {
        connection: transport === 'inprocess'
          ? RuntimeConnection.forInProcess()
          : RuntimeConnection.forStdio({ path: runtime.executable }),
        baseDirectory: path.join(directory, String(iteration)),
        useLoggedInUser: false,
        mode: 'empty',
      };
      const client = new CopilotClient(options);
      const ephemeral = new CopilotClient({
        ...options,
        baseDirectory: path.join(directory, `${iteration}-ephemeral`),
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
          availableTools: [],
          workingDirectory: '/',
          model: 'smoke-model',
          provider: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused-smoke-key' },
          onPermissionRequest: () => ({ kind: 'reject' }),
          createSessionFsProvider: () => new InMemoryFsProvider(),
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
