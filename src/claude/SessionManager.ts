/* Lazy SDK loader + registry of live Claude sessions.

   The Agent SDK is ESM-only; this extension is CommonJS. tsconfig uses
   "module": "node16" so the dynamic import() below survives compilation as a
   real import instead of being rewritten to require(). */

import type * as SdkNs from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { ClaudeSession, SessionOpts } from './ClaudeSession';
import { resolveClaude } from './resolveClaude';

export type Sdk = typeof SdkNs;

let sdkPromise: Promise<Sdk> | undefined;

export function loadSdk(): Promise<Sdk> {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch((err: unknown) => {
      sdkPromise = undefined; // allow a retry after e.g. a reinstall
      throw err;
    });
  }
  return sdkPromise;
}

export function sdkVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@anthropic-ai/claude-agent-sdk/package.json').version as string;
  } catch {
    return '?';
  }
}

export class SessionManager {
  private sessions = new Map<string, ClaudeSession>();

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  async create(opts: SessionOpts): Promise<ClaudeSession> {
    const sdk = await loadSdk();
    // after the (slow, first-time) load, so the newest create for an id always wins
    this.kill(opts.id);
    const session = new ClaudeSession(sdk, opts);
    this.sessions.set(opts.id, session);
    return session;
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.dispose();
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }

  /** Spawn the binary, read account info via control requests, and close.
      No model call is made, so this costs nothing. */
  async selfTest(configuredPath: string, cwd: string, clientApp: string): Promise<string> {
    const sdk = await loadSdk();
    const loc = await resolveClaude(configuredPath, true);
    // eslint-disable-next-line require-yield
    async function* never(): AsyncGenerator<SdkNs.SDKUserMessage> {
      await new Promise<void>(() => undefined);
    }
    const q = sdk.query({
      prompt: never(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: loc.exe || undefined,
        env: { ...process.env, PATH: loc.loginPath || process.env.PATH, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp }
      }
    });
    const timer = setTimeout(() => q.close(), 20000);
    try {
      const init = await q.initializationResult();
      const acct = await q.accountInfo();
      const who = acct.subscriptionType || acct.apiKeySource || acct.tokenSource || 'unknown auth';
      return (
        `${who} · ${init.commands.length} commands · ${init.models.length} models · ` +
        `SDK ${sdkVersion()} · ${loc.exe || '(sdk bundled binary)'} [${loc.source}]`
      );
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }
}
