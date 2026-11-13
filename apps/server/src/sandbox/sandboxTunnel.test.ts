import { describe, expect, it } from "@effect/vitest";

import { forwardToT3Mcp, handleSandboxMcp, parseMcpHttpBody } from "./sandboxTunnel.ts";

const frame = (message: Record<string, unknown>, sessionId: string | null = null) => ({
  id: "f1",
  target: "t3",
  sessionId,
  protocolVersion: sessionId ? "2025-06-18" : null,
  message,
});

describe("sandbox tunnel", () => {
  it("reads JSON and SSE MCP answers", () => {
    expect(parseMcpHttpBody("application/json", '{"id":1,"result":{}}')).toEqual([
      { id: 1, result: {} },
    ]);
    expect(
      parseMcpHttpBody(
        "text/event-stream",
        'event: message\ndata: {"method":"notifications/progress"}\n\ndata: {"id":2,"result":{"ok":true}}\n\n',
      ),
    ).toEqual([{ method: "notifications/progress" }, { id: 2, result: { ok: true } }]);
    expect(parseMcpHttpBody("application/json", "")).toEqual([]);
  });

  it("adds this thread's credential on the host and keeps the session id", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
        headers: { "content-type": "application/json", "mcp-session-id": "s-9" },
      });
    }) as typeof fetch;
    const reply = await forwardToT3Mcp(
      { endpoint: "http://127.0.0.1:1/mcp", authorization: "Bearer host-only" },
      frame({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "s-1"),
      fetchImpl,
    );
    expect(seen[0]).toMatchObject({
      authorization: "Bearer host-only",
      "mcp-session-id": "s-1",
      "mcp-protocol-version": "2025-06-18",
    });
    expect(reply).toEqual({
      sessionId: "s-9",
      messages: [{ jsonrpc: "2.0", id: 1, result: { tools: [] } }],
    });
    expect(JSON.stringify(reply)).not.toContain("host-only");
  });

  it("files GitHub issues and reports VM capacity from the host", async () => {
    const issues: unknown[] = [];
    const context = {
      createIssue: async (input: unknown) => {
        issues.push(input);
        return "https://github.com/me/app/issues/7";
      },
      capacity: async () => ({ running: 1, limit: 4 }),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      handleSandboxMcp(
        frame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
        context,
      );

    const listed = await handleSandboxMcp(
      frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      context,
    );
    expect(JSON.stringify(listed)).toContain("github_issue_create");
    expect(
      JSON.stringify(
        await call("github_issue_create", { title: " Split auth ", labels: ["task", 3] }),
      ),
    ).toContain("issues/7");
    expect(issues).toEqual([{ title: "Split auth", body: "", labels: ["task"] }]);
    expect(JSON.stringify(await call("github_issue_create", { title: "" }))).toContain(
      '"isError":true',
    );
    expect(JSON.stringify(await call("sandbox_capacity", {}))).toContain("1 of 4 Boat VMs");
    expect(
      await handleSandboxMcp(
        frame({ jsonrpc: "2.0", method: "notifications/initialized" }),
        context,
      ),
    ).toEqual({ messages: [] });
  });
});
