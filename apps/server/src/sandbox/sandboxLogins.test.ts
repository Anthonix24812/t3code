import { describe, expect, it } from "@effect/vitest";

import { VM_CODEX_AUTH_PATH, readHostLogins, type HostLoginSources } from "./sandboxLogins.ts";

/** Fake keychain and files; no real login is read. */
function sources(overrides: Partial<HostLoginSources> & { files?: Record<string, string> }) {
  const runs: Array<ReadonlyArray<string>> = [];
  const files = overrides.files ?? {};
  const value: HostLoginSources = {
    platform: "linux",
    env: {},
    home: "/home/me",
    now: () => 1_000,
    readFile: async (path) => files[path] ?? null,
    run: async (command, args) => {
      runs.push([command, ...args]);
      return null;
    },
    ...overrides,
  };
  return { value, runs };
}

const claudeFile = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });

describe("readHostLogins", () => {
  it("copies only Claude's access token, never its refresh token", async () => {
    const { value, runs } = sources({
      files: {
        "/home/me/.claude/.credentials.json": claudeFile({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: 5_000,
        }),
      },
    });
    const logins = await readHostLogins("claude", value);
    expect(logins).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: "access-1" }, files: [], notes: [] });
    expect(JSON.stringify(logins)).not.toContain("refresh-1");
    expect(runs).toEqual([]);
  });

  it("reads Claude's login from the macOS keychain", async () => {
    const { value, runs } = sources({
      platform: "darwin",
      run: async (command, args) => {
        runs.push([command, ...args]);
        return command === "security" ? claudeFile({ accessToken: "keychain-token" }) : null;
      },
    });
    expect((await readHostLogins("claude", value)).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "keychain-token",
    });
    expect(runs).toEqual([
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ]);
  });

  it("does not copy an expired Claude login and says why", async () => {
    const { value } = sources({
      files: {
        "/home/me/.claude/.credentials.json": claudeFile({ accessToken: "old", expiresAt: 999 }),
      },
    });
    const logins = await readHostLogins("claude", value);
    expect(logins.env).toEqual({});
    expect(logins.notes[0]).toContain("expired");
  });

  it("copies the ChatGPT login for Codex without API keys or the refresh token", async () => {
    const { value } = sources({
      env: { CODEX_HOME: "/codex", OPENAI_API_KEY: "sk-host" },
      files: {
        "/codex/auth.json": JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: "sk-stored",
          tokens: {
            id_token: "id",
            access_token: "access",
            refresh_token: "refresh",
            account_id: "a",
          },
        }),
      },
    });
    const logins = await readHostLogins("codex", value);
    expect(logins.env).toEqual({});
    expect(logins.files.map((file) => file.path)).toEqual([VM_CODEX_AUTH_PATH]);
    const copied = JSON.parse(logins.files[0]!.content);
    expect(copied).toMatchObject({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "access", refresh_token: "" },
    });
    expect(JSON.stringify(logins)).not.toMatch(/sk-host|sk-stored|"refresh"/);
  });

  it("does not turn an API-key login into a copy", async () => {
    const { value } = sources({
      files: { "/home/me/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-only" }) },
    });
    const logins = await readHostLogins("codex", value);
    expect(logins.files).toEqual([]);
    expect(JSON.stringify(logins)).not.toContain("sk-only");
  });
});
