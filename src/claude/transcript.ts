/* Read a persisted Claude Code session transcript so a resumed chat can show
   its history. The SDK resumes the model's context but does not replay the
   old messages to the consumer; the CLI's JSONL under
   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl has them. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_ENTRIES = 400;

export interface HistoryEntry {
  type: 'user' | 'assistant';
  message: { role: 'user' | 'assistant'; content: unknown };
  parent_tool_use_id: null;
  isReplay: true;
  /** The CLI's post-compaction summary ("This session is being continued…"). */
  isCompactSummary?: true;
  uuid?: string;
  timestamp?: string;
  session_id: string;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Find `<sessionId>.jsonl` under any project directory. */
export function findTranscript(sessionId: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const root = path.join(configDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Parse the transcript into user/assistant entries in order (main thread only). */
export function readHistory(sessionId: string): HistoryEntry[] {
  const file = findTranscript(sessionId);
  if (!file) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain || e.isMeta) continue;
    const message = e.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.content === undefined) continue;
    // skip the CLI's synthetic user entries (command echoes, system notes)
    if (
      e.type === 'user' &&
      typeof message.content === 'string' &&
      /^<(command-name|local-command|system-reminder)/.test(message.content.trimStart())
    ) {
      continue;
    }
    out.push({
      type: e.type,
      message: { role: e.type, content: message.content },
      parent_tool_use_id: null,
      isReplay: true,
      isCompactSummary: e.isCompactSummary === true ? true : undefined,
      uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
      session_id: sessionId
    });
  }
  return out.length > MAX_ENTRIES ? out.slice(out.length - MAX_ENTRIES) : out;
}
