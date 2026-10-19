/* Claude deck: the Agent-SDK half of the StarBit panel. Dumb SDK broker;
   the webview owns all transcript state. */

import * as vscode from 'vscode';
import * as os from 'os';
import { SessionManager } from './SessionManager';
import { resolveClaude } from './resolveClaude';
import { readHistory } from './transcript';
import { openFileLink, readTheme, saveDrop } from '../openFile';
import type { InboundMsg, OutboundMsg, RailsState, ResumableSession } from './protocol';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

const RESUME_KEY = 'starbit.claude.sessions';
const MAX_RESUMABLE = 6;
const RAILS_KEY = 'starbit.railsCollapsed';
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export class ClaudeDeck {
  private readonly manager = new SessionManager();
  /** toolUseID → session id, for prompts waiting on the user (drives the panel badge). */
  private readonly waiting = new Map<string, string>();
  /** Sockets whose process is still starting → prompts sent meanwhile (flushed once it is up). */
  private readonly starting = new Map<string, string[]>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly post: (message: OutboundMsg) => void,
    private readonly setBadge: (n: number) => void
  ) {}

  /* ---- public, for commands --------------------------------------- */

  newSession(): void {
    this.post({ type: 'newSession' });
  }

  stopSession(): void {
    this.post({ type: 'stopSession' });
  }

  /** `starbit.claude.sidePanels` changed: show or hide the side rails (stats + terminal). */
  pushSidePanels(): void {
    this.post({ type: 'sidePanels', on: this.sidePanels() });
  }

  selfTest(): Promise<string> {
    const config = vscode.workspace.getConfiguration('starbit');
    return this.manager.selfTest(config.get<string>('claudePath', ''), this.cwd(), this.clientApp());
  }

  dispose(): void {
    this.manager.killAll();
    this.starting.clear();
    this.waiting.clear();
    this.setBadge(0);
  }

  /* ---- helpers ------------------------------------------------------ */

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private updateBadge(): void {
    this.setBadge(this.waiting.size);
  }

  /** Drop a session's waiting prompts. A killed session posts nothing more (not even
      sessionEnded), so kill/re-create must clear its prompts here or the badge sticks. */
  private forget(id: string): void {
    for (const [t, sid] of Array.from(this.waiting)) {
      if (sid === id) this.waiting.delete(t);
    }
    this.updateBadge();
  }

  /** settings.json is hand-editable: fall back to `default` for anything unknown. */
  private defaultMode(): PermissionMode {
    const m = vscode.workspace.getConfiguration('starbit').get<PermissionMode>('claude.defaultMode', 'default');
    return MODES.includes(m) ? m : 'default';
  }

  /** Identifies this extension to the Agent SDK. */
  private clientApp(): string {
    return 'starbit-terminal/' + String(this.context.extension.packageJSON.version);
  }

  private sidePanels(): boolean {
    return vscode.workspace.getConfiguration('starbit').get<boolean>('claude.sidePanels', true);
  }

  private rails(): RailsState {
    const r = this.context.globalState.get<Partial<RailsState>>(RAILS_KEY, {});
    const px = Number(r.termPx);
    return { stats: r.stats === true, term: r.term === true, termPx: px > 0 ? Math.round(px) : 0 };
  }

  private resumable(): ResumableSession[] {
    return this.context.workspaceState.get<ResumableSession[]>(RESUME_KEY, []);
  }

  private remember(sessionId: string, title: string): void {
    const list = this.resumable().filter((r) => r.id !== sessionId);
    list.unshift({ id: sessionId, title: title.slice(0, 80), at: Date.now() });
    const items = list.slice(0, MAX_RESUMABLE);
    void this.context.workspaceState.update(RESUME_KEY, items);
    this.post({ type: 'resumable', items });
  }

  /* ---- message routing --------------------------------------------- */

  async handle(msg: InboundMsg): Promise<void> {
    const config = vscode.workspace.getConfiguration('starbit');

    switch (msg.type) {
      case 'ready': {
        // Webview (re)loaded — any surviving sessions are orphans.
        this.manager.killAll();
        this.starting.clear();
        this.waiting.clear();
        this.updateBadge();
        // warm the lookup (a login-shell run) so the first session starts sooner
        resolveClaude(config.get<string>('claudePath', '')).catch(() => undefined);
        this.post({
          type: 'boot',
          theme: readTheme(),
          cwd: this.cwd(),
          defaultMode: this.defaultMode(),
          model: config.get<string>('claude.model', ''),
          resumable: this.resumable(),
          sidePanels: this.sidePanels(),
          rails: this.rails()
        });
        break;
      }

      case 'create': {
        const id = msg.id;
        this.forget(id); // a re-created socket starts with no prompts
        const queue: string[] = [];
        this.starting.set(id, queue);
        // resuming: show the old transcript right away (the SDK does not replay it)
        if (msg.resume) {
          const items = readHistory(msg.resume);
          if (items.length) this.post({ type: 'history', id, items });
        }
        try {
          const loc = await resolveClaude(config.get<string>('claudePath', ''));
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: loc.loginPath || process.env.PATH,
            CLAUDE_AGENT_SDK_CLIENT_APP: this.clientApp()
          };
          let firstText = '';
          const session = await this.manager.create({
            id,
            cwd: this.cwd(),
            exe: loc.exe,
            env,
            resume: msg.resume,
            permissionMode: this.defaultMode(),
            model: config.get<string>('claude.model', ''),
            debug: config.get<boolean>('claude.debug', false),
            post: (m) => {
              if (m.type === 'ask') this.waiting.set(m.ask.toolUseID, id);
              if (m.type === 'askCancelled') this.waiting.delete(m.toolUseID);
              if (m.type === 'sessionEnded') this.forget(id);
              else this.updateBadge();
              this.post(m);
            },
            onInit: (sessionId) => this.remember(sessionId, firstText || 'session')
          });
          // remember the first prompt as the session title once it is sent
          const origSend = session.send.bind(session);
          session.send = (text: string) => {
            if (!firstText) {
              firstText = text;
              if (session.sessionId) this.remember(session.sessionId, firstText);
            }
            origSend(text);
          };
          if (this.starting.get(id) === queue) {
            this.starting.delete(id);
            for (const text of queue) session.send(text);
          } else if (!this.starting.has(id) && this.manager.get(id) === session) {
            this.manager.kill(id); // the socket was closed while its process was starting
            break;
          }
          // tell the webview the process is up (system/init only comes with the first turn)
          try {
            const info = await session.initInfo();
            if (this.manager.get(id) === session) {
              this.post({
                type: 'sessionInfo',
                id,
                mode: this.defaultMode(),
                commands: (info.commands ?? []).map((c) => ({
                  name: c.name,
                  description: c.description,
                  argumentHint: c.argumentHint
                })),
                models: (info.models ?? []).map((m) => ({
                  value: m.value,
                  displayName: m.displayName,
                  description: m.description
                }))
              });
            }
          } catch {
            /* the session will report its own error through the pump */
          }
        } catch (err: unknown) {
          if (this.starting.get(id) === queue) this.starting.delete(id);
          this.post({
            type: 'spawnError',
            id,
            message:
              'Could not start Claude Code.\n\n' +
              (err instanceof Error ? err.message : String(err)) +
              '\n\nCheck that `claude` runs in a terminal, or set starbit.claudePath.'
          });
        }
        break;
      }

      case 'send': {
        // typed before the process is up (the first SDK load can take a moment): hold it
        const queue = this.starting.get(msg.id);
        if (queue) queue.push(msg.text);
        else this.manager.get(msg.id)?.send(msg.text);
        break;
      }

      case 'answer': {
        const s = this.manager.get(msg.id);
        if (s?.answer(msg.toolUseID, msg.result)) {
          this.waiting.delete(msg.toolUseID);
          this.updateBadge();
        }
        break;
      }

      case 'interrupt':
        void this.manager.get(msg.id)?.interrupt();
        break;

      case 'setMode':
        void this.manager.get(msg.id)?.setMode(msg.mode).catch(() => undefined);
        break;

      case 'setModel':
        void this.manager.get(msg.id)?.setModel(msg.model).catch(() => undefined);
        break;

      case 'kill':
        this.starting.delete(msg.id);
        this.manager.kill(msg.id);
        this.forget(msg.id);
        break;

      case 'rails': {
        const px = Number(msg.termPx);
        void this.context.globalState.update(RAILS_KEY, {
          stats: msg.stats === true,
          term: msg.term === true,
          termPx: Number.isFinite(px) && px > 0 ? Math.round(px) : 0
        });
        break;
      }

      case 'setTheme':
        void config.update('theme', msg.theme === 'dark' ? 'dark' : 'light', vscode.ConfigurationTarget.Global);
        break;

      case 'openFile': {
        const ok = await openFileLink(msg.path, this.cwd());
        if (!ok) void vscode.window.setStatusBarMessage(`StarBit: no such file — ${msg.path}`, 3000);
        break;
      }

      case 'dropFile': {
        try {
          const file = saveDrop(this.context, msg.name, msg.data);
          this.post({ type: 'dropped', id: msg.id, path: file });
        } catch (err: unknown) {
          void vscode.window.showWarningMessage(
            'StarBit: could not save dropped file: ' + (err instanceof Error ? err.message : String(err))
          );
        }
        break;
      }
    }
  }

  /* ---- html --------------------------------------------------------- */

  /** The deck's markup: bar (with the deck switch) + tray. Element hooks are classes. */
  bodyHtml(switchHtml: string): string {
    return /* html */ `
  <header class="bar">
    ${switchHtml}
    <button class="homeBtn key key-home" title="Home — back to recent chats" disabled>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.2 8.1 8 2.9l5.8 5.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 7.6v5.2a.9.9 0 0 0 .9.9h2.2V10h1.8v3.7h2.2a.9.9 0 0 0 .9-.9V7.6" fill="currentColor"/></svg>
    </button>
    <nav class="tabs" aria-label="Claude sessions"></nav>
    <div class="spacer"></div>
    <span class="statusText status-plate"></span>
    <button class="modeBtn key key-mode" title="Permission mode (click to cycle)">ask</button>
    <button class="modelBtn key key-model" title="Model">model</button>
    <button class="stopBtn key key-stop" title="Stop the current turn" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.2" fill="currentColor"/></svg>
    </button>
    <button class="themeBtn key" title="Switch light / dark theme">
      <svg class="ico-sun" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <svg class="ico-moon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" fill="currentColor"/></svg>
    </button>
  </header>

  <main class="tray">
    <aside class="rail rail-stats" aria-label="Session stats" hidden></aside>
    <div class="stage"></div>
    <aside class="rail rail-term" aria-label="Terminal" hidden></aside>
    <div class="composer">
      <textarea class="composer-input" rows="1" placeholder="ask claude…" spellcheck="false"></textarea>
      <button class="sendBtn key key-claude" title="Send (Enter)">send</button>
    </div>
    <div class="pop" hidden></div>
  </main>`;
  }
}
