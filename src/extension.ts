import * as vscode from 'vscode';
import { StarBitViewProvider } from './StarBitViewProvider';
import { readTheme } from './openFile';

export function activate(context: vscode.ExtensionContext): void {
  const panel = new StarBitViewProvider(context);
  const focus = () => vscode.commands.executeCommand('starbit.view.focus');

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StarBitViewProvider.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    // terminal deck
    vscode.commands.registerCommand('starbit.open', async () => {
      await focus();
      panel.showDeck('term');
    }),
    vscode.commands.registerCommand('starbit.restart', () => {
      panel.terminal.restartFocused();
    }),

    // claude deck
    vscode.commands.registerCommand('starbit.claude.open', async () => {
      await focus();
      panel.showDeck('claude');
    }),
    vscode.commands.registerCommand('starbit.claude.new', async () => {
      await focus();
      panel.showDeck('claude');
      panel.claude.newSession();
    }),
    vscode.commands.registerCommand('starbit.claude.stop', () => {
      panel.claude.stopSession();
    }),
    vscode.commands.registerCommand('starbit.claude.selftest', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'StarBit: checking Claude Code…' },
        async () => {
          try {
            const summary = await panel.claude.selfTest();
            void vscode.window.showInformationMessage('StarBit Claude OK — ' + summary);
          } catch (err: unknown) {
            void vscode.window.showErrorMessage(
              'StarBit Claude self-test failed: ' + (err instanceof Error ? err.message : String(err))
            );
          }
        }
      );
    }),

    // one theme setting, pushed to both decks whenever it changes; the command
    // bits go to the terminal deck and the side-rails switch to the Claude deck
    // (all are editable in settings.json too)
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('starbit.theme')) panel.setTheme(readTheme());
      if (e.affectsConfiguration('starbit.commandBits')) panel.terminal.pushBits();
      if (e.affectsConfiguration('starbit.claude.sidePanels')) panel.claude.pushSidePanels();
    }),

    // a reload or disable does not always dispose the view first
    { dispose: () => panel.dispose() }
  );
}

export function deactivate(): void {
  /* shells and Claude processes are killed via context.subscriptions */
}
