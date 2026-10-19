/* Shared helpers for both decks: open a file path (with optional :line:col)
   in an editor, save a dropped/pasted file so its path can be handed to the
   shell or to Claude, and read the theme setting. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Open `raw` (absolute, ~, or relative to `cwd`) in VS Code. Returns false if it does not exist. */
export async function openFileLink(raw: string, cwd: string): Promise<boolean> {
  let p = raw.trim().replace(/^['"(<\[]+|['")>\],.;:]+$/g, '');
  let line: number | undefined;
  let col: number | undefined;
  const m = p.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (m && m[2]) {
    p = m[1];
    line = Number(m[2]);
    col = m[3] ? Number(m[3]) : undefined;
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  const uri = vscode.Uri.file(abs);
  if (stat.isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return true;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, Math.max(0, (col ?? 1) - 1));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    // binary (images etc.): let VS Code pick a viewer
    await vscode.commands.executeCommand('vscode.open', uri);
  }
  return true;
}

/** Persist a dropped/pasted file under the extension's global storage and return its path. */
export function saveDrop(context: vscode.ExtensionContext, name: string, base64: string): string {
  const dir = path.join(context.globalStorageUri.fsPath, 'drops');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
  const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

/** Quote a path for typing into a POSIX shell (no-op when it is already safe). */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'";
}

/** The `starbit.theme` setting, shared by both decks. */
export function readTheme(): 'light' | 'dark' {
  return vscode.workspace.getConfiguration('starbit').get<string>('theme', 'light') === 'dark' ? 'dark' : 'light';
}
