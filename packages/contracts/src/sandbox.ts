import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

// Fork-only: per-thread Boat sandboxes. Kept in one file so rebases onto upstream stay cheap.

export const SandboxSize = Schema.Literals(["small", "default", "large"]);
export type SandboxSize = typeof SandboxSize.Type;

export const SandboxAgent = Schema.Literals(["claude", "codex", "gemini"]);
export type SandboxAgent = typeof SandboxAgent.Type;

export const SANDBOX_AGENTS: ReadonlyArray<SandboxAgent> = ["claude", "codex", "gemini"];
export const SANDBOX_AGENT_LABELS: Record<SandboxAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};
/** Provider instance ids the server registers when a Boat key is configured. */
export const sandboxProviderInstanceId = (agent: SandboxAgent) =>
  `boat${agent[0]!.toUpperCase()}${agent.slice(1)}`;
export const isSandboxProviderInstanceId = (instanceId: string) =>
  SANDBOX_AGENTS.some((agent) => sandboxProviderInstanceId(agent) === instanceId);

export const DEFAULT_SANDBOX_IDLE_MINUTES = 15;
export const DEFAULT_SANDBOX_MAX_CONCURRENT_VMS = 4;

export const SandboxSettings = Schema.Struct({
  boatApiKey: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  size: SandboxSize.pipe(Schema.withDecodingDefault(Effect.succeed("default" as const))),
  /** 0 never stops an idle VM; the provider's own TTL still applies. */
  idleMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SANDBOX_IDLE_MINUTES)),
  ),
  /** Boat VMs a thread and the tasks it splits off may run at once. */
  maxConcurrentVms: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SANDBOX_MAX_CONCURRENT_VMS)),
  ),
  /** Copies this machine's Claude and ChatGPT (Codex) logins to each VM session. */
  copyHostLogins: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type SandboxSettings = typeof SandboxSettings.Type;
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = Schema.decodeSync(SandboxSettings)({});

export const SandboxSettingsPatch = Schema.Struct({
  boatApiKey: Schema.optionalKey(SettingsSecretValue),
  size: Schema.optionalKey(SandboxSize),
  idleMinutes: Schema.optionalKey(Schema.Int),
  maxConcurrentVms: Schema.optionalKey(Schema.Int),
  copyHostLogins: Schema.optionalKey(Schema.Boolean),
});

export const SandboxState = Schema.Literals([
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "destroying",
  "failed",
]);
export type SandboxState = typeof SandboxState.Type;

export const SandboxRecord = Schema.Struct({
  threadId: ThreadId,
  name: Schema.String,
  boatSandboxId: Schema.NullOr(Schema.String),
  state: SandboxState,
  size: SandboxSize,
  agent: SandboxAgent,
  lastActiveAt: IsoDateTime,
  createdAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type SandboxRecord = typeof SandboxRecord.Type;

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const SANDBOX_WS_METHODS = {
  list: "sandbox.list",
  destroy: "sandbox.destroy",
  stop: "sandbox.stop",
} as const;

export const SandboxListResult = Schema.Struct({
  configured: Schema.Boolean,
  sandboxes: Schema.Array(SandboxRecord),
});
export const SandboxThreadInput = Schema.Struct({ threadId: ThreadId });

const error = Schema.Union([SandboxError, EnvironmentAuthorizationError]);

export const SANDBOX_RPCS = [
  Rpc.make(SANDBOX_WS_METHODS.list, {
    payload: Schema.Struct({}),
    success: SandboxListResult,
    error,
  }),
  Rpc.make(SANDBOX_WS_METHODS.stop, { payload: SandboxThreadInput, success: Schema.Void, error }),
  Rpc.make(SANDBOX_WS_METHODS.destroy, {
    payload: SandboxThreadInput,
    success: Schema.Void,
    error,
  }),
] as const;

/** Mutations, guarded on the client too. */
export const SANDBOX_RPC_SCOPES = {
  [SANDBOX_WS_METHODS.stop]: AuthOrchestrationOperateScope,
  [SANDBOX_WS_METHODS.destroy]: AuthOrchestrationOperateScope,
} as const;
export const SANDBOX_READ_RPC_SCOPES = {
  [SANDBOX_WS_METHODS.list]: AuthOrchestrationReadScope,
} as const;
