// @effect-diagnostics nodeBuiltinImport:off -- A CLI fast path that loads before the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

/**
 * Only variables the user set on the Boat provider instance as `T3_SANDBOX_ENV_<NAME>` reach the
 * VM. This process also inherits the server's env, whose own API keys must not leave the machine.
 */
const FORWARDED_ENV_PREFIX = "T3_SANDBOX_ENV_";

export function forwardedSandboxEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (name.startsWith(FORWARDED_ENV_PREFIX) && name.length > FORWARDED_ENV_PREFIX.length) {
      forwarded[name.slice(FORWARDED_ENV_PREFIX.length)] = value;
    }
  }
  return forwarded;
}

/**
 * `t3 __sandbox-acp <agent>`: the ACP agent T3 spawns for a Boat sandbox thread. It only pipes
 * stdio to this machine's T3 server, which provisions the VM and relays ACP to the agent there.
 */
export async function runSandboxAcpPipe(args: ReadonlyArray<string>): Promise<void> {
  const socketPath = process.env.T3_SANDBOX_ACP_SOCKET;
  const tokenFile = process.env.T3_SANDBOX_ACP_TOKEN_FILE;
  const agent = args[0];
  if (!socketPath || !tokenFile || !agent) {
    process.stderr.write("__sandbox-acp requires an agent and the T3 sandbox socket settings.\n");
    process.exitCode = 2;
    return;
  }
  const token = NodeFS.readFileSync(tokenFile, "utf8").trim();
  const socket = NodeNet.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `${JSON.stringify({
      token,
      agent,
      // Absent for the provider probe, which must never start a VM.
      threadId: process.env.T3CODE_THREAD_ID ?? null,
      env: forwardedSandboxEnv(process.env),
    })}\n`,
  );
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    process.stdin.once("end", () => socket.end());
  });
}
