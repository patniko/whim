/**
 * Cross-platform terminal launcher.
 */

import { spawn, execSync, execFileSync } from 'child_process';

export interface TerminalLaunchOptions {
  /** Executable to run (e.g. the CLI path) */
  command: string;
  /** Arguments to pass to the command; each is quoted for the target shell */
  args?: string[];
  /** Working directory for the terminal */
  cwd: string;
  /** Optional window/tab title */
  title?: string;
  /** Optional file path to touch when the command exits (exit signal) */
  signalPath?: string;
}

export interface TerminalLaunchResult {
  /** PID of the launched process (0 on macOS where real PID is resolved async) */
  pid?: number;
}

/**
 * Launch a command in the platform's native terminal.
 * - macOS: uses AppleScript to open Terminal.app
 * - Windows: uses PowerShell to open cmd.exe
 * - Linux: tries common terminals (gnome-terminal, konsole, xfce4-terminal, xterm, etc.)
 */
export async function launchInTerminal(options: TerminalLaunchOptions): Promise<TerminalLaunchResult> {
  switch (process.platform) {
    case 'darwin':
      return launchMacOS(options);
    case 'win32':
      return launchWindows(options);
    default:
      return launchLinux(options);
  }
}

// ── Shell escaping ──────────────────────────────────────

/** Escape a string for use inside single-quoted POSIX shell arguments */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for use inside PowerShell single-quoted strings (double the quotes) */
export function powershellEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Quote one argument for a cmd.exe command line. Plain tokens stay readable;
 * anything else (spaces in an install path, `?` and `&` in a URL) is wrapped in
 * double quotes, inside which cmd treats its operators as literal text.
 */
export function cmdQuote(arg: string): string {
  if (arg.includes('"')) throw new Error('Terminal arguments cannot contain double quotes');
  return /^[A-Za-z0-9_\-+=.,:/\\@]+$/.test(arg) ? arg : `"${arg}"`;
}

/** Quote a string as an AppleScript string literal. */
function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function posixCommand(options: TerminalLaunchOptions): string {
  return [options.command, ...(options.args || [])].map(shellEscape).join(' ');
}

function windowsCommand(options: TerminalLaunchOptions): string {
  return [options.command, ...(options.args || [])].map(cmdQuote).join(' ');
}

// ── macOS: AppleScript + Terminal.app ───────────────────

function launchMacOS(options: TerminalLaunchOptions): TerminalLaunchResult {
  const exitSignal = options.signalPath ? ` ; touch ${shellEscape(options.signalPath)}` : '';
  const shellCommand = `cd ${shellEscape(options.cwd)} && ${posixCommand(options)}${exitSignal}`;
  const script = `tell application "Terminal"
    do script ${appleScriptString(shellCommand)}
    activate
  end tell`;

  try {
    execFileSync('osascript', ['-e', script], { timeout: 10_000 });
  } catch (err) {
    console.error('[platform/terminal] macOS launch failed:', err);
    return {};
  }

  // On macOS we cannot get the PID synchronously because Terminal.app spawns
  // the shell process asynchronously. Return pid=0 as a placeholder — callers
  // that need the real PID should poll with pgrep.
  return { pid: 0 };
}

// ── Windows: PowerShell + cmd.exe ───────────────────────

function launchWindows(options: TerminalLaunchOptions): TerminalLaunchResult {
  const exitSignal = options.signalPath ? ` & echo.>${cmdQuote(options.signalPath)}` : '';
  // `/s` strips only the outermost quotes, so every quoted argument survives.
  const cmdArgs = `/s /k "${windowsCommand(options)}${exitSignal}"`;
  // Stop makes a failed Start-Process exit non-zero, so its error is reported;
  // progress records would otherwise reach stderr as CLIXML noise.
  const script = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${powershellEscape(cmdArgs)}' -WorkingDirectory '${powershellEscape(options.cwd)}' -PassThru; $p.Id`;
  // Passed as UTF-16 base64, the script keeps non-ASCII paths intact (stdin
  // would be read in the console's code page) and its text never meets another
  // command line's quoting rules.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();

    const pid = parseInt(output, 10);
    if (pid && !isNaN(pid)) {
      return { pid };
    }
  } catch (err) {
    console.error('[platform/terminal] Windows launch failed:', err);
  }
  return {};
}

// ── Linux: try common terminal emulators ────────────────

interface LinuxLauncher {
  cmd: string;
  buildArgs: (shellCommand: string) => string[];
}

const LINUX_LAUNCHERS: LinuxLauncher[] = [
  {
    cmd: 'gnome-terminal',
    buildArgs: (c) => ['--', 'bash', '-c', c],
  },
  {
    cmd: 'konsole',
    buildArgs: (c) => ['-e', 'bash', '-c', c],
  },
  {
    cmd: 'xfce4-terminal',
    buildArgs: (c) => ['-e', `bash -c ${shellEscape(c)}`],
  },
  {
    cmd: 'x-terminal-emulator',
    buildArgs: (c) => ['-e', `bash -c ${shellEscape(c)}`],
  },
  {
    cmd: 'xterm',
    buildArgs: (c) => ['-e', `bash -c ${shellEscape(c)}`],
  },
];

function launchLinux(options: TerminalLaunchOptions): TerminalLaunchResult {
  const exitSignal = options.signalPath
    ? ` ; touch ${shellEscape(options.signalPath)}`
    : '';
  const command = `cd ${shellEscape(options.cwd)} && ${posixCommand(options)}${exitSignal}`;

  for (const launcher of LINUX_LAUNCHERS) {
    try {
      execSync(`which ${launcher.cmd}`, { timeout: 2_000, stdio: 'ignore' });

      const proc = spawn(launcher.cmd, launcher.buildArgs(command), {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();

      if (proc.pid) {
        return { pid: proc.pid };
      }
    } catch {
      continue;
    }
  }

  console.error('[platform/terminal] No terminal emulator found on Linux');
  return {};
}
