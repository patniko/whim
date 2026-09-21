import type { WhimAPI } from '../shared/whim-api';
import { registerReadAPI } from './ipc-client';

/** Track admitted setting writes, including writes started outside the legacy shell. */
export function trackSettingWrites<T extends object>(api: T, showError: () => void = () => {}) {
  const pending = new Set<Promise<unknown>>();
  const failures = new Map<string, Map<Promise<unknown>, Error>>();
  const writes = /^(setSetting|save|setHotkey|resetHotkey|setWebRemote|regenerateWebRemote|revokeWebRemote)/;
  const recordFailure = (identity: string, operation: Promise<unknown>, error: Error) => {
    let failed = failures.get(identity);
    if (!failed) {
      failed = new Map();
      failures.set(identity, failed);
    }
    failed.set(operation, error);
    showError();
  };
  // Electron freezes contextBridge objects. Proxying that object directly
  // cannot legally replace its non-configurable function properties.
  const tracked = new Proxy({ ...api }, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || typeof value !== 'function' || !writes.test(key)) return value;
      return (...args: unknown[]) => {
        const identity = key === 'setSetting' ? `${key}:${String(args[0])}` : key;
        const operation = Promise.resolve().then(() => Reflect.apply(value, target, args)).then(result => {
          if (result && typeof result === 'object' && ('error' in result && result.error || 'success' in result && result.success === false)) {
            recordFailure(identity, operation, new Error('Settings write failed; changes retained'));
            return result;
          }
          failures.delete(identity);
          return result;
        }).catch(error => {
          recordFailure(identity, operation, error instanceof Error ? error : new Error(String(error)));
          throw error;
        });
        pending.add(operation);
        void operation.then(() => pending.delete(operation), () => pending.delete(operation));
        return operation;
      };
    },
  });
  registerReadAPI(tracked, api);
  return {
    api: tracked,
    discardFailure(method: string, operation?: Promise<unknown>) {
      if (operation) failures.get(method)?.delete(operation);
      if (!operation || failures.get(method)?.size === 0) failures.delete(method);
    },
    async flush() {
      while (pending.size) await Promise.all(pending);
      if (failures.size) throw new Error('A settings write failed. Retry it before closing.');
    },
  };
}

export function installSaveLifecycle(
  api: Pick<WhimAPI, 'onEditorFlushRequest' | 'onEditorFlushReleased' | 'respondEditorFlush'>,
  flush: () => Promise<void>,
  showError: (error: string) => void,
  lock: (locked: boolean) => void = () => {},
): () => void {
  let running: Promise<void> | undefined;
  let token: string | undefined;
  const released = api.onEditorFlushReleased(releasedToken => {
    if (releasedToken === token) { token = undefined; lock(false); }
  });
  const unsubscribe = api.onEditorFlushRequest(request => {
    token = request.token;
    lock(true);
    const current = running ??= flush();
    void current.then(() => {
      api.respondEditorFlush({ token: request.token, ok: true });
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      lock(false);
      showError(message);
      api.respondEditorFlush({ token: request.token, ok: false, error: message });
    }).finally(() => { if (running === current) running = undefined; });
  });
  return () => { unsubscribe(); released(); lock(false); };
}

export class FormDrafts {
  private versions = new WeakMap<Element, number>();
  private dirty = new Set<Element>();
  changed(form: Element): void {
    this.versions.set(form, this.revision(form) + 1);
    this.dirty.add(form);
  }

  revision(form: Element): number { return this.versions.get(form) ?? 0; }
  isDirty(form: Element): boolean { return this.dirty.has(form) && form.isConnected; }
  hasDirty(): boolean { return [...this.dirty].some(form => form.isConnected); }
  saved(form: Element, revision: number): boolean {
    if (this.revision(form) !== revision) return false;
    this.dirty.delete(form);
    return true;
  }
  assertClean(): void {
    for (const form of this.dirty) {
      if (form.isConnected) throw new Error('Save or cancel the edited settings form before continuing.');
      this.dirty.delete(form);
    }
  }

}
