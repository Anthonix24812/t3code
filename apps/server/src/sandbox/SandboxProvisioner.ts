// @effect-diagnostics nodeBuiltinImport:off globalDate:off - git, the bridge socket and the relay WebSocket run outside Effect's platform layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  SANDBOX_AGENTS,
  SANDBOX_AGENT_LABELS,
  SandboxAgent,
  SandboxError,
  isSandboxProviderInstanceId,
  type ProviderInstanceConfig,
  type SandboxRecord,
  type SandboxSettings,
  type ThreadId,
  sandboxProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import { AcpBridgeSession, startBridgeSocketServer, type BridgeHello } from "./SandboxAcpBridge.ts";
import { createBoatClient } from "./providers/boatApi.ts";
import { createBoatDriver } from "./providers/boat.ts";
import { makeSandboxRecords, toSandboxRecord, type SandboxRow } from "./SandboxRecords.ts";
import type { SandboxDriver } from "./SandboxProvider.ts";
import {
  SANDBOX_RELAY_PORT,
  bootstrapSandbox,
  remoteProjectPath,
  startSandboxSession,
  type SandboxProjectSource,
} from "./sandboxSetup.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeSandboxAgent = Schema.decodeUnknownOption(SandboxAgent);
const SWEEP_INTERVAL = "1 minute";
/** Boat's own auto-stop when idle stop is off; T3 keeps extending it while the host runs. */
const NEVER_IDLE_TTL_SECONDS = 24 * 60 * 60;

/** Tests swap in a fake driver; production builds the Boat driver from the configured key. */
export class SandboxDriverFactory extends Context.Reference<(apiKey: string) => SandboxDriver>(
  "t3/sandbox/SandboxDriverFactory",
  { defaultValue: () => (apiKey) => createBoatDriver({ client: createBoatClient({ apiKey }) }) },
) {}

/** Reads the git state a VM checkout is cloned from. Tests replace it. */
export class SandboxProjectReader extends Context.Reference<
  (hostCwd: string) => Promise<SandboxProjectSource>
>("t3/sandbox/SandboxProjectReader", { defaultValue: () => readProjectSource }) {}

export interface SandboxEndpoint {
  readonly url: string;
  readonly token: string;
  readonly remoteCwd: string;
}

export class SandboxProvisioner extends Context.Service<
  SandboxProvisioner,
  {
    readonly list: Effect.Effect<
      { readonly configured: boolean; readonly sandboxes: ReadonlyArray<SandboxRecord> },
      SandboxError
    >;
    readonly ensureSession: (input: {
      readonly threadId: ThreadId;
      readonly agent: SandboxAgent;
      readonly hostCwd: string;
    }) => Effect.Effect<SandboxEndpoint, SandboxError>;
    /** Only a live thread whose provider is a Boat instance may start a VM. */
    readonly isSandboxThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly setBusy: (threadId: ThreadId, busy: boolean) => Effect.Effect<void>;
    /** A stop or destroy ends the registered bridges' relay connections; returns the unregister. */
    readonly registerBridge: (threadId: ThreadId, bridge: AcpBridgeSession) => () => void;
    readonly stop: (threadId: ThreadId) => Effect.Effect<void, SandboxError>;
    readonly destroy: (threadId: ThreadId) => Effect.Effect<void, SandboxError>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const resolveBoatApiKey = (settings: SandboxSettings) => {
  const key = typeof settings.boatApiKey === "string" ? settings.boatApiKey.trim() : "";
  return key || process.env.BOAT_API_KEY?.trim() || "";
};

const sandboxTtlSeconds = (settings: SandboxSettings) =>
  settings.idleMinutes > 0 ? (settings.idleMinutes + 10) * 60 : NEVER_IDLE_TTL_SECONDS;

const sandboxName = (threadId: ThreadId) =>
  `t3-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16)}`;

const toSandboxError = (message: string) => (cause: unknown) =>
  new SandboxError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
    cause,
  });

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const records = yield* makeSandboxRecords.pipe(
    Effect.mapError(toSandboxError("Could not open the sandbox table")),
  );
  const driverFactory = yield* SandboxDriverFactory;
  const readProject = yield* SandboxProjectReader;

  const live = new Map<ThreadId, SandboxEndpoint>();
  const busy = new Map<ThreadId, number>();
  const bridges = new Map<ThreadId, Set<AcpBridgeSession>>();
  const locks = new Map<ThreadId, Semaphore.Semaphore>();

  const lockFor = Effect.fnUntraced(function* (threadId: ThreadId) {
    const existing = locks.get(threadId);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    locks.set(threadId, created);
    return created;
  });
  const withThreadLock =
    (threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lockFor(threadId).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
  const sandboxSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.sandbox),
    Effect.mapError(toSandboxError("Could not read sandbox settings")),
  );
  const driverFor = Effect.fn("SandboxProvisioner.driver")(function* (settings: SandboxSettings) {
    const apiKey = resolveBoatApiKey(settings);
    if (!apiKey) {
      return yield* new SandboxError({
        message: "Add a boat.dev API key in Settings → Sandbox to run threads on Boat.",
      });
    }
    return driverFactory(apiKey);
  });
  const call = <A>(label: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: toSandboxError(label) });
  const save = (row: SandboxRow) =>
    records.upsert(row).pipe(Effect.mapError(toSandboxError("Could not save the sandbox record")));

  const disconnectBridges = (threadId: ThreadId) =>
    Effect.sync(() => {
      live.delete(threadId);
      for (const bridge of bridges.get(threadId) ?? []) bridge.dispose();
    });

  const provision = Effect.fn("SandboxProvisioner.provision")(function* (input: {
    readonly threadId: ThreadId;
    readonly agent: SandboxAgent;
    readonly hostCwd: string;
  }) {
    const known = live.get(input.threadId);
    if (known) return known;
    const settings = yield* sandboxSettings;
    const driver = yield* driverFor(settings);
    const ttlSeconds = sandboxTtlSeconds(settings);
    const now = yield* nowIso;
    let row = (yield* records
      .get(input.threadId)
      .pipe(Effect.mapError(toSandboxError("Could not read the sandbox record")))) ?? {
      threadId: input.threadId,
      name: sandboxName(input.threadId),
      boatSandboxId: null,
      // Saved before the create request, so a retry after a lost response adopts the same VM.
      idempotencyKey: NodeCrypto.randomUUID(),
      state: "provisioning" as const,
      size: settings.size,
      agent: input.agent,
      remoteCwd: null,
      lastActiveAt: now,
      createdAt: now,
      error: null,
    };

    const run = Effect.gen(function* () {
      if (row.boatSandboxId !== null) {
        const status = yield* call("Could not read the VM", () =>
          driver.status(row.boatSandboxId!),
        );
        if (status === "deleted") {
          row = {
            ...row,
            boatSandboxId: null,
            remoteCwd: null,
            idempotencyKey: NodeCrypto.randomUUID(),
          };
        } else if (status === "stopped" || status === "stopping" || status === "failed") {
          row = { ...row, state: "provisioning", error: null };
          yield* save(row);
          yield* call("Could not resume the VM", () =>
            driver.resume(row.boatSandboxId!, { size: row.size, ttlSeconds }),
          );
        } else {
          yield* call("The VM did not become ready", () => driver.waitReady(row.boatSandboxId!));
        }
      }
      if (row.boatSandboxId === null) {
        yield* save(row);
        const limits = yield* call("Could not read boat.dev limits", () => driver.limits());
        if (limits?.canStart === false) {
          return yield* new SandboxError({
            message: "boat.dev refuses new sandboxes right now (plan start or concurrency limit).",
          });
        }
        const created = yield* call("Could not create the VM", () =>
          driver.create({
            name: row.name,
            size: row.size,
            idempotencyKey: row.idempotencyKey,
            ttlSeconds,
          }),
        );
        row = { ...row, boatSandboxId: created.id };
        yield* save(row);
        yield* call("The VM did not become ready", () => driver.waitReady(created.id));
      }
      const id = row.boatSandboxId!;
      if (row.remoteCwd === null) {
        const source = yield* call("Could not read the project's git state", () =>
          readProject(input.hostCwd),
        );
        yield* call("Could not set up the VM", () => bootstrapSandbox(driver, id, source));
        row = { ...row, remoteCwd: remoteProjectPath(source.directoryName) };
        yield* save(row);
      }
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      yield* call("Could not start the agent relay", () => startSandboxSession(driver, id, token));
      const url = yield* call("Could not expose the agent relay", () =>
        driver.exposePort(id, SANDBOX_RELAY_PORT),
      );
      row = { ...row, state: "running", error: null, lastActiveAt: yield* nowIso };
      yield* save(row);
      const endpoint = { url, token, remoteCwd: row.remoteCwd! };
      live.set(input.threadId, endpoint);
      return endpoint;
    });

    return yield* run.pipe(
      Effect.tapError((error) =>
        save({ ...row, state: "failed", error: error.message.slice(0, 1_000) }).pipe(Effect.ignore),
      ),
    );
  });

  const ensureSession = (input: {
    readonly threadId: ThreadId;
    readonly agent: SandboxAgent;
    readonly hostCwd: string;
  }) => provision(input).pipe(withThreadLock(input.threadId));

  const stop = Effect.fn("SandboxProvisioner.stop")(function* (threadId: ThreadId) {
    yield* Effect.gen(function* () {
      const row = yield* records
        .get(threadId)
        .pipe(Effect.mapError(toSandboxError("Could not read the sandbox record")));
      if (!row?.boatSandboxId || row.state === "stopped") return;
      yield* disconnectBridges(threadId);
      const driver = yield* driverFor(yield* sandboxSettings);
      yield* save({ ...row, state: "stopping" });
      yield* call("Could not stop the VM", () => driver.stop(row.boatSandboxId!)).pipe(
        Effect.tapError((error) => save({ ...row, state: "failed", error: error.message })),
      );
      yield* save({ ...row, state: "stopped", error: null });
    }).pipe(withThreadLock(threadId));
  });

  const destroy = Effect.fn("SandboxProvisioner.destroy")(function* (threadId: ThreadId) {
    yield* Effect.gen(function* () {
      const row = yield* records
        .get(threadId)
        .pipe(Effect.mapError(toSandboxError("Could not read the sandbox record")));
      if (!row) return;
      yield* disconnectBridges(threadId);
      if (row.boatSandboxId) {
        const driver = yield* driverFor(yield* sandboxSettings);
        yield* save({ ...row, state: "destroying" });
        yield* call("Could not delete the VM", () => driver.destroy(row.boatSandboxId!));
      }
      yield* records
        .remove(threadId)
        .pipe(Effect.mapError(toSandboxError("Could not remove the sandbox record")));
      busy.delete(threadId);
    }).pipe(withThreadLock(threadId));
    locks.delete(threadId);
  });

  const setBusy = Effect.fn("SandboxProvisioner.setBusy")(function* (
    threadId: ThreadId,
    isBusy: boolean,
  ) {
    yield* Effect.gen(function* () {
      const count = Math.max(0, (busy.get(threadId) ?? 0) + (isBusy ? 1 : -1));
      if (count === 0) busy.delete(threadId);
      else busy.set(threadId, count);
      const row = yield* records.get(threadId);
      if (row) yield* records.upsert({ ...row, lastActiveAt: yield* nowIso });
    }).pipe(Effect.ignore);
  });

  const threadIsGone = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map(
        (shell) => shell === null || shell.archivedAt !== null || shell.deletedAt !== null,
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Stops VMs idle past the configured window, keeps Boat's auto-stop ahead of busy ones, and
   * removes VMs whose thread was archived or deleted while this server was down.
   */
  const sweep = Effect.gen(function* () {
    const settings = yield* sandboxSettings;
    const rows = yield* records.list.pipe(
      Effect.mapError(toSandboxError("Could not list sandboxes")),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    for (const row of rows) {
      if (yield* threadIsGone(row.threadId)) {
        yield* destroy(row.threadId).pipe(Effect.ignore);
        continue;
      }
      if (row.state !== "running" || !row.boatSandboxId) continue;
      const isBusy = (busy.get(row.threadId) ?? 0) > 0;
      const idleMs = nowMs - Date.parse(row.lastActiveAt);
      if (isBusy || settings.idleMinutes === 0) {
        const driver = yield* driverFor(settings);
        yield* call("Could not extend the VM lifetime", () =>
          driver.extendTtl(row.boatSandboxId!, sandboxTtlSeconds(settings)),
        ).pipe(Effect.ignore);
      } else if (idleMs >= settings.idleMinutes * 60_000) {
        yield* stop(row.threadId).pipe(Effect.ignore);
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("sandbox sweep failed", { cause })));

  const list = Effect.gen(function* () {
    const settings = yield* sandboxSettings;
    const rows = yield* records.list.pipe(
      Effect.mapError(toSandboxError("Could not list sandboxes")),
    );
    return { configured: resolveBoatApiKey(settings) !== "", sandboxes: rows.map(toSandboxRecord) };
  });

  const isSandboxThread = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== null &&
          shell.archivedAt === null &&
          shell.deletedAt === null &&
          isSandboxProviderInstanceId(shell.modelSelection.instanceId),
      ),
      Effect.orElseSucceed(() => false),
    );

  return SandboxProvisioner.of({
    list,
    isSandboxThread,
    ensureSession,
    setBusy,
    stop,
    destroy,
    sweep,
    registerBridge: (threadId, bridge) => {
      const set = bridges.get(threadId) ?? new Set();
      set.add(bridge);
      bridges.set(threadId, set);
      return () => set.delete(bridge);
    },
  });
});

const BRIDGE_INSTANCE_ENV = ["T3_SANDBOX_ACP_SOCKET", "T3_SANDBOX_ACP_TOKEN_FILE"];

/** Desired provider instance for one agent, keeping env the user added (such as API keys). */
function sandboxProviderInstance(input: {
  readonly agent: SandboxAgent;
  readonly existing: ProviderInstanceConfig | undefined;
  readonly enabled: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly tokenFile: string;
}): ProviderInstanceConfig {
  const existingConfig = (input.existing?.config ?? {}) as Record<string, unknown>;
  return {
    displayName: `${SANDBOX_AGENT_LABELS[input.agent]} · Boat sandbox`,
    ...input.existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    enabled: input.enabled,
    environment: [
      ...(input.existing?.environment ?? []).filter(
        (entry) => !BRIDGE_INSTANCE_ENV.includes(entry.name),
      ),
      { name: "T3_SANDBOX_ACP_SOCKET", value: input.socketPath, sensitive: false },
      { name: "T3_SANDBOX_ACP_TOKEN_FILE", value: input.tokenFile, sensitive: false },
    ],
    config: {
      ...existingConfig,
      source: "local",
      commandPath: input.command,
      commandArgs: [...input.args],
    },
  };
}

const sameInstance = (left: ProviderInstanceConfig | undefined, right: ProviderInstanceConfig) =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right);

const sandboxSocketPath = (stateDir: string, platform: NodeJS.Platform) => {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  // Unix socket paths are capped near 104 bytes, which a worktree's state dir can exceed.
  return platform === "win32"
    ? `\\\\.\\pipe\\t3-sandbox-${hash}`
    : NodePath.join(NodeOS.tmpdir(), `t3-sandbox-${hash}.sock`);
};

/** Starts the bridge socket, keeps the Boat provider instances in step with settings, and sweeps. */
const start = Effect.gen(function* () {
  const provisioner = yield* SandboxProvisioner;
  const settingsService = yield* Settings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const self = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const socketPath = sandboxSocketPath(stateDir, platform);
  const tokenFile = NodePath.join(stateDir, "sandbox-acp.token");
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(stateDir, { recursive: true });
    await NodeFSP.writeFile(tokenFile, token, { mode: 0o600 });
    if (platform !== "win32") await NodeFSP.rm(socketPath, { force: true });
  });
  const tokenBytes = Buffer.from(token);
  const server = yield* Effect.promise(() =>
    startBridgeSocketServer({
      socketPath,
      verifyToken: (candidate) => {
        const bytes = Buffer.from(candidate);
        return bytes.length === tokenBytes.length && NodeCrypto.timingSafeEqual(bytes, tokenBytes);
      },
      onConnection: (hello, io) => openBridge(hello, io),
    }),
  );
  if (platform !== "win32") yield* Effect.promise(() => NodeFSP.chmod(socketPath, 0o600));
  yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));

  function openBridge(
    hello: BridgeHello,
    io: { readonly write: (line: string) => void; readonly end: () => void },
  ) {
    const agent = decodeSandboxAgent(hello.agent);
    if (agent._tag === "None") return null;
    const threadId = hello.threadId as ThreadId | null;
    let hostCwd = "";
    const session: AcpBridgeSession = new AcpBridgeSession(
      {
        writeHost: io.write,
        onBusyChange: (isBusy) => {
          if (threadId) void runPromise(provisioner.setBusy(threadId, isBusy));
        },
        connect: async (handlers) => {
          const endpoint = await runPromise(
            provisioner.ensureSession({ threadId: threadId!, agent: agent.value, hostCwd }),
          );
          const channel = await connectRelayWebSocket({
            url: endpoint.url,
            hello: {
              token: endpoint.token,
              agent: agent.value,
              env: hello.env,
              cwd: endpoint.remoteCwd,
            },
            onMessage: handlers.onMessage,
            onClose: handlers.onClose,
          });
          return { channel, remoteCwd: endpoint.remoteCwd };
        },
      },
      threadId === null
        ? Promise.resolve(true)
        : runPromise(provisioner.isSandboxThread(threadId)).then((isSandbox) => !isSandbox),
    );
    const unregister = threadId ? provisioner.registerBridge(threadId, session) : () => undefined;
    return {
      onLine: (line: string) => {
        // The first session request carries the host checkout the VM clones.
        if (!hostCwd) {
          try {
            const cwd = (JSON.parse(line) as { params?: { cwd?: unknown } }).params?.cwd;
            if (typeof cwd === "string") hostCwd = cwd;
          } catch {
            // Malformed lines are dropped by the session.
          }
        }
        session.handleHostLine(line);
      },
      onClose: () => {
        session.dispose();
        unregister();
      },
    };
  }

  const syncInstances = Effect.fn("SandboxProvisioner.syncInstances")(function* () {
    const settings = yield* settingsService.getSettings;
    const enabled = resolveBoatApiKey(settings.sandbox) !== "";
    for (const agent of SANDBOX_AGENTS) {
      const instanceId = ProviderInstanceId.make(sandboxProviderInstanceId(agent));
      const existing = settings.providerInstances[instanceId];
      if (!existing && !enabled) continue;
      const instance = sandboxProviderInstance({
        agent,
        existing,
        enabled,
        command: self.command,
        args: selfInvocationArgs(self, ["__sandbox-acp", agent]),
        socketPath,
        tokenFile,
      });
      if (sameInstance(existing, instance)) continue;
      yield* settingsService.updateProviderInstance({ operation: "upsert", instanceId, instance });
    }
  });

  yield* syncInstances().pipe(Effect.ignore);
  yield* forkParked(
    settingsService.streamChanges.pipe(
      Stream.map((settings) => resolveBoatApiKey(settings.sandbox) !== ""),
      Stream.changes,
      Stream.runForEach(() => syncInstances().pipe(Effect.ignore)),
    ),
  );
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "thread.archived" || event.type === "thread.deleted"
        ? provisioner.destroy(event.threadId).pipe(Effect.ignore)
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("sandbox event stream failed", { cause })),
    ),
  );
  yield* forkParked(
    provisioner.sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
  );
});

export const layerService = Layer.effect(SandboxProvisioner, make);

export const layer = Layer.effectDiscard(start).pipe(Layer.provideMerge(layerService));

async function connectRelayWebSocket(input: {
  readonly url: string;
  readonly hello: Record<string, unknown>;
  readonly onMessage: (line: string) => void;
  readonly onClose: () => void;
}) {
  const socket = new WebSocket(input.url.replace(/^http/, "ws"));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not reach the sandbox relay.")),
      {
        once: true,
      },
    );
  });
  socket.send(JSON.stringify(input.hello));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        const ready = String(event.data).includes('"t3SandboxRelay":"ready"');
        if (ready) resolve();
        else reject(new Error("The sandbox relay refused the connection."));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => reject(new Error(`The sandbox relay closed the connection (${event.code}).`)),
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => input.onMessage(String(event.data)));
  socket.addEventListener("close", () => input.onClose());
  return { send: (line: string) => socket.send(line), close: () => socket.close() };
}

const git = async (cwd: string, args: ReadonlyArray<string>) =>
  (await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();
const gitOrNull = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).then(
    (value) => value || null,
    () => null,
  );

/** Committed history of the current branch; uncommitted changes stay on this machine. */
async function readProjectSource(hostCwd: string): Promise<SandboxProjectSource> {
  const root = await git(hostCwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("Boat sandboxes need a project that is a git repository with a commit.");
  });
  const branch = await gitOrNull(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-bundle-"));
  try {
    const bundlePath = NodePath.join(directory, "project.bundle");
    await git(root, ["bundle", "create", bundlePath, "HEAD", ...(branch ? [branch] : [])]);
    return {
      bundle: await NodeFSP.readFile(bundlePath),
      branch,
      originUrl: await gitOrNull(root, ["remote", "get-url", "origin"]),
      directoryName: NodePath.basename(root).replace(/[^A-Za-z0-9._-]/g, "-") || "project",
      gitUserName: await gitOrNull(root, ["config", "user.name"]),
      gitUserEmail: await gitOrNull(root, ["config", "user.email"]),
    };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
