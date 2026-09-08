const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const [appPath] = process.argv.slice(2);
if (!appPath) throw new Error('Usage: smoke-storage-worker.js <app-directory-or-asar>');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-storage-smoke-'));
  let worker;
  let timeout;
  try {
    worker = new Worker(path.join(appPath, 'dist/main/storage-worker.js'), {
      workerData: { interrupt: new SharedArrayBuffer(4) },
    });
    let sequence = 0;
    let failure;
    const pending = new Map();
    const notifications = [];
    function fail(error) {
      failure = error;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    }
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`Storage worker exited (${code})`)));
    worker.on('message', reply => {
      if (reply.notification) {
        notifications.push(reply.channel);
        return;
      }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(new Error(reply.error));
    });
    timeout = setTimeout(() => fail(new Error('Packaged storage worker timed out')), 20_000);
    function request(method, args, generation = 1) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args, generation });
      });
    }
    const database = path.join(directory, '.whim', 'spaces.db');
    const events = path.join(directory, '.whim', 'events');
    await request('initWorkspace', [directory]);
    await request('initDatabase', [database, events]);
    const space = await request('createSpace', [{ body: 'Packaged storage startup smoke' }]);
    assert.equal((await request('getSpace', [space.id])).body, space.body);
    await request('saveSkillSchedule', [directory, 'smoke-skill', 'daily', '09:00', null, {
      timeZone: 'UTC', intent: '', readOnlyServers: [],
    }]);
    assert.ok(notifications.includes('skills:changed'), 'Worker notifications must reach the main process');
    await request('closeDatabase', []);
    await request('initDatabase', [database, events], 2);
    assert.equal((await request('getSpace', [space.id], 2)).body, space.body);
    await request('closeDatabase', [], 2);
    console.log('storage: packaged worker starts, persists/reopens data, and forwards notifications');
  } finally {
    clearTimeout(timeout);
    if (worker) await worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
