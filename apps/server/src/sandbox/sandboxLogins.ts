// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads CLI logins with plain Node APIs before each relay session.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { SandboxAgent } from "@t3tools/contracts";

/**
 * This machine's subscription logins, copied to a VM for one relay session. They travel only in
 * the relay hello over TLS: env stays in the agent's memory, and files land 0600 in the VM home.
 * No API key is read or sent, and no refresh token leaves this machine, because a VM refreshing a
 * rotating token would sign this machine out.
 */
export interface HostLogins {
  readonly env: Record<string, string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /** Non-secret notes for the thread, such as a login that is missing or expired. */
  readonly notes: ReadonlyArray<string>;
}

export interface HostLoginSources {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly now: () => number;
  readonly readFile: (path: string) => Promise<string | null>;
  /** Runs a command and returns its stdout, or null when it fails. */
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<string | null>;
}

export const VM_CODEX_AUTH_PATH = "/home/user/.codex/auth.json";

interface ClaudeCredentials {
  readonly claudeAiOauth?: { readonly accessToken?: string; readonly expiresAt?: number };
}

interface CodexAuth {
  readonly auth_mode?: string;
  readonly OPENAI_API_KEY?: string | null;
  readonly tokens?: {
    readonly id_token?: string;
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly account_id?: string;
  } | null;
  readonly last_refresh?: string;
}

const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

async function readClaudeLogin(sources: HostLoginSources) {
  // macOS keeps Claude Code's login in the keychain; elsewhere it is a file in the config dir.
  const raw =
    sources.platform === "darwin"
      ? await sources.run("security", [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ])
      : await sources.readFile(
          NodePath.join(
            sources.env.CLAUDE_CONFIG_DIR || NodePath.join(sources.home, ".claude"),
            ".credentials.json",
          ),
        );
  const oauth = parse<ClaudeCredentials>(raw)?.claudeAiOauth;
  const token = oauth?.accessToken?.trim();
  if (!token) return { note: "No Claude login on this machine. Run `claude` and sign in." };
  if (oauth?.expiresAt !== undefined && oauth.expiresAt <= sources.now()) {
    return {
      note: "This machine's Claude login has expired. Use Claude here once to refresh it, then send again.",
    };
  }
  return { token };
}

async function readCodexLogin(sources: HostLoginSources) {
  const home = sources.env.CODEX_HOME || NodePath.join(sources.home, ".codex");
  const auth = parse<CodexAuth>(await sources.readFile(NodePath.join(home, "auth.json")));
  if (!auth?.tokens?.access_token) {
    return { note: "No ChatGPT login for Codex on this machine. Run `codex login` here." };
  }
  // An API-key login and any key stored next to the tokens stay here.
  const copy: CodexAuth = {
    ...auth,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { ...auth.tokens, refresh_token: "" },
  };
  return { content: `${JSON.stringify(copy, null, 2)}\n` };
}

export async function readHostLogins(
  agent: SandboxAgent,
  sources: HostLoginSources,
): Promise<HostLogins> {
  const env: Record<string, string> = {};
  const files: Array<{ path: string; content: string }> = [];
  const notes: string[] = [];
  if (agent === "claude") {
    const claude = await readClaudeLogin(sources);
    if (claude.token) env.CLAUDE_CODE_OAUTH_TOKEN = claude.token;
    if (claude.note) notes.push(claude.note);
  } else if (agent === "codex") {
    const codex = await readCodexLogin(sources);
    if (codex.content) files.push({ path: VM_CODEX_AUTH_PATH, content: codex.content });
    if (codex.note) notes.push(codex.note);
  }
  return { env, files, notes };
}

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

export const nodeHostLoginSources = (platform: NodeJS.Platform): HostLoginSources => ({
  platform,
  env: process.env,
  home: NodeOS.homedir(),
  now: Date.now,
  readFile: (path) => NodeFSP.readFile(path, "utf8").catch(() => null),
  run: (command, args) =>
    execFileAsync(command, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }).then(
      (result) => result.stdout,
      () => null,
    ),
});
