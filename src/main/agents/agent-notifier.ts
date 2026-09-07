import { BrowserWindow, Notification } from 'electron';
import { mirrorRendererEvent } from '../web/event-hub';
import { assertWorkspaceContext, workspaceCallback } from '../workspace-context';

export interface ApprovalNotificationOptions {
  agentId: string;
  requestId: string;
  permissionKind: string;
  intention?: string;
  path?: string;
  onApprove?: () => void;
  onDeny?: () => void;
}

export interface SandboxBlockNotificationOptions {
  agentId: string;
  requestId: string;
  kind: string;
  target: string;
  intention?: string;
  onAllowOnce?: () => void;
}

export interface UserInputNotificationOptions {
  agentId: string;
  requestId: string;
  question?: string;
}

export interface ElicitationNotificationOptions {
  agentId: string;
  requestId: string;
  message?: string;
}

/** Escape XML special characters for use in Windows toast XML. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build Windows Toast XML with optional action buttons.
 * On Windows, Electron's Notification `actions` property is ignored —
 * `toastXml` is the only way to show interactive buttons.
 */
export function buildToastXml(
  title: string,
  body: string,
  actions?: { label: string; argument: string }[],
): string {
  const actionsXml = actions?.length
    ? `<actions>${actions.map(a =>
        `<action content="${escapeXml(a.label)}" arguments="${escapeXml(a.argument)}" activationType="foreground"/>`
      ).join('')}</actions>`
    : '';

  return `<toast launch="click" activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(title)}</text>
      <text>${escapeXml(body)}</text>
    </binding>
  </visual>
  ${actionsXml}
</toast>`;
}

export class AgentNotifier {
  /** Send an event to all renderer windows */
  notifyRenderer(channel: string, ...args: any[]): void {
    assertWorkspaceContext();
    mirrorRendererEvent(channel, ...args);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, ...args);
    }
  }

  /** Bring the first window to front and notify it of the click. */
  private bringWindowToFront(agentId: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      win.focus();
      win.webContents.send('notification:approval-clicked', { agentId });
    }
  }

  /** Show native OS notification for permission approval when window is unfocused */
  showApprovalNotification(options: ApprovalNotificationOptions): void {
    assertWorkspaceContext();
    const wins = BrowserWindow.getAllWindows();
    const anyFocused = wins.some(w => w.isFocused());
    if (anyFocused) return;

    const { agentId, permissionKind, intention, path, onApprove, onDeny } = options;

    const kindLabel = permissionKind
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    const bodyParts: string[] = [kindLabel || 'An agent needs your permission to continue'];
    if (intention) bodyParts.push(intention);
    if (path) bodyParts.push(path);

    const title = 'Approval Needed';
    const body = bodyParts.join('\n');

    const isWindows = process.platform === 'win32';

    const notification = new Notification({
      title,
      body,
      silent: false,
      // macOS-only: action buttons via the actions property
      ...(!isWindows ? {
        actions: [
          { type: 'button' as const, text: 'Approve' },
          { type: 'button' as const, text: 'Deny' },
        ],
      } : {}),
      // Windows-only: use toast XML for action buttons
      ...(isWindows ? {
        toastXml: buildToastXml(title, body, [
          { label: 'Approve', argument: 'approve' },
          { label: 'Deny', argument: 'deny' },
        ]),
      } : {}),
    });

    notification.on('action', workspaceCallback((_event, index) => {
      if (index === 0) {
        onApprove?.();
      } else {
        onDeny?.();
      }
    }));

    notification.on('click', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.show();
  }

  /** Show native OS notification for a sandbox block event. */
  showSandboxBlockNotification(options: SandboxBlockNotificationOptions): void {
    assertWorkspaceContext();
    const wins = BrowserWindow.getAllWindows();
    const anyFocused = wins.some(w => w.isFocused());
    if (anyFocused) return;

    const { agentId, kind, target, intention, onAllowOnce } = options;

    const bodyParts: string[] = [`Blocked: ${kind}`];
    if (intention) bodyParts.push(intention);
    if (target) bodyParts.push(target);

    const title = 'Sandbox Blocked';
    const body = bodyParts.join('\n');

    const isWindows = process.platform === 'win32';

    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(!isWindows ? {
        actions: [
          { type: 'button' as const, text: 'Allow Once' },
          { type: 'button' as const, text: 'Open' },
        ],
      } : {}),
      ...(isWindows ? {
        toastXml: buildToastXml(title, body, [
          { label: 'Allow Once', argument: 'allow-once' },
          { label: 'Open', argument: 'open' },
        ]),
      } : {}),
    });

    notification.on('action', workspaceCallback((_event, index) => {
      if (index === 0) {
        onAllowOnce?.();
      } else {
        this.bringWindowToFront(agentId);
      }
    }));

    notification.on('click', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.show();
  }

  /** Show native OS notification when an agent asks the user a question. */
  showUserInputNotification(options: UserInputNotificationOptions): void {
    assertWorkspaceContext();
    const wins = BrowserWindow.getAllWindows();
    const anyFocused = wins.some(w => w.isFocused());
    if (anyFocused) return;

    const { agentId, question } = options;

    const title = 'Question from Agent';
    const body = question || 'An agent needs your input to continue.';

    const isWindows = process.platform === 'win32';

    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(!isWindows ? {
        actions: [
          { type: 'button' as const, text: 'Open' },
        ],
      } : {}),
      ...(isWindows ? {
        toastXml: buildToastXml(title, body, [
          { label: 'Open', argument: 'open' },
        ]),
      } : {}),
    });

    notification.on('action', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.on('click', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.show();
  }

  /** Show native OS notification when an agent needs elicitation input. */
  showElicitationNotification(options: ElicitationNotificationOptions): void {
    assertWorkspaceContext();
    const wins = BrowserWindow.getAllWindows();
    const anyFocused = wins.some(w => w.isFocused());
    if (anyFocused) return;

    const { agentId, message } = options;

    const title = 'Input Needed';
    const body = message || 'An agent needs additional information to continue.';

    const isWindows = process.platform === 'win32';

    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(!isWindows ? {
        actions: [
          { type: 'button' as const, text: 'Open' },
        ],
      } : {}),
      ...(isWindows ? {
        toastXml: buildToastXml(title, body, [
          { label: 'Open', argument: 'open' },
        ]),
      } : {}),
    });

    notification.on('action', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.on('click', workspaceCallback(() => {
      this.bringWindowToFront(agentId);
    }));

    notification.show();
  }
}
