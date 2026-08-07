/**
 * Notifications for the whim remote.
 *
 * Real Web Push needs a VAPID key pair and a reachable push service. The whole
 * point of this server is that it lives on a network you control and may have
 * no route to Google/Apple's push endpoints at all, so push subscriptions
 * would fail exactly where the feature matters most.
 *
 * Instead we use the Notification API from the running page. The WebSocket is
 * already open and already delivers `agent:approval-needed`, so as long as the
 * app is open — including backgrounded, which is the normal state for an
 * installed PWA on a phone — the alert fires. That covers the case that
 * actually matters: an agent asking permission while you're doing something
 * else.
 */

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as NotificationPermissionState;
  try {
    return (await Notification.requestPermission()) as NotificationPermissionState;
  } catch {
    return 'denied';
  }
}

/** Human-readable alert for one mirrored agent event, or null if it isn't worth interrupting for. */
export function describeNotifiableEvent(channel: string, payload: unknown): { title: string; body: string; tag: string } | null {
  const data = (payload ?? {}) as Record<string, unknown>;
  const agentId = typeof data.agentId === 'string' ? data.agentId : '';
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';

  switch (channel) {
    case 'agent:approval-needed':
      return {
        title: 'Approval needed',
        body: typeof data.intention === 'string' && data.intention
          ? data.intention
          : `An agent wants to ${String(data.permissionKind || 'run a tool')}.`,
        tag: `approval:${agentId}:${requestId}`,
      };
    case 'agent:user-input-requested':
      return {
        title: 'Agent has a question',
        body: typeof data.question === 'string' ? data.question : 'An agent is waiting for your answer.',
        tag: `input:${agentId}:${requestId}`,
      };
    case 'agent:sandbox-blocked':
      return {
        title: 'Sandbox blocked an action',
        body: typeof data.target === 'string' ? data.target : 'An agent hit a sandbox restriction.',
        tag: `sandbox:${agentId}:${requestId}`,
      };
    case 'agent:elicitation-requested':
      return {
        title: 'A tool needs input',
        body: typeof data.message === 'string' ? data.message : 'An agent is waiting for your input.',
        tag: `elicit:${agentId}:${requestId}`,
      };
    default:
      return null;
  }
}

/**
 * Fire a notification for an event if it's one we alert on, permission is
 * granted, and the user isn't already looking at the app.
 */
export function notifyForEvent(channel: string, payload: unknown): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;

  const alert = describeNotifiableEvent(channel, payload);
  if (!alert) return;

  // Prefer the service worker so the notification survives the page being
  // frozen, which is what a backgrounded mobile tab actually is.
  void navigator.serviceWorker?.ready
    .then((registration) => registration.showNotification(alert.title, {
      body: alert.body,
      tag: alert.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }))
    .catch(() => {
      try {
        new Notification(alert.title, { body: alert.body, tag: alert.tag, icon: '/icon-192.png' });
      } catch {
        /* notification failed; the in-app tile still shows the request */
      }
    });
}

/** Register the offline shell worker. Silently no-ops outside a secure context. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* http:// on a non-loopback host — expected until TLS is enabled */
    });
  });
}
