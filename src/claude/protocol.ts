/* Message protocol between the Claude webview and the extension host.
   All transcript state lives in the webview; the extension is a dumb
   Agent SDK broker (mirrors the terminal view, where it is a dumb pty
   broker). */

import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

import type { HistoryEntry } from './transcript';

export type Theme = 'light' | 'dark';

/* ---- webview → extension ------------------------------------------- */

export type InboundMsg =
  | { type: 'ready' }
  | { type: 'create'; id: string; resume?: string }
  | { type: 'send'; id: string; text: string }
  | { type: 'answer'; id: string; toolUseID: string; result: PermissionResult }
  | { type: 'interrupt'; id: string }
  | { type: 'setMode'; id: string; mode: PermissionMode }
  | { type: 'setModel'; id: string; model: string }
  | { type: 'kill'; id: string }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'openFile'; path: string }
  | { type: 'dropFile'; id: string; name: string; data: string }
  | { type: 'rails'; stats: boolean; term: boolean; termPx: number };

/* ---- extension → webview ------------------------------------------- */

export interface AskPayload {
  id: string;
  toolUseID: string;
  tool: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  suggestions: PermissionUpdate[];
}

/** The side rails: which are collapsed to a strip, and the width the terminal was dragged to (0 = default). */
export interface RailsState {
  stats: boolean;
  term: boolean;
  termPx: number;
}

export interface ResumableSession {
  id: string;
  title: string;
  at: number;
}

export type OutboundMsg =
  | {
      type: 'boot';
      theme: Theme;
      cwd: string;
      defaultMode: PermissionMode;
      model: string;
      resumable: ResumableSession[];
      sidePanels: boolean;
      rails: RailsState;
    }
  | { type: 'sdk'; id: string; msg: SDKMessage }
  | {
      /** The process is up and answering control requests (sent before any turn). */
      type: 'sessionInfo';
      id: string;
      mode: PermissionMode;
      commands: { name: string; description: string; argumentHint: string }[];
      models: { value: string; displayName: string; description: string }[];
    }
  | { type: 'ask'; ask: AskPayload }
  | { type: 'askCancelled'; id: string; toolUseID: string }
  | { type: 'resumable'; items: ResumableSession[] }
  | { type: 'dropped'; id: string; path: string }
  | { type: 'history'; id: string; items: HistoryEntry[] }
  | { type: 'context'; id: string; pct: number; total: number; max: number }
  | { type: 'sessionError'; id: string; message: string }
  | { type: 'sessionEnded'; id: string }
  | { type: 'stderr'; id: string; data: string }
  | { type: 'spawnError'; id: string; message: string }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'sidePanels'; on: boolean }
  | { type: 'newSession' }
  | { type: 'stopSession' };
