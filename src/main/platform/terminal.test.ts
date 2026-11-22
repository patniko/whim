import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────

const { mockExecSync, mockExecFileSync, mockSpawn } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

import {
  launchInTerminal,
  shellEscape,
  powershellEscape,
  cmdQuote,
  type TerminalLaunchOptions,
} from './terminal';

// ── Helpers ─────────────────────────────────────────────

const baseOptions: TerminalLaunchOptions = {
  command: '/usr/local/bin/copilot',
  args: ['--resume=abc-123'],
  cwd: '/home/user/project',
};

function stubPlatform(value: string) {
  return vi.spyOn(process, 'platform', 'get').mockReturnValue(value as NodeJS.Platform);
}

describe('shellEscape', () => {
  it('wraps strings in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it('handles multiple single quotes', () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('handles paths with spaces', () => {
    expect(shellEscape('/my path/to dir')).toBe("'/my path/to dir'");
  });
});

describe('cmdQuote', () => {
  it('leaves plain tokens readable', () => {
    expect(cmdQuote('--resume=abc-123')).toBe('--resume=abc-123');
    expect(cmdQuote('C:\\Whim\\copilot.exe')).toBe('C:\\Whim\\copilot.exe');
  });

  it('quotes paths with spaces and URLs carrying cmd metacharacters', () => {
    expect(cmdQuote('C:\\Program Files\\Whim\\copilot.exe')).toBe('"C:\\Program Files\\Whim\\copilot.exe"');
    expect(cmdQuote('ws://127.0.0.1:1/?tkn=a&b')).toBe('"ws://127.0.0.1:1/?tkn=a&b"');
  });

  it('refuses a double quote it cannot carry safely', () => {
    expect(() => cmdQuote('say "hi"')).toThrow('double quotes');
  });
});

describe('powershellEscape', () => {
  it('doubles single quotes', () => {
    expect(powershellEscape("it's here")).toBe("it''s here");
  });

  it('returns plain string if no quotes', () => {
    expect(powershellEscape('hello')).toBe('hello');
  });
});

describe('launchInTerminal', () => {
  let platformSpy: ReturnType<typeof stubPlatform>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    platformSpy?.mockRestore();
  });

  // ── macOS ───────────────────────────────────────────

  describe('macOS', () => {
    beforeEach(() => {
      platformSpy = stubPlatform('darwin');
    });

    it('runs the command in Terminal with every argument quoted for the shell', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const result = await launchInTerminal({
        command: '/Applications/Whim Beta.app/copilot',
        args: ['--ahp', 'ws://127.0.0.1:1/?tkn=abc'],
        cwd: "/Users/o'neil/project",
      });

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [file, args] = mockExecFileSync.mock.calls[0] as [string, string[]];
      expect(file).toBe('osascript');
      expect(args[0]).toBe('-e');
      expect(args[1]).toContain('tell application "Terminal"');
      expect(args[1]).toContain(`do script "cd '/Users/o'\\\\''neil/project' && '/Applications/Whim Beta.app/copilot' '--ahp' 'ws://127.0.0.1:1/?tkn=abc'"`);
      expect(result.pid).toBe(0);
    });

    it('includes exit signal when signalPath is provided', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      await launchInTerminal({ ...baseOptions, signalPath: '/path/to/signal' });

      const script = (mockExecFileSync.mock.calls[0][1] as string[])[1];
      expect(script).toContain("; touch '/path/to/signal'");
    });

    it('returns empty result on failure', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('osascript failed');
      });

      const result = await launchInTerminal(baseOptions);

      expect(result.pid).toBeUndefined();
    });
  });

  // ── Windows ─────────────────────────────────────────

  describe('Windows', () => {
    beforeEach(() => {
      platformSpy = stubPlatform('win32');
    });

    it('starts cmd.exe through an encoded PowerShell script with quoted arguments and returns PID', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('12345'));

      const result = await launchInTerminal({
        command: 'C:\\Program Files\\Whim\\copilot.exe',
        args: ['--ahp', 'ws://127.0.0.1:1/?tkn=abc', '--resume=abc-123'],
        cwd: "C:\\Users\\Jürgen o'neil",
        signalPath: 'C:\\Users\\o neil\\exit',
      });

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [file, args] = mockExecFileSync.mock.calls[0] as [string, string[]];
      expect(file).toBe('powershell.exe');
      expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      // UTF-16 base64 keeps non-ASCII paths intact on the way to PowerShell.
      const script = Buffer.from(args[3], 'base64').toString('utf16le');
      expect(script).toContain(
        `-ArgumentList '/s /k ""C:\\Program Files\\Whim\\copilot.exe" --ahp "ws://127.0.0.1:1/?tkn=abc" --resume=abc-123 & echo.>"C:\\Users\\o neil\\exit""'`,
      );
      expect(script).toContain("-WorkingDirectory 'C:\\Users\\Jürgen o''neil'");
      expect(result.pid).toBe(12345);
    });

    it('returns empty result when powershell fails', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('powershell failed');
      });

      const result = await launchInTerminal(baseOptions);

      expect(result.pid).toBeUndefined();
    });

    it('returns empty result when output is not a number', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('not-a-pid'));

      const result = await launchInTerminal(baseOptions);

      expect(result.pid).toBeUndefined();
    });
  });

  // ── Linux ───────────────────────────────────────────

  describe('Linux', () => {
    beforeEach(() => {
      platformSpy = stubPlatform('linux');
    });

    it('tries gnome-terminal first and returns PID', async () => {
      // `which gnome-terminal` succeeds
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/gnome-terminal'));
      const mockProc = { pid: 9999, unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      const result = await launchInTerminal(baseOptions);

      expect(mockExecSync).toHaveBeenCalledWith(
        'which gnome-terminal',
        expect.any(Object),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'gnome-terminal',
        expect.arrayContaining(['--', 'bash', '-c', expect.stringContaining('--resume=abc-123')]),
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
      expect(result.pid).toBe(9999);
    });

    it('falls back to next launcher when first is not found', async () => {
      // gnome-terminal not found, konsole found
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('not found'); }) // gnome-terminal
        .mockReturnValueOnce(Buffer.from('/usr/bin/konsole'));           // konsole
      const mockProc = { pid: 7777, unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      const result = await launchInTerminal(baseOptions);

      expect(mockSpawn).toHaveBeenCalledWith(
        'konsole',
        expect.any(Array),
        expect.any(Object),
      );
      expect(result.pid).toBe(7777);
    });

    it('returns empty result when no terminal is found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = await launchInTerminal(baseOptions);

      expect(result.pid).toBeUndefined();
    });

    it('includes exit signal path in command', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/gnome-terminal'));
      const mockProc = { pid: 5555, unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      await launchInTerminal({ ...baseOptions, signalPath: '/sig' });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const shellCmd = args[args.length - 1];
      expect(shellCmd).toBe("cd '/home/user/project' && '/usr/local/bin/copilot' '--resume=abc-123' ; touch '/sig'");
    });
  });
});
