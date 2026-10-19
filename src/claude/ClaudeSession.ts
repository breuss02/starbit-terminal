/* One Claude session = one query() in streaming-input mode.

   - user turns are pushed into `inbox`, an async queue the SDK consumes
   - every SDKMessage is forwarded to the webview verbatim ('sdk')
   - canUseTool becomes an 'ask' message; the webview answers with 'answer'
   - the abort signal on a pending ask resolves it as a deny so nothing hangs */

import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Sdk } from './SessionManager';
import type { OutboundMsg } from './protocol';

/** Minimal async queue: push() values in, consume with for-await. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.items.push(value);
    }
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) {
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
    };
  }
}

export interface SessionOpts {
  id: string;
  cwd: string;
  exe: string;
  env: NodeJS.ProcessEnv;
  resume?: string;
  permissionMode: PermissionMode;
  model?: string;
  debug: boolean;
  post: (m: OutboundMsg) => void;
  /** Called when the CLI reports its session id (for resume bookkeeping). */
  onInit?: (sessionId: string) => void;
}

export class ClaudeSession {
  readonly id: string;
  sessionId: string | undefined;

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly pending = new Map<string, (r: PermissionResult) => void>();
  private readonly abort = new AbortController();
  private readonly q: Query;
  private closed = false;

  constructor(sdk: Sdk, private readonly opts: SessionOpts) {
    this.id = opts.id;

    const canUseTool: CanUseTool = (tool, input, o) => this.askUser(tool, input, o);

    this.q = sdk.query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        pathToClaudeCodeExecutable: opts.exe || undefined,
        env: opts.env,
        abortController: this.abort,
        includePartialMessages: true,
        // Behave like typing `claude` in the project: same system prompt,
        // CLAUDE.md, settings, hooks, skills, MCP servers.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: opts.permissionMode,
        model: opts.model || undefined,
        persistSession: true,
        canUseTool,
        stderr: opts.debug ? (data) => this.post({ type: 'stderr', id: this.id, data }) : undefined
      }
    });

    void this.pump();
  }

  /* ---- inbound from the webview ------------------------------------ */

  send(text: string): void {
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    });
  }

  answer(toolUseID: string, result: PermissionResult): boolean {
    const resolve = this.pending.get(toolUseID);
    if (!resolve) return false;
    resolve(result);
    return true;
  }

  async interrupt(): Promise<void> {
    try {
      await this.q.interrupt();
    } catch {
      /* no turn running */
    }
  }

  setMode(mode: PermissionMode): Promise<void> {
    return this.q.setPermissionMode(mode);
  }

  setModel(model: string): Promise<void> {
    return this.q.setModel(model || undefined);
  }

  /** Resolves once the process answers control requests — before any turn.
      (The `system/init` message only arrives when the first turn starts.) */
  initInfo() {
    return this.q.initializationResult();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.pending.values()) {
      resolve({ behavior: 'deny', message: 'Session closed' });
    }
    this.pending.clear();
    this.inbox.close();
    this.abort.abort();
    try {
      this.q.close();
    } catch {
      /* already gone */
    }
  }

  /* ---- outbound to the webview ------------------------------------- */

  private post(m: OutboundMsg): void {
    if (!this.closed) this.opts.post(m);
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.opts.onInit?.(msg.session_id);
        }
        this.post({ type: 'sdk', id: this.id, msg });
        if (msg.type === 'result') {
          void this.reportContext();
        }
      }
    } catch (err: unknown) {
      if (!this.closed) {
        this.post({
          type: 'sessionError',
          id: this.id,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      this.post({ type: 'sessionEnded', id: this.id });
    }
  }

  private async reportContext(): Promise<void> {
    try {
      const u = await this.q.getContextUsage();
      this.post({
        type: 'context',
        id: this.id,
        pct: Math.round(u.percentage),
        total: u.totalTokens,
        max: u.maxTokens
      });
    } catch {
      /* session may have ended */
    }
  }

  private askUser(
    tool: string,
    input: Record<string, unknown>,
    o: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const done = (r: PermissionResult) => {
        this.pending.delete(o.toolUseID);
        resolve(r);
      };
      this.pending.set(o.toolUseID, done);

      o.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(o.toolUseID)) return;
          done({ behavior: 'deny', message: 'Cancelled' });
          this.post({ type: 'askCancelled', id: this.id, toolUseID: o.toolUseID });
        },
        { once: true }
      );

      this.post({
        type: 'ask',
        ask: {
          id: this.id,
          toolUseID: o.toolUseID,
          tool,
          input,
          title: o.title,
          displayName: o.displayName,
          description: o.description,
          decisionReason: o.decisionReason,
          suggestions: o.suggestions ?? []
        }
      });
    });
  }
}
