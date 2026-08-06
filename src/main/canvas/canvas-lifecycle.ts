/**
 * Keeps whim's artifact windows and the runtime's canvas instances in agreement.
 *
 * Both sides can initiate: the agent opens and closes canvases, and the user
 * closes windows. Without reconciliation the two drift — the runtime believes a
 * canvas is still open and keeps re-issuing `canvas.open` for it on reconnect,
 * or whim keeps a window alive for an instance the session has forgotten.
 */
import {
  closeArtifactWindow,
  findArtifactWindowByInstance,
  onArtifactWindowClosed,
  type OpenArtifactWindow,
} from './artifact-window';

interface InstanceBinding {
  agentId: string;
  spaceId: string;
  artifactId: string;
}

/** Instance id → the run and artifact it belongs to. */
const instances = new Map<string, InstanceBinding>();

export interface CanvasLifecycleDeps {
  /** Resolve the live session for a run, if it still has one. */
  getSession: (agentId: string) => { rpc?: any } | undefined;
}

let deps: CanvasLifecycleDeps | null = null;

/**
 * Wire window closes back to the runtime.
 *
 * A window the user closed must be reported, otherwise the instance stays open
 * in the runtime's durable projection and gets rehydrated on the next reconnect
 * — resurrecting a window the user deliberately dismissed.
 */
export function initCanvasLifecycle(d: CanvasLifecycleDeps): void {
  deps = d;
  onArtifactWindowClosed((window: OpenArtifactWindow) => {
    if (!window.instanceId) return;
    const binding = instances.get(window.instanceId);
    if (!binding) return;
    void closeRuntimeInstance(binding.agentId, window.instanceId);
  });
}

async function closeRuntimeInstance(agentId: string, instanceId: string): Promise<void> {
  const session = deps?.getSession(agentId);
  const close = session?.rpc?.canvas?.close;
  if (typeof close !== 'function') {
    instances.delete(instanceId);
    return;
  }
  try {
    await close({ instanceId });
  } catch (err: any) {
    // A session that has already ended cannot be told anything; the runtime
    // drops its instances with it, so this is not worth surfacing.
    console.warn(`[canvas] could not close instance ${instanceId}: ${err?.message ?? err}`);
  } finally {
    instances.delete(instanceId);
  }
}

/** Record which run and artifact an instance belongs to. */
export function bindCanvasInstance(instanceId: string, binding: InstanceBinding): void {
  instances.set(instanceId, binding);
}

export function getCanvasInstanceBinding(instanceId: string): InstanceBinding | undefined {
  return instances.get(instanceId);
}

/**
 * Handle a canvas session event.
 *
 * `closed` and `unavailable` differ in kind: `closed` means the instance is
 * gone for good, while `unavailable` means the provider is temporarily absent —
 * during a reconnect, for example — and the instance may come back. Tearing the
 * window down on `unavailable` would make artifacts flicker away on every
 * transient disconnect, so only the window's link to the run is dropped.
 */
export function handleCanvasSessionEvent(agentId: string, event: { type?: string; data?: any }): void {
  const type = event?.type;
  if (!type || !type.startsWith('session.canvas.')) return;
  const instanceId: string | undefined = event.data?.instanceId;
  if (!instanceId) return;

  if (type === 'session.canvas.opened') {
    const window = findArtifactWindowByInstance(instanceId);
    if (window) {
      bindCanvasInstance(instanceId, { agentId, spaceId: window.spaceId, artifactId: window.artifactId });
    }
    return;
  }

  if (type === 'session.canvas.closed') {
    const binding = instances.get(instanceId);
    instances.delete(instanceId);
    const window = findArtifactWindowByInstance(instanceId);
    if (window) {
      // The runtime already knows this instance is closed, so closing the
      // window must not echo another close back to it.
      closeArtifactWindow({ spaceId: window.spaceId, artifactId: window.artifactId }, false);
    } else if (binding) {
      closeArtifactWindow({ spaceId: binding.spaceId, artifactId: binding.artifactId }, false);
    }
  }
}

/**
 * Re-attach instance bindings after a resume.
 *
 * The runtime restores the canvases that were open before the app closed, so
 * whim adopts them rather than treating them as unknown — otherwise a window
 * closed after a restart would never be reported back.
 */
export function reconcileOpenCanvases(
  agentId: string,
  openCanvases: Array<{ instanceId?: string }> | undefined,
): void {
  if (!openCanvases?.length) return;
  for (const instance of openCanvases) {
    const instanceId = instance?.instanceId;
    if (!instanceId || instances.has(instanceId)) continue;
    const window = findArtifactWindowByInstance(instanceId);
    if (window) {
      bindCanvasInstance(instanceId, { agentId, spaceId: window.spaceId, artifactId: window.artifactId });
    }
  }
}

/** Forget every instance belonging to a run that has ended. */
export function releaseCanvasInstances(agentId: string): void {
  for (const [instanceId, binding] of [...instances]) {
    if (binding.agentId === agentId) instances.delete(instanceId);
  }
}

export function resetCanvasLifecycleForTests(): void {
  instances.clear();
  deps = null;
  onArtifactWindowClosed(null);
}
