// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off globalDate:off - a Promise driver ported from dum-e; the provisioner wraps it in Effect.
// Ported from dum-e packages/api/src/services/boat-sandbox.ts. Dropped: the PTY terminal daemon,
// iOS artifact ports, the /vercel/sandbox path links, forks, and Prisma; the provisioner keeps the
// name, Boat id, and idempotency key in T3's own SQLite.
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";

import type { SandboxSize } from "@t3tools/contracts";

import type {
  SandboxDriver,
  SandboxExecInput,
  SandboxExecResult,
  SandboxFile,
  SandboxMachineStatus,
} from "../SandboxProvider.ts";
import {
  BoatApiError,
  type BoatClient,
  type BoatCommandStatus,
  type BoatSandboxInfo,
  type BoatSandboxState,
  type BoatSandboxType,
} from "./boatApi.ts";

// Synchronous boat.dev commands are capped at 600 seconds. Longer commands run detached.
const BOAT_SYNC_COMMAND_MAX_MS = 590_000;
const BOAT_DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const BOAT_COMMAND_START_RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 10_000] as const;
const BOAT_HOST_PORT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const BOAT_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
const BOAT_READY_TIMEOUT_MS = 5 * 60 * 1_000;
// The first snapshot of a freshly bootstrapped disk takes minutes; stay below the 15 minute lease.
const BOAT_STOP_TIMEOUT_MS = 12 * 60 * 1_000;
const BOAT_RESUME_STOP_WAIT_MS = 8 * 60 * 1_000;
const BOAT_HYDRATION_TIMEOUT_MS = 10 * 60 * 1_000;
const BOAT_POLL_DELAYS_MS = [500, 1_000, 1_000, 2_000, 2_000, 3_000] as const;
// Status polls of a detached command only give up once they kept failing this long.
const BOAT_COMMAND_STATUS_OUTAGE_MS = 5 * 60 * 1_000;
const BOAT_COMMAND_EXIT_DIRECTORY = "/tmp/t3-sandbox-commands";
// boat.dev's HTTPS gateway reaches every port through its WireGuard tunnel from this address.
const BOAT_GATEWAY_SOURCE = "10.77.0.1";
const BOAT_RUNNING_STATES = new Set<BoatSandboxState>(["idle", "ready", "running"]);
/**
 * Command scripts can hold secrets. /tmp is not snapshotted and is cleared at every boot, and this
 * directory is private to the sandbox user.
 */
export const BOAT_PRIVATE_DIRECTORY = "/tmp/t3-sandbox-private";
// boat.dev passes the whole command string as one argument, which Linux caps at 128 KiB.
const BOAT_INLINE_COMMAND_MAX_BYTES = 64 * 1024;
// boat.dev runs every command in a login shell whose profiles can print; output before this
// marker is dropped.
const BOAT_OUTPUT_MARKER = "__t3_sandbox_command_output__";
// boat.dev's profiles export a sandbox-scoped boat.dev token and a desktop display that does not
// exist once setup stops the desktop. Caches move out of `~/.cache`, which snapshots skip.
const BOAT_COMMAND_PRELUDE = [
  `printf '%s\\n' ${BOAT_OUTPUT_MARKER}`,
  "unset ASCII_TOKEN ASCII_API_URL DISPLAY",
  'export XDG_CACHE_HOME="$HOME/.local/cache"',
].join("\n");

// Hosting a public route opens the port to the whole internet. boat.dev's gateway reaches every
// port through its tunnel, so only the gateway rule stays.
const BOAT_PUBLIC_PORT_FIREWALL_SCRIPT = [
  "if command -v ufw >/dev/null 2>&1; then",
  '  sudo --non-interactive ufw allow from "$GATEWAY_SOURCE" >/dev/null',
  '  sudo --non-interactive ufw delete allow "$FIREWALL_PORT/tcp" >/dev/null 2>&1 || true',
  "fi",
].join("\n");

// Removes the output logs boat.dev keeps for every finished detached command before a snapshot.
const BOAT_PRUNE_PROCESS_LOGS_SCRIPT = [
  'for file in "$HOME"/.ascii/processes/*; do',
  '  [ -f "$file" ] || continue',
  '  pid="${file##*/}"',
  '  pid="${pid%%.*}"',
  '  case "$pid" in ""|*[!0-9]*) continue ;; esac',
  '  [ -d "/proc/$pid" ] || rm -f -- "$file"',
  "done",
].join("\n");

interface BoatCommandStreamFrame {
  data?: string;
  error?: string;
  exitCode?: number | null;
  message?: string;
  retryable?: boolean;
  timedOut?: boolean;
  type: "error" | "exit" | "started" | "stderr" | "stdout";
}

interface BoatCommandAttachFrame {
  data?: string;
  error?: string;
  message?: string;
  nextOffset?: number;
  stderrOffset?: number;
  stdoutOffset?: number;
  type: "attached" | "error" | "exit" | "heartbeat" | "reconnect" | "stderr" | "stdout";
}

class BoatSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoatSandboxError";
  }
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const BOAT_TYPES: Record<SandboxSize, BoatSandboxType> = {
  small: "small",
  default: "default",
  large: "large",
};

/**
 * boat.dev runs one shell string as the sandbox user. Secret environment values and oversized
 * scripts move into a private script that deletes itself, because the command string is visible in
 * `ps`, the systemd journal, and boat.dev's command history.
 */
function buildBoatShellCommand(input: SandboxExecInput) {
  const secretAssignments = Object.entries(input.secretEnv ?? {}).map(
    ([name, value]) => `export ${shellQuote(`${name}=${value}`)}`,
  );
  const launcher = [
    ...(input.sudo ? ["sudo", "--non-interactive", "--"] : []),
    // `timeout` runs inside sudo, so a timeout also kills commands that run as root.
    ...(input.timeoutMs
      ? ["timeout", "--signal=KILL", `${Math.ceil(input.timeoutMs / 1_000)}s`]
      : []),
  ];
  const needsScript =
    secretAssignments.length > 0 || Buffer.byteLength(input.script) > BOAT_INLINE_COMMAND_MAX_BYTES;
  const script = needsScript
    ? {
        content: ['rm -f -- "$0"', ...secretAssignments, input.script, ""].join("\n"),
        path: `${BOAT_PRIVATE_DIRECTORY}/${NodeCrypto.randomUUID()}.sh`,
      }
    : null;
  const execution = script
    ? [...launcher, "bash", shellQuote(script.path)]
    : [...launcher, "bash", "-c", shellQuote(input.script)];
  return {
    command: [
      BOAT_COMMAND_PRELUDE,
      `${input.cwd ? `cd -- ${shellQuote(input.cwd)} && ` : ""}exec ${execution.join(" ")}`,
    ].join("\n"),
    script,
  };
}

// Drops the login-shell output that precedes the command's own output.
function createBoatOutputFilter() {
  let pending: string | null = "";
  return (data: string) => {
    if (pending === null) return data;
    pending += data;
    const markerIndex = pending.indexOf(`${BOAT_OUTPUT_MARKER}\n`);
    if (markerIndex < 0) return "";
    const output = pending.slice(markerIndex + BOAT_OUTPUT_MARKER.length + 1);
    pending = null;
    return output;
  };
}

const isBoatTypeTooSmallError = (error: unknown) =>
  error instanceof BoatApiError && error.code === "type_too_small";

function isBoatCommandNeverStartedError(error: unknown) {
  return (
    error instanceof BoatApiError &&
    ((error.status === 409 &&
      (error.code === "boat_starting" || error.code === "sandbox_starting")) ||
      // boat.dev briefly reports a running sandbox as updating and refuses commands meanwhile.
      error.code === "sandbox_not_ready" ||
      error.code === "sandbox_restoring" ||
      (error.status === 502 && error.retryable === true))
  );
}

function isRetryableBoatError(error: unknown) {
  if (!(error instanceof BoatApiError)) return null;
  return (
    error.retryable === true ||
    isBoatCommandNeverStartedError(error) ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  );
}

// A create whose response was lost may still have created the sandbox. Repeating it with the same
// idempotency key and body returns that sandbox instead of a second one.
const isLostBoatResponseError = (error: unknown) =>
  !(error instanceof BoatApiError) ||
  error.status >= 500 ||
  error.code === "idempotency_in_progress";

const isMissingBoatError = (error: unknown) =>
  error instanceof BoatApiError && error.status === 404;

const BOAT_MACHINE_STATUSES: Record<BoatSandboxState, SandboxMachineStatus> = {
  archived: "stopped",
  archiving: "stopping",
  cancelled: "failed",
  cloning: "starting",
  error: "failed",
  idle: "running",
  init: "starting",
  provisioned: "starting",
  provisioning: "starting",
  ready: "running",
  running: "running",
  updating: "starting",
};

export interface BoatDriverOptions {
  readonly client: BoatClient;
  /** Tests replace the poll and retry waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function createBoatDriver(options: BoatDriverOptions): SandboxDriver {
  const { client } = options;
  const sleep = options.sleep ?? ((ms: number) => NodeTimersPromises.setTimeout(ms));
  const now = options.now ?? Date.now;
  const pollDelay = (attempt: number) =>
    BOAT_POLL_DELAYS_MS[Math.min(attempt, BOAT_POLL_DELAYS_MS.length - 1)]!;

  async function withCommandStartRetry<T>(operation: () => Promise<T>) {
    for (const delayMs of BOAT_COMMAND_START_RETRY_DELAYS_MS) {
      try {
        return await operation();
      } catch (error) {
        if (!isBoatCommandNeverStartedError(error)) throw error;
        await sleep(delayMs);
      }
    }
    return operation();
  }

  const getInfo = async (id: string, signal?: AbortSignal) =>
    (
      await client.request<{ sandbox: BoatSandboxInfo }>("GET", `/sandboxes/${id}`, {
        operation: "get-sandbox",
        signal,
      })
    ).sandbox;

  async function waitForState(
    id: string,
    accept: (state: BoatSandboxState) => boolean,
    timeoutMs: number,
  ) {
    const deadline = now() + timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      const info = await getInfo(id);
      if (accept(info.state)) return info;
      if (info.state === "error" || info.state === "cancelled") {
        throw new BoatSandboxError(
          `boat.dev sandbox ${id} entered ${info.state}${info.error ? `: ${info.error}` : ""}.`,
        );
      }
      if (now() > deadline) {
        throw new BoatSandboxError(
          `boat.dev sandbox ${id} stayed ${info.state} for too long${info.stop ? ` (stop ${info.stop.status}${info.stop.error ? `: ${info.stop.error}` : ""})` : ""}.`,
        );
      }
      await sleep(pollDelay(attempt));
    }
  }

  // A resumed sandbox keeps copying its snapshot onto the disk after it starts. A process that
  // starts before that finishes keeps a working directory in boat.dev's retired lazy-loading tree.
  async function waitForHydration(info: BoatSandboxInfo) {
    const startedAt = now();
    for (let attempt = 0; info.hydrated === false; attempt += 1) {
      if (now() - startedAt > BOAT_HYDRATION_TIMEOUT_MS) return;
      await sleep(pollDelay(attempt));
      info = await getInfo(info.id);
    }
  }

  async function waitReady(id: string) {
    const info = await waitForState(
      id,
      (state) => BOAT_RUNNING_STATES.has(state),
      BOAT_READY_TIMEOUT_MS,
    );
    await waitForHydration(info);
  }

  async function writePrivateFile(id: string, path: string, content: Buffer, signal?: AbortSignal) {
    const write = () =>
      client.request("PUT", `/sandboxes/${id}/files`, {
        body: { content: content.toString("base64"), encoding: "base64", path },
        operation: "write-file",
        signal,
      });
    try {
      await write();
    } catch (error) {
      // The files API does not create folders, and /tmp starts empty after every boot.
      if (!(error instanceof BoatApiError) || error.status >= 500) throw error;
      await syncExec(id, {
        script: `mkdir -p -m 700 ${BOAT_PRIVATE_DIRECTORY}`,
        ...(signal ? { signal } : {}),
      });
      await write();
    }
  }

  async function syncExec(id: string, input: SandboxExecInput): Promise<SandboxExecResult> {
    const timeoutMs = input.timeoutMs ?? BOAT_DEFAULT_COMMAND_TIMEOUT_MS;
    const { command, script } = buildBoatShellCommand(input);
    if (script) await writePrivateFile(id, script.path, Buffer.from(script.content), input.signal);
    return withCommandStartRetry(async () => {
      const filterStdout = createBoatOutputFilter();
      let stdout = "";
      let stderr = "";
      const frames = client.stream<BoatCommandStreamFrame>("POST", `/sandboxes/${id}/commands`, {
        body: {
          command,
          stream: true,
          timeoutSeconds: Math.min(Math.ceil(timeoutMs / 1_000) + 5, 600),
        },
        operation: "run-command",
        signal: input.signal,
      });
      for await (const frame of frames) {
        if (frame.type === "stdout") stdout += filterStdout(frame.data ?? "");
        else if (frame.type === "stderr") stderr += frame.data ?? "";
        else if (frame.type === "exit") {
          return { exitCode: frame.timedOut ? 137 : (frame.exitCode ?? 1), stdout, stderr };
        } else if (frame.type === "error") {
          throw new BoatApiError(
            frame.message ?? frame.error ?? "boat.dev command failed.",
            502,
            frame.error ?? null,
            frame.retryable ?? false,
            null,
          );
        }
      }
      throw new BoatSandboxError("boat.dev command stream ended before the exit.");
    });
  }

  async function startCommand(id: string, input: SandboxExecInput) {
    const exitToken = NodeCrypto.randomUUID();
    const { command, script } = buildBoatShellCommand(input);
    if (script) await writePrivateFile(id, script.path, Buffer.from(script.content), input.signal);
    // Record the exit code next to the process so it survives a boat.dev agent restart.
    const wrapped = [
      `mkdir -p ${BOAT_COMMAND_EXIT_DIRECTORY}`,
      `(${command})`,
      "code=$?",
      `printf '%s' "$code" > ${BOAT_COMMAND_EXIT_DIRECTORY}/${exitToken}.exit`,
      'exit "$code"',
    ].join("; ");
    const started = await withCommandStartRetry(() =>
      client.request<{ processId: number }>("POST", `/sandboxes/${id}/commands`, {
        body: { command: wrapped, detached: true },
        operation: "start-command",
        signal: input.signal,
      }),
    );
    return { processId: started.processId, exitToken };
  }

  // Process ids are plain PIDs that an unrelated process can reuse after a resume; the exit token
  // in the wrapper proves which process it is.
  async function commandStatus(
    id: string,
    processId: number,
    exitToken: string,
    signal?: AbortSignal,
  ) {
    const status = await client.request<BoatCommandStatus>(
      "GET",
      `/sandboxes/${id}/commands/${processId}`,
      { operation: "get-command-status", query: { tailBytes: 1 }, signal },
    );
    if (status.command !== null && !status.command.includes(exitToken)) {
      return { ...status, exitCode: null, running: false, status: "lost" as const };
    }
    return status;
  }

  async function detachedExec(id: string, input: SandboxExecInput): Promise<SandboxExecResult> {
    const { processId, exitToken } = await startCommand(id, input);
    const filterStdout = createBoatOutputFilter();
    let stdout = "";
    let stderr = "";
    let stdoutOffset = 0;
    let stderrOffset = 0;
    // Attach for output; a dropped stream only ends the output, the status poll decides the exit.
    for (let reconnect = true; reconnect;) {
      reconnect = false;
      try {
        const frames = client.stream<BoatCommandAttachFrame>(
          "GET",
          `/sandboxes/${id}/commands/${processId}/stream`,
          {
            operation: "attach-command",
            query: { stderrOffset, stdoutOffset },
            signal: input.signal,
          },
        );
        for await (const frame of frames) {
          if (frame.type === "stdout") {
            stdout += filterStdout(frame.data ?? "");
            stdoutOffset = frame.nextOffset ?? stdoutOffset;
          } else if (frame.type === "stderr") {
            stderr += frame.data ?? "";
            stderrOffset = frame.nextOffset ?? stderrOffset;
          } else if (frame.type === "reconnect") {
            stdoutOffset = frame.stdoutOffset ?? stdoutOffset;
            stderrOffset = frame.stderrOffset ?? stderrOffset;
            reconnect = true;
          } else if (frame.type === "exit" || frame.type === "error") break;
        }
      } catch (error) {
        if (isRetryableBoatError(error) !== true || input.signal?.aborted) throw error;
      }
    }
    let failingSince: number | null = null;
    for (let attempt = 0; ; attempt += 1) {
      input.signal?.throwIfAborted();
      let status: BoatCommandStatus;
      try {
        status = await commandStatus(id, processId, exitToken, input.signal);
        failingSince = null;
      } catch (error) {
        // A failed poll says nothing about the command, so only a lasting outage ends the wait.
        failingSince ??= now();
        if (
          isRetryableBoatError(error) !== true ||
          now() - failingSince > BOAT_COMMAND_STATUS_OUTAGE_MS
        ) {
          throw error;
        }
        await sleep(pollDelay(attempt));
        continue;
      }
      if (!status.running) {
        return { exitCode: await resolveExitCode(id, status, exitToken), stdout, stderr };
      }
      await sleep(pollDelay(attempt));
    }
  }

  // A restarted boat.dev agent forgets exit codes ("lost"); the command wrapper records them.
  async function resolveExitCode(id: string, status: BoatCommandStatus, exitToken: string) {
    if (status.status !== "lost" && status.exitCode !== null) return status.exitCode;
    const recorded = await syncExec(id, {
      script: `cat ${BOAT_COMMAND_EXIT_DIRECTORY}/${exitToken}.exit 2>/dev/null || true`,
    });
    const exitCode = Number.parseInt(recorded.stdout.trim(), 10);
    return Number.isInteger(exitCode) ? exitCode : 137;
  }

  async function hostPort(id: string, port: number) {
    // Reapplying the same route is safe even if the previous response was lost.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const hosted = await client.request<{ url?: string; route?: { url?: string } }>(
          "POST",
          `/sandboxes/${id}/host`,
          { body: { port, public: true, title: "T3 Code sandbox" }, operation: "host-port" },
        );
        return hosted;
      } catch (error) {
        const delayMs = BOAT_HOST_PORT_RETRY_DELAYS_MS.at(attempt);
        if (delayMs === undefined || isRetryableBoatError(error) !== true) throw error;
        await sleep(delayMs);
      }
    }
  }

  return {
    async create(input) {
      const body = {
        // VMs never keep command output in boat.dev's history; T3 passes its secrets per command.
        monitoring: false,
        // With the account environment, boat.dev signs agents in with the subscriptions connected
        // to the account and keeps them refreshed. Without it, T3 sends this machine's logins.
        noEnv: !input.accountEnvironment,
        ttlSeconds: input.ttlSeconds,
        type: BOAT_TYPES[input.size],
      };
      let created: { id?: string; sandbox?: { id: string } | null } | null = null;
      for (let attempt = 0; !created; attempt += 1) {
        try {
          created = await client.request<{ id?: string; sandbox?: { id: string } | null }>(
            "POST",
            "/sandboxes",
            {
              body,
              headers: { "Idempotency-Key": input.idempotencyKey },
              operation: "create-sandbox",
            },
          );
        } catch (error) {
          const delayMs = BOAT_COMMAND_START_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined || !isLostBoatResponseError(error)) throw error;
          await sleep(delayMs);
        }
      }
      const id = created.sandbox?.id ?? created.id;
      if (!id)
        throw new BoatSandboxError(`boat.dev did not return a sandbox id for ${input.name}.`);
      await client.request("PATCH", `/sandboxes/${id}`, {
        body: { name: input.name },
        operation: "update-sandbox",
      });
      return { id };
    },

    waitReady,

    async resume(id, input) {
      let info = await getInfo(id);
      if (info.state === "archiving") {
        info = await waitForState(id, (state) => state === "archived", BOAT_RESUME_STOP_WAIT_MS);
      }
      const resume = (type?: BoatSandboxType) =>
        client.request("POST", `/sandboxes/${id}/resume`, {
          body: { ttlSeconds: input.ttlSeconds, ...(type ? { type } : {}) },
          operation: "resume-sandbox",
        });
      // An errored sandbox has no machine and resumes from its last snapshot like a stopped one.
      if (info.state === "archived" || info.state === "error") {
        const type = BOAT_TYPES[input.size];
        try {
          await resume(type);
        } catch (error) {
          // boat.dev refuses a smaller type than the data needs; keep the current one then.
          if (!info.type || info.type === type || !isBoatTypeTooSmallError(error)) throw error;
          await resume(info.type);
        }
      } else if (BOAT_RUNNING_STATES.has(info.state) && info.stop?.status === "failing") {
        // A refused stop keeps retrying until the sandbox archives; only a resume cancels it.
        await resume();
      }
      await waitReady(id);
    },

    async stop(id) {
      const info = await getInfo(id);
      if (BOAT_RUNNING_STATES.has(info.state)) {
        await syncExec(id, { script: BOAT_PRUNE_PROCESS_LOGS_SCRIPT }).catch(() => undefined);
      }
      // An errored sandbox has no machine left to stop, and its last snapshot stays resumable.
      if (info.state !== "archived" && info.state !== "error") {
        await client.request("POST", `/sandboxes/${id}/stop`, {
          body: {},
          operation: "stop-sandbox",
        });
        await waitForState(id, (state) => state === "archived", BOAT_STOP_TIMEOUT_MS);
      }
      const latest = await client.request<{ snapshot: { id: string } | null }>(
        "GET",
        `/sandboxes/${id}/snapshots/latest`,
        { operation: "get-latest-snapshot" },
      );
      return { snapshotId: latest.snapshot?.id ?? null };
    },

    async destroy(id) {
      try {
        await client.request("DELETE", `/sandboxes/${id}`, {
          headers: { "X-Ascii-Confirm-Delete": id },
          operation: "delete-sandbox",
        });
      } catch (error) {
        if (!isMissingBoatError(error)) throw error;
      }
    },

    async status(id) {
      try {
        return BOAT_MACHINE_STATUSES[(await getInfo(id)).state];
      } catch (error) {
        if (isMissingBoatError(error)) return "deleted";
        throw error;
      }
    },

    async exec(id, input) {
      return (input.timeoutMs ?? 0) > BOAT_SYNC_COMMAND_MAX_MS
        ? detachedExec(id, input)
        : syncExec(id, input);
    },

    async startDetached(id, input) {
      await startCommand(id, input);
    },

    async writeFile(id, file: SandboxFile) {
      // The files API only writes below /home/user and /tmp, without modes or parent folders.
      // Stage privately, then install next to the target and rename, so readers never see a
      // partial file.
      const content = Buffer.from(file.content);
      const stagePath = `${BOAT_PRIVATE_DIRECTORY}/upload-${NodeCrypto.randomUUID()}`;
      const chunkCount = Math.max(Math.ceil(content.length / BOAT_FILE_CHUNK_BYTES), 1);
      for (let index = 0; index < chunkCount; index += 1) {
        await writePrivateFile(
          id,
          `${stagePath}.${index}`,
          content.subarray(index * BOAT_FILE_CHUNK_BYTES, (index + 1) * BOAT_FILE_CHUNK_BYTES),
        );
      }
      const parts = Array.from({ length: chunkCount }, (_, index) =>
        shellQuote(`${stagePath}.${index}`),
      ).join(" ");
      const installPath = shellQuote(`${file.path}.t3-${NodeCrypto.randomUUID()}`);
      const result = await syncExec(id, {
        script: [
          "set -eu",
          `cat ${parts} > ${shellQuote(stagePath)}`,
          `rm -f ${parts}`,
          `install -D -m ${(file.mode ?? 0o644).toString(8)} ${shellQuote(stagePath)} ${installPath}`,
          `rm -f ${shellQuote(stagePath)}`,
          `mv -f -- ${installPath} ${shellQuote(file.path)}`,
        ].join("\n"),
      });
      if (result.exitCode !== 0) {
        throw new BoatSandboxError(`Could not write ${file.path}: ${result.stderr.trim()}`);
      }
    },

    async exposePort(id, port) {
      const hosted = await hostPort(id, port);
      await syncExec(id, {
        script: [
          `export GATEWAY_SOURCE=${BOAT_GATEWAY_SOURCE} FIREWALL_PORT=${port}`,
          BOAT_PUBLIC_PORT_FIREWALL_SCRIPT,
        ].join("\n"),
      });
      const url = hosted.url ?? hosted.route?.url;
      if (url) return url.replace(/\/$/, "");
      const info = await getInfo(id);
      if (!info.subdomain) {
        throw new BoatSandboxError(`boat.dev sandbox ${id} does not have a hosted subdomain yet.`);
      }
      return `https://${info.subdomain}-${port}.on.boat.dev`;
    },

    async extendTtl(id, seconds) {
      const info = await getInfo(id);
      if (info.archiveAfter && new Date(info.archiveAfter).getTime() - now() >= seconds * 1_000) {
        return;
      }
      await client.request("PATCH", `/sandboxes/${id}`, {
        body: { ttlSeconds: seconds },
        operation: "update-sandbox",
      });
    },

    async limits() {
      try {
        const limits = await client.request<{ canStart?: boolean }>("GET", "/limits", {
          operation: "get-limits",
        });
        return { canStart: limits.canStart !== false };
      } catch {
        return null;
      }
    },
  };
}
