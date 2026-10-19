/* Terminal deck: a dumb pty broker for the terminal half of the StarBit
   panel, and for the Claude deck's terminal rail (one more pane, id 'rail').
   Owns a Map<paneId, IPty>; the webview owns all tab/pane state. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openFileLink, saveDrop, shellQuote } from '../openFile';

// node-pty is a native module. If it hasn't been rebuilt against VS Code's
// Electron version, require() throws — catch it so the extension still loads
// and can show friendly instructions in the webview instead of dying silently.
let pty: typeof import('node-pty') | undefined;
let ptyLoadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require('node-pty');
} catch (err: unknown) {
  ptyLoadError = err instanceof Error ? err.message : String(err);
}

type IPty = import('node-pty').IPty;

interface ReadyMsg { type: 'ready'; }
/** `plain`: skip starbit.autoCommand (the Claude deck's rail — no `claude` inside Claude). */
interface CreateMsg { type: 'create'; id: string; cols: number; rows: number; plain?: boolean; }
interface DataMsg { type: 'data'; id: string; data: string; }
interface ResizeMsg { type: 'resize'; id: string; cols: number; rows: number; }
interface KillMsg { type: 'kill'; id: string; }
interface RestartMsg { type: 'restart'; id: string; cols: number; rows: number; plain?: boolean; }
interface SetThemeMsg { type: 'setTheme'; theme: 'light' | 'dark'; }
interface OpenExternalMsg { type: 'openExternal'; url: string; }
/** `cwd`: the pane's folder, so relative paths resolve where they were printed. */
interface OpenFileMsg { type: 'openFile'; path: string; cwd?: string; }
interface DropFileMsg { type: 'dropFile'; id: string; name: string; data: string; }
interface SetBitsMsg { type: 'setBits'; bits: unknown; }
/** The path plate was edited: change the pane's working directory (validated here). */
interface CdMsg { type: 'cd'; id: string; path: string; from?: string; }
export type TerminalInboundMsg =
  | ReadyMsg | CreateMsg | DataMsg | ResizeMsg | KillMsg | RestartMsg | SetThemeMsg
  | OpenExternalMsg | OpenFileMsg | DropFileMsg | SetBitsMsg | CdMsg;

/** A command bit: a coloured ✦ key on the bar that types a command into the focused terminal. */
export interface CommandBit { label: string; command: string; color: string; }
export const BIT_COLORS = ['gold', 'mint', 'blue', 'orange', 'red', 'purple', 'cyan', 'pink'];
export const MAX_BITS = 6;

/** Keep only well-formed bits (settings.json is hand-editable). */
export function sanitizeBits(raw: unknown): CommandBit[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandBit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    const command = typeof b.command === 'string' ? b.command.trim() : '';
    if (!command) continue;
    out.push({
      label: typeof b.label === 'string' ? b.label.trim().slice(0, 40) : '',
      command: command.slice(0, 500),
      color: typeof b.color === 'string' && BIT_COLORS.includes(b.color) ? b.color : 'gold'
    });
    if (out.length >= MAX_BITS) break;
  }
  return out;
}

/** Resolve what the user typed into the path plate: `~`, relative to the pane's cwd, or absolute. */
export function resolveCdTarget(raw: string, from: string): string {
  let p = raw.trim();
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(from, p);
}

/** The `cd` line to type for a given shell (PowerShell and cmd quote differently from POSIX). */
export function cdCommand(shell: string, dir: string): string {
  const base = shell.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === 'cmd.exe' || base === 'cmd') return 'cd /d "' + dir + '"';
  if (base.startsWith('powershell') || base.startsWith('pwsh')) return "cd '" + dir.replace(/'/g, "''") + "'";
  return 'cd ' + shellQuote(dir);
}

export class TerminalDeck {
  private sessions = new Map<string, IPty>();
  /** shell + last known cwd per pane, for resolving relative paths typed into the plate */
  private meta = new Map<string, { shell: string; cwd: string }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly post: (message: object) => void
  ) {}

  public restartFocused(): void {
    this.post({ type: 'restartFocused' });
  }

  /** Send the saved command bits to the webview (on boot and whenever the setting changes). */
  public pushBits(): void {
    const raw = vscode.workspace.getConfiguration('starbit').get<unknown>('commandBits', []);
    this.post({ type: 'bits', bits: sanitizeBits(raw) });
  }

  public dispose(): void {
    this.killAll();
  }

  public handle(msg: TerminalInboundMsg): void {
    switch (msg.type) {
      case 'ready':
        // Webview (re)loaded — any surviving sessions are orphans.
        this.killAll();
        this.pushBits();
        break;
      case 'setBits':
        // the webview already re-rendered; the config change echoes back via pushBits
        void vscode.workspace
          .getConfiguration('starbit')
          .update('commandBits', sanitizeBits(msg.bits), vscode.ConfigurationTarget.Global);
        break;
      case 'create':
        this.spawnSession(msg.id, msg.cols, msg.rows, msg.plain === true);
        break;
      case 'data':
        this.sessions.get(msg.id)?.write(msg.data);
        break;
      case 'resize':
        try {
          this.sessions.get(msg.id)?.resize(msg.cols, msg.rows);
        } catch {
          /* session may have just exited; ignore */
        }
        break;
      case 'kill':
        this.killSession(msg.id);
        break;
      case 'restart':
        this.killSession(msg.id);
        this.post({ type: 'clear', id: msg.id });
        this.spawnSession(msg.id, msg.cols, msg.rows, msg.plain === true);
        break;
      case 'setTheme':
        void vscode.workspace
          .getConfiguration('starbit')
          .update('theme', msg.theme, vscode.ConfigurationTarget.Global);
        break;
      case 'openExternal':
        if (/^https?:\/\//i.test(msg.url)) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'openFile': {
        openFileLink(msg.path, msg.cwd || this.cwd())
          .then((ok) => {
            if (!ok) void vscode.window.setStatusBarMessage(`StarBit: no such file — ${msg.path}`, 3000);
          })
          .catch(() => undefined);
        break;
      }
      case 'dropFile': {
        // a file dragged from the OS: keep a copy and type its path into the shell
        try {
          const file = saveDrop(this.context, msg.name, msg.data);
          this.sessions.get(msg.id)?.write(shellQuote(file) + ' ');
        } catch (err: unknown) {
          void vscode.window.showWarningMessage(
            'StarBit: could not save dropped file: ' + (err instanceof Error ? err.message : String(err))
          );
        }
        break;
      }
      case 'cd': {
        // typed into the path plate: only type `cd` if the folder really exists
        const session = this.sessions.get(msg.id);
        const meta = this.meta.get(msg.id);
        if (!session || !meta) {
          this.post({ type: 'cwdError', id: msg.id, path: msg.path, reason: 'no shell' });
          break;
        }
        const target = resolveCdTarget(msg.path, msg.from || meta.cwd);
        let isDir = false;
        try {
          isDir = fs.statSync(target).isDirectory();
        } catch {
          /* missing */
        }
        if (!isDir) {
          this.post({ type: 'cwdError', id: msg.id, path: msg.path, reason: 'not a folder' });
          break;
        }
        meta.cwd = target;
        session.write(cdCommand(meta.shell, target) + '\r');
        this.post({ type: 'cwd', id: msg.id, cwd: target });
        break;
      }
    }
  }

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private killSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.delete(id);
    this.meta.delete(id);
    try {
      session.kill();
    } catch {
      /* already dead */
    }
  }

  private killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.killSession(id);
    }
  }

  private spawnSession(id: string, cols: number, rows: number, plain = false): void {
    if (this.sessions.has(id)) {
      return;
    }

    if (!pty) {
      this.post({
        type: 'spawnError',
        id,
        message:
          'node-pty could not be loaded. It probably needs to be rebuilt for ' +
          "VS Code's Electron version — see the README (npx @electron/rebuild " +
          '-v <electron-version> -f -w node-pty).\n\nDetails: ' + ptyLoadError
      });
      return;
    }

    const config = vscode.workspace.getConfiguration('starbit');
    const isWindows = process.platform === 'win32';
    const shell =
      config.get<string>('shell')?.trim() ||
      (isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
    const autoCommand = plain ? '' : config.get<string>('autoCommand', '').trim();
    const cwd = this.cwd();

    try {
      const session = pty.spawn(shell, isWindows ? [] : ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM_PROGRAM: 'starbit-terminal' } as Record<string, string>
      });
      this.sessions.set(id, session);
      this.meta.set(id, { shell, cwd });

      session.onData((data) => this.post({ type: 'output', id, data }));
      session.onExit(({ exitCode }) => {
        // Only report if this session wasn't replaced/killed on purpose.
        if (this.sessions.get(id) === session) {
          this.sessions.delete(id);
          this.meta.delete(id);
          this.post({ type: 'exited', id, code: exitCode });
        }
      });

      this.post({ type: 'started', id, shell, cwd });

      if (autoCommand) {
        setTimeout(() => {
          if (this.sessions.get(id) === session) session.write(autoCommand + '\r');
        }, 350);
      }
    } catch (err: unknown) {
      this.post({
        type: 'spawnError',
        id,
        message:
          `Could not start "${shell}": ` +
          (err instanceof Error ? err.message : String(err))
      });
    }
  }

  /** The deck's markup: bar (with the deck switch) + tray. Element hooks are classes. */
  public bodyHtml(switchHtml: string): string {
    return /* html */ `
  <header class="bar">
    ${switchHtml}
    <nav class="tabs" aria-label="Terminals"></nav>
    <nav class="bits" aria-label="Command bits"></nav>
    <div class="spacer"></div>
    <span class="statusText status-plate cwd-plate" role="button" tabindex="0" title="Working directory — click to type a new one"></span>
    <input class="cwdInput status-plate cwd-input" type="text" placeholder="cd to… (~, relative, or absolute)" spellcheck="false" autocomplete="off" hidden />
    <button class="splitBtn key" title="Split terminal">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="5.4" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="9.1" y="2.5" width="5.4" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>
    </button>
    <button class="restartBtn key" title="Restart focused terminal">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.7-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13.4 1.6v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="themeBtn key" title="Switch light / dark theme">
      <svg class="ico-sun" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <svg class="ico-moon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" fill="currentColor"/></svg>
    </button>
  </header>

  <div class="bit-editor" hidden>
    <div class="bit-editor-title">new command bit</div>
    <input class="bit-label" type="text" placeholder="label (shown on hover)" maxlength="40" spellcheck="false" />
    <input class="bit-command" type="text" placeholder="command, e.g. npm test" maxlength="500" spellcheck="false" />
    <div class="bit-colors" role="radiogroup" aria-label="Colour"></div>
    <div class="bit-editor-keys">
      <button class="bit-remove key" type="button" hidden>remove</button>
      <button class="bit-cancel key" type="button">cancel</button>
      <button class="bit-save key key-claude" type="button">save</button>
    </div>
  </div>

  <main class="tray"></main>`;
  }
}
