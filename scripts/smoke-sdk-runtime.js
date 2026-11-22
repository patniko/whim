const fs = require('fs');
const os = require('os');
const path = require('path');

const [appPath] = process.argv.slice(2);
if (!appPath) {
  throw new Error('Usage: smoke-sdk-runtime.js <app-directory-or-asar>');
}
const { CopilotClient, RuntimeConnection } = require(require.resolve('@microsoft/copilot-sdk', { paths: [appPath] }));
const { getBundledSdkRuntimePaths } = require(path.join(appPath, 'dist/main/copilot-runtime-path'));
const { startRuntimeClient } = require(path.join(appPath, 'dist/main/sdk-runtime-start'));
const { InMemoryFsProvider } = require(path.join(appPath, 'dist/main/agents/in-memory-fs-provider'));
const runtime = getBundledSdkRuntimePaths(appPath);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-sdk-smoke-'));

// No model request is made. A local, unused BYOK endpoint keeps this lifecycle
// smoke independent of login state and external services.
const offlineSession = {
  model: 'smoke/smoke-model',
  tools: { availableTools: [] },
  inference: {
    providers: [{ name: 'smoke', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused-smoke-key' }],
    models: [{ provider: 'smoke', id: 'smoke-model' }],
  },
  github: { capi: { enabled: false } },
  permissions: { onRequest: () => ({ kind: 'reject' }) },
};

/**
 * Host a session for the Copilot CLI the way "Open in CLI" does: start the
 * in-process AHP listener, publish a session inside its workspace, and tear
 * both down. Anonymous admission keeps it independent of GitHub sign-in.
 */
async function smokeAhpHost(client, workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  const host = await client.startAhpHost({
    localServer: {},
    authentication: { mode: 'none' },
    workspace,
    allowCreatingNewSessions: false,
  });
  try {
    if (!host.url) throw new Error('AHP host has no local address');
    const session = await client.createSession({ ...offlineSession, workingDirectory: workspace });
    await host.publishSession(session.sessionId);
    await host.unpublishSession(session.sessionId);
    await session.disconnect();
    return host.url;
  } finally {
    await host.dispose();
  }
}

async function main() {
  try {
    // Repeat to exercise FFI host teardown/restart, not just native-library load.
    for (let iteration = 0; iteration < 2; iteration++) {
      const options = {
        mode: 'empty',
        runtime: RuntimeConnection.forInProcess({ baseDirectory: path.join(directory, String(iteration)) }),
        github: { useLoggedInUser: false },
      };
      const client = new CopilotClient(options);
      const ephemeral = new CopilotClient({
        ...options,
        runtime: RuntimeConnection.forInProcess({ baseDirectory: path.join(directory, `${iteration}-ephemeral`) }),
        sessionFs: { initialCwd: '/', sessionStatePath: '/.session-state', conventions: 'posix' },
      });
      try {
        await startRuntimeClient(client, runtime.executable);
        await startRuntimeClient(ephemeral, runtime.executable);
        const status = await client.getStatus();
        if (!status.version || !status.protocolVersion) throw new Error('Runtime returned an invalid status');
        await client.ping('whim-package-smoke');
        const session = await ephemeral.createSession({
          ...offlineSession,
          workingDirectory: '/',
          state: { createSessionFsProvider: () => new InMemoryFsProvider() },
        });
        await session.disconnect();
        const ephemeralErrors = await ephemeral.stop();
        if (ephemeralErrors.length) throw new AggregateError(ephemeralErrors, 'Ephemeral runtime cleanup failed');
        const ahpUrl = await smokeAhpHost(client, path.join(directory, `${iteration}-workspace`));
        await client.ping('primary-still-running');
        console.log(`inprocess: native runtime ${status.version}, protocol ${status.protocolVersion}, AHP host ${ahpUrl}`);
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
