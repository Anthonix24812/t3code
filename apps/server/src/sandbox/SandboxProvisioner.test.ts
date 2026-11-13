import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { SandboxDriver } from "./SandboxProvider.ts";
import {
  SandboxDriverFactory,
  SandboxProjectReader,
  SandboxProvisioner,
  layerService,
} from "./SandboxProvisioner.ts";

const threadId = ThreadId.make("thread-1");

function fakeDriver(options: { failFirstCreate?: boolean } = {}) {
  const calls: Array<{ readonly name: string; readonly input?: unknown }> = [];
  let status: Awaited<ReturnType<SandboxDriver["status"]>> = "running";
  let creates = 0;
  const driver: SandboxDriver = {
    create: async (input) => {
      calls.push({ name: "create", input });
      creates += 1;
      if (options.failFirstCreate && creates === 1) throw new Error("socket hang up");
      return { id: "bx_1" };
    },
    resume: async (_id, input) => {
      calls.push({ name: "resume", input });
      status = "running";
    },
    waitReady: async () => void calls.push({ name: "waitReady" }),
    stop: async () => {
      calls.push({ name: "stop" });
      status = "stopped";
      return { snapshotId: "snap_1" };
    },
    destroy: async () => void calls.push({ name: "destroy" }),
    status: async () => status,
    exec: async (_id, input) => {
      calls.push({ name: "exec", input: input.script.split("\n")[0] });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    startDetached: async () => void calls.push({ name: "startDetached" }),
    writeFile: async (_id, file) => void calls.push({ name: "writeFile", input: file.path }),
    exposePort: async () => {
      calls.push({ name: "exposePort" });
      return "https://abc-4710.on.boat.dev";
    },
    extendTtl: async (_id, seconds) => void calls.push({ name: "extendTtl", input: seconds }),
    limits: async () => ({ canStart: true }),
  };
  return { driver, calls, names: () => calls.map((call) => call.name) };
}

function provide(
  fake: ReturnType<typeof fakeDriver>,
  shells: Map<ThreadId, unknown>,
  maxConcurrentVms = 4,
) {
  const orchestrator = {
    getThreadShell: (id: ThreadId) => Effect.succeed(shells.has(id) ? shells.get(id) : null),
    streamDomainEvents: Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"];
  return <A, E>(effect: Effect.Effect<A, E, SandboxProvisioner>) =>
    effect.pipe(
      Effect.provide(
        layerService.pipe(
          Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, orchestrator)),
          Layer.provide(
            ServerSettingsService.layerTest({
              sandbox: { boatApiKey: "boat_k", idleMinutes: 15, maxConcurrentVms },
            }),
          ),
          Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
      Effect.provideService(SandboxDriverFactory, () => fake.driver),
      Effect.provideService(SandboxProjectReader, async () => ({
        bundle: new Uint8Array([1, 2, 3]),
        patch: null,
        branch: "main",
        originUrl: "git@github.com:me/app.git",
        directoryName: "app",
        gitUserName: null,
        gitUserEmail: null,
      })),
    );
}

const liveShell = { archivedAt: null, deletedAt: null, lineage: { rootThreadId: threadId } };

describe("SandboxProvisioner", () => {
  it.effect("creates, bootstraps and connects one VM per thread, then reuses it", () => {
    const fake = fakeDriver();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      const endpoint = yield* provisioner.ensureSession({
        threadId,
        agent: "claude",
        hostCwd: "/Users/me/app",
      });
      expect(endpoint.url).toBe("https://abc-4710.on.boat.dev");
      expect(endpoint.remoteCwd).toBe("/home/user/work/app");
      expect(fake.names().filter((name) => name === "create")).toHaveLength(1);
      expect(fake.calls.map((call) => call.input)).toContain(
        "/tmp/t3-sandbox-private/project.bundle",
      );

      const before = fake.calls.length;
      yield* provisioner.ensureSession({ threadId, agent: "claude", hostCwd: "/Users/me/app" });
      expect(fake.calls.length).toBe(before);
      const { sandboxes } = yield* provisioner.list;
      expect(sandboxes).toMatchObject([{ threadId, boatSandboxId: "bx_1", state: "running" }]);
    }).pipe(provide(fake, new Map([[threadId, liveShell]])));
  });

  it.effect(
    "retries a create whose response was lost with the key saved before the request",
    () => {
      const fake = fakeDriver({ failFirstCreate: true });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner;
        const input = { threadId, agent: "codex" as const, hostCwd: "/Users/me/app" };
        const failed = yield* Effect.flip(provisioner.ensureSession(input));
        expect(failed.message).toContain("Could not create the VM");
        expect((yield* provisioner.list).sandboxes).toMatchObject([
          { state: "failed", boatSandboxId: null },
        ]);
        yield* provisioner.ensureSession(input);
        const keys = fake.calls
          .filter((call) => call.name === "create")
          .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
      }).pipe(provide(fake, new Map([[threadId, liveShell]])));
    },
  );

  it.effect("stops an idle VM after the idle window and resumes it on the next session", () => {
    const fake = fakeDriver();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      const input = { threadId, agent: "gemini" as const, hostCwd: "/Users/me/app" };
      yield* provisioner.ensureSession(input);

      yield* TestClock.adjust("14 minutes");
      yield* provisioner.sweep;
      expect(fake.names()).not.toContain("stop");

      yield* TestClock.adjust("2 minutes");
      yield* provisioner.sweep;
      expect(fake.names()).toContain("stop");
      expect((yield* provisioner.list).sandboxes[0]!.state).toBe("stopped");

      const creates = fake.names().filter((name) => name === "create").length;
      yield* provisioner.ensureSession(input);
      expect(fake.names()).toContain("resume");
      expect(fake.names().filter((name) => name === "create")).toHaveLength(creates);
      // A resumed VM keeps its checkout; only the session (relay and port) restarts.
      expect(
        fake.calls.filter((call) => call.input === "/tmp/t3-sandbox-private/project.bundle"),
      ).toHaveLength(1);
    }).pipe(provide(fake, new Map([[threadId, liveShell]])));
  });

  it.effect("extends Boat's auto-stop instead of stopping while a turn runs", () => {
    const fake = fakeDriver();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      yield* provisioner.ensureSession({ threadId, agent: "claude", hostCwd: "/Users/me/app" });
      yield* provisioner.setBusy(threadId, true);
      yield* TestClock.adjust("30 minutes");
      yield* provisioner.sweep;
      expect(fake.names()).not.toContain("stop");
      expect(fake.calls.find((call) => call.name === "extendTtl")?.input).toBe(25 * 60);
    }).pipe(provide(fake, new Map([[threadId, liveShell]])));
  });

  it.effect("lets only a live thread on a Boat instance start a VM", () => {
    const other = ThreadId.make("thread-on-claude");
    const shells = new Map<ThreadId, unknown>([
      [threadId, { ...liveShell, modelSelection: { instanceId: "boatClaude", model: "default" } }],
      [other, { ...liveShell, modelSelection: { instanceId: "claudeAgent", model: "opus" } }],
    ]);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      expect(yield* provisioner.isSandboxThread(threadId)).toBe(true);
      // An inherited T3CODE_THREAD_ID can name a thread that is not on Boat, or none at all.
      expect(yield* provisioner.isSandboxThread(other)).toBe(false);
      expect(yield* provisioner.isSandboxThread(ThreadId.make("missing"))).toBe(false);
    }).pipe(provide(fakeDriver(), shells));
  });

  it.effect("caps the VMs one thread tree runs at once", () => {
    const root = ThreadId.make("root");
    const [taskA, taskB, other] = ["task-a", "task-b", "other"].map((id) => ThreadId.make(id));
    const inTree = (rootThreadId: ThreadId) => ({ ...liveShell, lineage: { rootThreadId } });
    const shells = new Map<ThreadId, unknown>([
      [root, inTree(root)],
      [taskA!, inTree(root)],
      [taskB!, inTree(root)],
      [other!, inTree(other!)],
    ]);
    const fake = fakeDriver();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      const start = (threadId: ThreadId) =>
        provisioner.ensureSession({ threadId, agent: "claude", hostCwd: "/Users/me/app" });
      yield* start(root);
      yield* start(taskA!);
      expect(yield* provisioner.capacity(taskB!)).toEqual({ running: 2, limit: 2 });
      const refused = yield* Effect.flip(start(taskB!));
      expect(refused.message).toContain("already run 2 Boat VMs");
      // Another tree has its own budget.
      yield* start(other!);
      yield* provisioner.stop(taskA!);
      yield* start(taskB!);
    }).pipe(provide(fake, shells, 2));
  });

  it.effect("destroys the VM of a thread that was deleted or archived", () => {
    const fake = fakeDriver();
    const shells = new Map<ThreadId, unknown>([[threadId, liveShell]]);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner;
      yield* provisioner.ensureSession({ threadId, agent: "claude", hostCwd: "/Users/me/app" });
      shells.set(threadId, { archivedAt: "2026-11-13T00:00:00.000Z", deletedAt: null });
      yield* provisioner.sweep;
      expect(fake.names()).toContain("destroy");
      expect((yield* provisioner.list).sandboxes).toEqual([]);
    }).pipe(provide(fake, shells));
  });
});
