// @effect-diagnostics nodeBuiltinImport:off -- A stdio/socket relay; the provisioner owns the Effect side.
import * as NodeNet from "node:net";

// Proxies one host ACP session to an agent on a Boat VM. It answers `initialize` itself so the
// probe never starts a VM, rewrites the host cwd to the VM checkout, drops host-only MCP servers,
// and after an idle stop resumes the VM and reattaches the session from the VM's disk.

type JsonRpcId = string | number;
interface JsonRpcMessage {
  readonly jsonrpc?: "2.0";
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface RemoteChannel {
  send(line: string): void;
  close(): void;
}

export interface RemoteConnection {
  readonly channel: RemoteChannel;
  readonly remoteCwd: string;
}

export interface AcpBridgeDeps {
  /** Provisions or resumes the VM and opens a relay connection whose messages go to `onMessage`. */
  readonly connect: (handlers: {
    readonly onMessage: (line: string) => void;
    readonly onClose: () => void;
  }) => Promise<RemoteConnection>;
  readonly writeHost: (line: string) => void;
  readonly onBusyChange: (busy: boolean) => void;
}

const isResponse = (message: JsonRpcMessage) =>
  message.method === undefined && message.id !== undefined && message.id !== null;
const sessionIdOf = (message: JsonRpcMessage) =>
  typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;

const BRIDGE_AGENT_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, embeddedContext: true },
};
export const PROBE_SESSION_ID = "t3-sandbox-probe";

interface ActiveRemote extends RemoteConnection {
  readonly loadSession: boolean;
  /** Remote session ids this agent process knows; a new VM session starts empty. */
  readonly sessions: Set<string>;
}

export class AcpBridgeSession {
  private initializeParams: Record<string, unknown> = {};
  private remote: ActiveRemote | null = null;
  private connecting: Promise<ActiveRemote> | null = null;
  private readonly hostToRemote = new Map<string, string>();
  private readonly remoteToHost = new Map<string, string>();
  private readonly hostCwd = new Map<string, unknown>();
  /** Host requests sent to the remote and still unanswered, by id; prompts count as busy. */
  private readonly pending = new Map<JsonRpcId, { method: string }>();
  private readonly internal = new Map<
    JsonRpcId,
    { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  /** Remote sessions being reattached: their history replay must not reach the host again. */
  private readonly replaying = new Set<string>();
  private nextInternalId = 0;
  private queue: Promise<void> = Promise.resolve();
  private busy = false;

  private readonly deps: AcpBridgeDeps;
  /** The provider probe has no thread; it must be answered without a VM. */
  private readonly probe: boolean;

  constructor(deps: AcpBridgeDeps, probe: boolean) {
    this.deps = deps;
    this.probe = probe;
  }

  handleHostLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    // Responses to the agent's own requests (permissions) must not wait behind a reconnect.
    if (isResponse(message)) {
      this.remote?.channel.send(line);
      return;
    }
    this.queue = this.queue.then(() =>
      this.handleHostMessage(message).catch((error: unknown) => {
        if (message.id !== undefined && message.id !== null) {
          this.replyError(message.id, error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }

  private async handleHostMessage(message: JsonRpcMessage) {
    const { id, method } = message;
    if (method === "initialize") {
      this.initializeParams = message.params ?? {};
      this.reply(id, {
        protocolVersion: (message.params?.protocolVersion as number | undefined) ?? 1,
        agentCapabilities: BRIDGE_AGENT_CAPABILITIES,
        authMethods: [],
        agentInfo: { name: "t3-boat-sandbox", version: "1" },
      });
      return;
    }
    if (this.probe) {
      if (id !== undefined && id !== null) {
        this.reply(id, method === "session/new" ? { sessionId: PROBE_SESSION_ID } : {});
      }
      return;
    }
    // A cancel or other notification for a VM that is not connected has nothing to act on.
    if ((id === undefined || id === null) && this.remote === null) return;

    const remote = await this.ensureRemote();
    const params: Record<string, unknown> = { ...message.params };
    const hostSessionId = sessionIdOf(message);

    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      if (hostSessionId) this.hostCwd.set(hostSessionId, params.cwd);
      params.cwd = remote.remoteCwd;
      params.mcpServers = [];
      if (method !== "session/new" && hostSessionId) {
        if (!remote.loadSession) {
          await this.attachAsNewSession(remote, hostSessionId);
          this.reply(id, {});
          return;
        }
        remote.sessions.add(this.toRemote(hostSessionId));
        params.sessionId = this.toRemote(hostSessionId);
      }
    } else if (hostSessionId) {
      await this.reattach(remote, hostSessionId);
      params.sessionId = this.toRemote(hostSessionId);
    }

    if (id !== undefined && id !== null) {
      this.pending.set(id, { method: method ?? "" });
      if (method === "session/prompt") this.updateBusy();
    }
    remote.channel.send(JSON.stringify({ ...message, params }));
  }

  private handleRemoteLine(remote: ActiveRemote, line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (isResponse(message)) {
      const id = message.id as JsonRpcId;
      const internal = this.internal.get(id);
      if (internal) {
        this.internal.delete(id);
        internal.resolve(message);
        return;
      }
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (request?.method === "session/new" && message.result) {
        const sessionId = (message.result as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string") remote.sessions.add(sessionId);
      }
      if (request?.method === "session/prompt") this.updateBusy();
      this.deps.writeHost(line);
      return;
    }
    const remoteSessionId = sessionIdOf(message);
    if (remoteSessionId && this.replaying.has(remoteSessionId) && message.id === undefined) return;
    if (remoteSessionId && this.remoteToHost.has(remoteSessionId)) {
      this.deps.writeHost(
        JSON.stringify({
          ...message,
          params: { ...message.params, sessionId: this.remoteToHost.get(remoteSessionId) },
        }),
      );
      return;
    }
    this.deps.writeHost(line);
  }

  private ensureRemote(): Promise<ActiveRemote> {
    if (this.remote) return Promise.resolve(this.remote);
    this.connecting ??= (async () => {
      let active: ActiveRemote | null = null;
      const buffered: string[] = [];
      const connection = await this.deps.connect({
        onMessage: (line) => (active ? this.handleRemoteLine(active, line) : buffered.push(line)),
        onClose: () => this.handleRemoteClose(active),
      });
      const partial: ActiveRemote = { ...connection, loadSession: false, sessions: new Set() };
      active = partial;
      for (const line of buffered.splice(0)) this.handleRemoteLine(partial, line);
      // T3 advertises no client fs or terminal, so the agent uses the VM's own.
      const initialized = await this.request(partial, "initialize", {
        ...this.initializeParams,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const capabilities = (initialized.result as { agentCapabilities?: { loadSession?: boolean } })
        ?.agentCapabilities;
      active = { ...partial, loadSession: capabilities?.loadSession === true };
      this.remote = active;
      return active;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private handleRemoteClose(closed: ActiveRemote | null) {
    if (closed !== null && this.remote !== null && this.remote.channel !== closed.channel) return;
    this.remote = null;
    for (const [id, internal] of this.internal) {
      this.internal.delete(id);
      internal.reject(new Error("The Boat sandbox connection closed."));
    }
    for (const id of this.pending.keys()) {
      this.replyError(id, "The Boat sandbox connection closed.");
    }
    this.pending.clear();
    this.replaying.clear();
    this.updateBusy();
  }

  /** Makes a host session usable on the current agent process after a VM stop or reconnect. */
  private async reattach(remote: ActiveRemote, hostSessionId: string) {
    const remoteSessionId = this.toRemote(hostSessionId);
    if (remote.sessions.has(remoteSessionId)) return;
    if (!remote.loadSession) {
      await this.attachAsNewSession(remote, hostSessionId);
      return;
    }
    this.replaying.add(remoteSessionId);
    try {
      const loaded = await this.request(remote, "session/load", {
        sessionId: remoteSessionId,
        cwd: remote.remoteCwd,
        mcpServers: [],
      });
      if (loaded.error) throw new Error(loaded.error.message);
      remote.sessions.add(remoteSessionId);
    } finally {
      this.replaying.delete(remoteSessionId);
    }
  }

  private async attachAsNewSession(remote: ActiveRemote, hostSessionId: string) {
    const created = await this.request(remote, "session/new", {
      cwd: remote.remoteCwd,
      mcpServers: [],
    });
    const remoteSessionId = (created.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof remoteSessionId !== "string") {
      throw new Error(created.error?.message ?? "The sandbox agent did not start a session.");
    }
    this.hostToRemote.set(hostSessionId, remoteSessionId);
    this.remoteToHost.set(remoteSessionId, hostSessionId);
    remote.sessions.add(remoteSessionId);
  }

  private toRemote(hostSessionId: string) {
    return this.hostToRemote.get(hostSessionId) ?? hostSessionId;
  }

  private request(remote: ActiveRemote, method: string, params: Record<string, unknown>) {
    const id = `t3-sandbox-${this.nextInternalId++}`;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.internal.set(id, { resolve, reject });
      remote.channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private updateBusy() {
    const busy = [...this.pending.values()].some((request) => request.method === "session/prompt");
    if (busy === this.busy) return;
    this.busy = busy;
    this.deps.onBusyChange(busy);
  }

  private reply(id: JsonRpcId | null | undefined, result: unknown) {
    if (id === undefined || id === null) return;
    this.deps.writeHost(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private replyError(id: JsonRpcId, message: string) {
    this.deps.writeHost(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }));
  }

  /** Resolves once every host message received so far has been handled. */
  settled() {
    return this.queue;
  }

  /** Called when the host side goes away: the agent process on the VM ends with it. */
  dispose() {
    this.remote?.channel.close();
    this.remote = null;
  }
}

export interface BridgeHello {
  readonly token: string;
  readonly agent: string;
  readonly threadId: string | null;
  readonly env: Record<string, string>;
}

/** Splits a byte stream into lines without losing a line split across chunks. */
export function lineReader(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

/** The local socket `__sandbox-acp` connects to. The first line authenticates the process. */
export function startBridgeSocketServer(input: {
  readonly socketPath: string;
  readonly verifyToken: (token: string) => boolean;
  readonly onConnection: (
    hello: BridgeHello,
    io: { readonly write: (line: string) => void; readonly end: () => void },
  ) => { readonly onLine: (line: string) => void; readonly onClose: () => void } | null;
}) {
  const server = NodeNet.createServer((socket) => {
    let session: ReturnType<typeof input.onConnection> = null;
    let authenticated = false;
    const io = {
      write: (line: string) => {
        if (!socket.destroyed) socket.write(`${line}\n`);
      },
      end: () => socket.end(),
    };
    socket.on(
      "data",
      lineReader((line) => {
        if (authenticated) {
          session?.onLine(line);
          return;
        }
        authenticated = true;
        let hello: BridgeHello | null = null;
        try {
          hello = JSON.parse(line) as BridgeHello;
        } catch {
          hello = null;
        }
        if (!hello || typeof hello.token !== "string" || !input.verifyToken(hello.token)) {
          socket.destroy();
          return;
        }
        session = input.onConnection(hello, io);
        if (!session) socket.destroy();
      }),
    );
    socket.on("close", () => session?.onClose());
    socket.on("error", () => socket.destroy());
  });
  return new Promise<NodeNet.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => resolve(server));
  });
}
