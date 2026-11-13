import type { SandboxSize } from "@t3tools/contracts";

/** What a sandbox provider must do for a per-thread VM. Boat is the only driver today. */
export interface SandboxDriver {
  /** Idempotent: repeating it with the same key adopts the VM an earlier lost response created. */
  create(input: {
    readonly name: string;
    readonly size: SandboxSize;
    readonly idempotencyKey: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly id: string }>;
  /** Boots a stopped VM from its snapshot and waits until it runs and its disk is restored. */
  resume(
    id: string,
    input: { readonly size: SandboxSize; readonly ttlSeconds: number },
  ): Promise<void>;
  /** Waits until a new or resumed VM runs and its disk is restored. */
  waitReady(id: string): Promise<void>;
  /** Snapshots the disk and stops billing for compute; resume continues from the snapshot. */
  stop(id: string): Promise<{ readonly snapshotId: string | null }>;
  /** Deletes the VM and its snapshots. A VM that is already gone is not an error. */
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxMachineStatus>;
  exec(id: string, input: SandboxExecInput): Promise<SandboxExecResult>;
  /** Starts a command that outlives the request, such as a server. */
  startDetached(id: string, input: SandboxExecInput): Promise<void>;
  writeFile(id: string, file: SandboxFile): Promise<void>;
  /** Publishes a port on an HTTPS origin and returns that origin. */
  exposePort(id: string, port: number): Promise<string>;
  /** Keeps the provider's own auto-stop at least this far away while a VM is in use. */
  extendTtl(id: string, seconds: number): Promise<void>;
  /** `null` when the account's limits cannot be read; the provider then decides on start. */
  limits(): Promise<SandboxLimits | null>;
}

export type SandboxMachineStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "deleted";

export interface SandboxExecInput {
  readonly script: string;
  /** Values that never reach the command text, process list, or provider command history. */
  readonly secretEnv?: Readonly<Record<string, string>>;
  readonly sudo?: boolean;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mode?: number;
}

export interface SandboxLimits {
  readonly canStart: boolean;
}

// @effect-diagnostics-next-line extendsNativeError:off - thrown inside the Promise driver; the provisioner maps it to SandboxError.
class SandboxCommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "SandboxCommandError";
    this.exitCode = exitCode;
  }
}

export async function execOrThrow(
  driver: SandboxDriver,
  id: string,
  input: SandboxExecInput,
  label: string,
) {
  const result = await driver.exec(id, input);
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2_000);
    throw new SandboxCommandError(
      `${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : "."}`,
      result.exitCode,
    );
  }
  return result.stdout;
}
