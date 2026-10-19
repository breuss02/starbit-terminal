/* Find the Claude Code native binary and the user's login-shell PATH.

   The Agent SDK spawns a native `claude` binary. We point it at the copy the
   user already has installed (so the VSIX stays small and the SDK/CLI
   versions stay in step) instead of the optional platform package.

   Order: starbit.claudePath setting → login shell `command -v claude` →
   ~/.local/bin/claude → let the SDK try its own optional package. */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ClaudeLocation {
  /** Absolute path to the binary, or '' to let the SDK resolve its own. */
  exe: string;
  /** PATH as seen by the user's login shell, if we could read it. */
  loginPath?: string;
  source: 'setting' | 'shell' | 'home' | 'sdk';
}

let cached: { configured: string; loc: Promise<ClaudeLocation> } | undefined;

/** Cached per `starbit.claudePath` value, so changing the setting takes effect without a reload. */
export function resolveClaude(configured: string, force = false): Promise<ClaudeLocation> {
  if (!cached || force || cached.configured !== configured) {
    cached = { configured, loc: doResolve(configured) };
  }
  return cached.loc;
}

function realOrUndefined(p: string): string | undefined {
  try {
    const real = fs.realpathSync(p);
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    return undefined;
  }
}

/** Run the user's login shell once to learn PATH and where `claude` lives. */
function shellLookup(): Promise<{ exe?: string; loginPath?: string }> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('where.exe', ['claude'], { timeout: 6000 }, (err, stdout) => {
        const first = !err ? stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) : undefined;
        resolve({ exe: first ? realOrUndefined(first) : undefined });
      });
      return;
    }
    const shell = process.env.SHELL || '/bin/zsh';
    const script = 'command -v claude; printf "\\n__PATH__%s\\n" "$PATH"';
    execFile(shell, ['-lc', script], { timeout: 8000 }, (err, stdout) => {
      const lines = (stdout || '').split('\n');
      const pathLine = lines.find((l) => l.startsWith('__PATH__'));
      const exeLine = lines.map((l) => l.trim()).find((l) => l && !l.startsWith('__PATH__'));
      resolve({
        exe: !err && exeLine ? realOrUndefined(exeLine) : undefined,
        loginPath: pathLine ? pathLine.slice('__PATH__'.length) : undefined
      });
    });
  });
}

async function doResolve(configured: string): Promise<ClaudeLocation> {
  const shell = await shellLookup();

  const fromSetting = configured.trim() ? realOrUndefined(configured.trim()) : undefined;
  if (fromSetting) {
    return { exe: fromSetting, loginPath: shell.loginPath, source: 'setting' };
  }
  if (shell.exe) {
    return { exe: shell.exe, loginPath: shell.loginPath, source: 'shell' };
  }
  const home = realOrUndefined(path.join(os.homedir(), '.local', 'bin', 'claude'));
  if (home) {
    return { exe: home, loginPath: shell.loginPath, source: 'home' };
  }
  return { exe: '', loginPath: shell.loginPath, source: 'sdk' };
}
