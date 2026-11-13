import { describe, expect, it } from "@effect/vitest";

import { AcpBridgeSession, PROBE_SESSION_ID, lineReader } from "./SandboxAcpBridge.ts";
import { forwardedSandboxEnv } from "./sandboxAcpPipe.ts";

type Message = Record<string, any>;

/** A scripted remote ACP agent: answers internal and forwarded requests from `respond`. */
function harness(options: { loadSession: boolean; probe?: boolean }) {
  const host: Message[] = [];
  const remoteReceived: Message[] = [];
  const busy: boolean[] = [];
  let connects = 0;
  let remote: { onMessage: (line: string) => void; onClose: () => void } | null = null;
  let nextSession = 0;
  const respond = (message: Message) => {
    const reply = (result: unknown) =>
      remote!.onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: options.loadSession } });
    } else if (message.method === "session/new") {
      reply({ sessionId: `remote-${nextSession++}` });
    } else if (message.method === "session/load") {
      remote!.onMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: message.params.sessionId, update: { replayed: true } },
        }),
      );
      reply(null);
    }
  };
  const session = new AcpBridgeSession(
    {
      writeHost: (line) => host.push(JSON.parse(line)),
      onBusyChange: (value) => busy.push(value),
      connect: async (handlers) => {
        connects += 1;
        remote = handlers;
        return {
          remoteCwd: "/home/user/work/app",
          channel: {
            send: (line) => {
              const message = JSON.parse(line) as Message;
              remoteReceived.push(message);
              respond(message);
            },
            close: () => undefined,
          },
        };
      },
    },
    Promise.resolve(options.probe ?? false),
  );
  const send = async (message: Message) => {
    session.handleHostLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
    await session.settled();
  };
  return {
    host,
    remoteReceived,
    busy,
    send,
    connects: () => connects,
    fromRemote: (message: Message) =>
      remote!.onMessage(JSON.stringify({ jsonrpc: "2.0", ...message })),
    closeRemote: () => remote!.onClose(),
  };
}

describe("AcpBridgeSession", () => {
  it("answers the provider probe without starting a VM", async () => {
    const bridge = harness({ loadSession: true, probe: true });
    await bridge.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await bridge.send({
      id: 2,
      method: "session/new",
      params: { cwd: "/host/app", mcpServers: [] },
    });
    expect(bridge.connects()).toBe(0);
    expect(bridge.host[0]!.result.agentCapabilities.loadSession).toBe(true);
    expect(bridge.host[1]!.result).toEqual({ sessionId: PROBE_SESSION_ID });
  });

  it("connects on the first session, runs the VM checkout, and drops host-only MCP servers", async () => {
    const bridge = harness({ loadSession: true });
    await bridge.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect(bridge.connects()).toBe(0);
    await bridge.send({
      id: 2,
      method: "session/new",
      params: { cwd: "/Users/me/app", mcpServers: [{ name: "t3", command: "t3" }] },
    });
    expect(bridge.connects()).toBe(1);
    const [initialize, created] = bridge.remoteReceived;
    expect(initialize!.params.protocolVersion).toBe(1);
    expect(initialize!.params.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(created!.params).toEqual({ cwd: "/home/user/work/app", mcpServers: [] });
    expect(bridge.host.at(-1)).toMatchObject({ id: 2, result: { sessionId: "remote-0" } });
  });

  it("reports busy for an in-flight prompt and passes permission round trips through", async () => {
    const bridge = harness({ loadSession: true });
    await bridge.send({ id: 1, method: "session/new", params: { cwd: "/h", mcpServers: [] } });
    await bridge.send({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "remote-0", prompt: [] },
    });
    expect(bridge.busy).toEqual([true]);

    bridge.fromRemote({
      id: "perm-1",
      method: "session/request_permission",
      params: { sessionId: "remote-0" },
    });
    expect(bridge.host.at(-1)).toMatchObject({
      id: "perm-1",
      method: "session/request_permission",
    });
    await bridge.send({
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(bridge.remoteReceived.at(-1)).toMatchObject({ id: "perm-1", result: { outcome: {} } });

    bridge.fromRemote({ id: 2, result: { stopReason: "end_turn" } });
    expect(bridge.busy).toEqual([true, false]);
    expect(bridge.host.at(-1)).toMatchObject({ id: 2, result: { stopReason: "end_turn" } });
  });

  it("fails an in-flight prompt when the VM connection drops, then reattaches from disk", async () => {
    const bridge = harness({ loadSession: true });
    await bridge.send({ id: 1, method: "session/new", params: { cwd: "/h", mcpServers: [] } });
    await bridge.send({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "remote-0", prompt: [] },
    });
    bridge.closeRemote();
    expect(bridge.host.at(-1)).toMatchObject({ id: 2, error: { code: -32603 } });
    expect(bridge.busy).toEqual([true, false]);

    const hostBefore = bridge.host.length;
    await bridge.send({
      id: 3,
      method: "session/prompt",
      params: { sessionId: "remote-0", prompt: [] },
    });
    expect(bridge.connects()).toBe(2);
    const methods = bridge.remoteReceived.map((message) => message.method);
    expect(methods.slice(-3)).toEqual(["initialize", "session/load", "session/prompt"]);
    // The history replay from session/load is not shown to the host a second time.
    expect(bridge.host.slice(hostBefore)).toEqual([]);
  });

  it("maps a host session to a new remote session when the agent cannot load sessions", async () => {
    const bridge = harness({ loadSession: false });
    await bridge.send({ id: 1, method: "session/new", params: { cwd: "/h", mcpServers: [] } });
    bridge.closeRemote();
    await bridge.send({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "remote-0", prompt: [] },
    });
    expect(bridge.remoteReceived.at(-1)).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "remote-1" },
    });
    bridge.fromRemote({ method: "session/update", params: { sessionId: "remote-1", update: {} } });
    expect(bridge.host.at(-1)).toMatchObject({ params: { sessionId: "remote-0" } });
  });

  it("does not start a VM for a cancel while disconnected", async () => {
    const bridge = harness({ loadSession: true });
    await bridge.send({ method: "session/cancel", params: { sessionId: "s" } });
    expect(bridge.connects()).toBe(0);
  });
});

describe("bridge plumbing", () => {
  it("splits lines across chunks", () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));
    read('{"a":');
    read('1}\n{"b"');
    read(":2}\n\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("forwards only agent credentials and explicitly prefixed variables", () => {
    expect(
      forwardedSandboxEnv({
        ANTHROPIC_API_KEY: "a",
        HOME: "/Users/me",
        T3_SANDBOX_ENV_GH_TOKEN: "g",
        T3_SANDBOX_ENV_: "ignored",
        OPENAI_API_KEY: "",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "a", GH_TOKEN: "g" });
  });
});
