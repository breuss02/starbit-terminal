/* The one StarBit panel view. It hosts two "decks" in a single webview —
   the terminal deck and the Claude deck — and a switch in the bar flips
   between them. Each deck keeps its own message protocol; messages are
   namespaced with `via: 'term' | 'claude'` in both directions. Messages
   without `via` (theme, deck switching) are broadcast. */

import * as vscode from 'vscode';
import { TerminalDeck } from './terminal/TerminalDeck';
import { ClaudeDeck } from './claude/ClaudeDeck';
import { readTheme } from './openFile';

export type DeckName = 'term' | 'claude';
const DECK_KEY = 'starbit.deck';

export class StarBitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'starbit.view';

  private view?: vscode.WebviewView;
  readonly terminal: TerminalDeck;
  readonly claude: ClaudeDeck;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.terminal = new TerminalDeck(context, (m) => this.post('term', m));
    this.claude = new ClaudeDeck(
      context,
      (m) => this.post('claude', m),
      (n) => this.setBadge(n)
    );
  }

  /* ---- public ------------------------------------------------------- */

  showDeck(name: DeckName): void {
    void this.context.workspaceState.update(DECK_KEY, name);
    this.broadcast({ type: 'showDeck', deck: name });
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.broadcast({ type: 'setTheme', theme });
  }

  /** Kill every shell and Claude process (view disposed, or the extension deactivating). */
  dispose(): void {
    this.terminal.dispose();
    this.claude.dispose();
  }

  /* ---- view lifecycle ---------------------------------------------- */

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm')
      ]
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; via?: string; deck?: string }) => {
      if (msg.type === 'deck') {
        void this.context.workspaceState.update(DECK_KEY, msg.deck === 'claude' ? 'claude' : 'term');
        return;
      }
      if (msg.via === 'term') this.terminal.handle(msg as never);
      else if (msg.via === 'claude') this.claude.handle(msg as never).catch((e) => console.error('[starbit]', e));
    });

    webviewView.onDidDispose(() => {
      this.view = undefined; // first: disposing the decks clears the badge, which needs a live view
      this.dispose();
    });
  }

  private post(via: DeckName, message: object): void {
    void this.view?.webview.postMessage({ ...message, via });
  }

  private broadcast(message: object): void {
    void this.view?.webview.postMessage(message);
  }

  private setBadge(n: number): void {
    if (!this.view) return;
    this.view.badge = n
      ? { value: n, tooltip: n === 1 ? 'Claude is waiting for you' : `${n} prompts waiting for you` }
      : undefined;
  }

  /* ---- html --------------------------------------------------------- */

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts));

    const config = vscode.workspace.getConfiguration('starbit');
    const theme = readTheme();
    const fontFamily = String(config.get<string>('fontFamily', 'monospace'));
    const fontSize = Number(config.get<number>('fontSize', 13.5)) || 13.5;
    const deck = this.context.workspaceState.get<DeckName>(DECK_KEY, 'term');

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`
    ].join('; ');

    const switchHtml = /* html */ `
    <div class="deck-switch" role="tablist" aria-label="StarBit decks">
      <button class="key switch-key" data-deck="term" title="Terminals" role="tab">&gt;_<span class="sel"></span></button>
      <button class="key switch-key" data-deck="claude" title="Claude" role="tab">&#x2726;<span class="sel"></span></button>
    </div>`;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${uri('node_modules', '@xterm', 'xterm', 'css', 'xterm.css')}" />
  <link rel="stylesheet" href="${uri('media', 'tokens.css')}" />
  <link rel="stylesheet" href="${uri('media', 'chrome.css')}" />
  <link rel="stylesheet" href="${uri('media', 'style.css')}" />
  <link rel="stylesheet" href="${uri('media', 'claude', 'claude.css')}" />
</head>
<body data-theme="${theme}"
      data-deck="${deck}"
      data-font-family='${fontFamily.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}'
      data-font-size="${fontSize}">

  <section class="deck" data-deck="term" id="deck-term">
${this.terminal.bodyHtml(switchHtml)}
  </section>

  <section class="deck" data-deck="claude" id="deck-claude">
${this.claude.bodyHtml(switchHtml)}
  </section>

  <script src="${uri('node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')}"></script>
  <script src="${uri('node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')}"></script>
  <script src="${uri('node_modules', '@xterm', 'addon-web-links', 'lib', 'addon-web-links.js')}"></script>
  <script src="${uri('media', 'shared.js')}"></script>
  <script src="${uri('media', 'main.js')}"></script>
  <script src="${uri('media', 'claude', 'markdown.js')}"></script>
  <script src="${uri('media', 'claude', 'stats.js')}"></script>
  <script src="${uri('media', 'claude', 'termrail.js')}"></script>
  <script src="${uri('media', 'claude', 'main.js')}"></script>
</body>
</html>`;
  }
}
