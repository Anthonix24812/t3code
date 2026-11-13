// Adapted from dum-e packages/api/src/services/sandbox-bootstrap.ts for Boat's Ubuntu VMs.
import type { SandboxAgent } from "@t3tools/contracts";

import { BOAT_PRIVATE_DIRECTORY, shellQuote } from "./providers/boat.ts";
import { execOrThrow, type SandboxDriver } from "./SandboxProvider.ts";

const SETUP_TIMEOUT_MS = 9 * 60 * 1_000;
export const SANDBOX_RELAY_PORT = 4_710;
const TOOLS_DIRECTORY = "/home/user/.t3-sandbox";
const SANDBOX_RELAY_TOKEN_PATH = `${BOAT_PRIVATE_DIRECTORY}/relay-token`;
const SANDBOX_WORK_DIRECTORY = "/home/user/work";
// Bumping this reinstalls tools on VMs created before the change.
const SETUP_VERSION = "t3-sandbox-setup-v1";

// Docker, Node, Python and git come preinstalled on Boat images.
const APT_PACKAGES = ["bubblewrap", "git", "gnupg", "jq", "ripgrep", "tmux", "zsh"];
// Pinned like dum-e: an unpinned install would change under a resumed VM.
const NPM_PACKAGES = [
  "t3@0.1.9",
  "@anthropic-ai/claude-code@2.1.323",
  "@openai/codex@0.169.0",
  "@google/gemini-cli@0.68.0",
  "@agentclientprotocol/claude-agent-acp@0.107.0",
  "@agentclientprotocol/codex-acp@2.6.0",
];
const RELAY_WS_PACKAGE = "ws@8.23.0";

/** ACP agents the relay starts; each reads its credentials from the env the host forwards. */
const SANDBOX_AGENT_COMMANDS: Record<SandboxAgent, ReadonlyArray<string>> = {
  claude: ["claude-agent-acp"],
  codex: ["codex-acp"],
  gemini: ["gemini", "--acp"],
};

const PROFILE_MARKER = "# t3-sandbox: boat.dev environment";
// Login shells source ~/.profile, which loads boat.dev's ~/.bashrc. That exports a sandbox-scoped
// boat.dev token and a desktop display that no longer runs. Caches leave `~/.cache`, which boat.dev
// snapshots skip, so cached downloads survive stops.
const PROFILE_BLOCK = `${PROFILE_MARKER}
unset ASCII_TOKEN ASCII_API_URL DISPLAY
export XDG_CACHE_HOME="$HOME/.local/cache"
`;
const TMPFILES = `d ${BOAT_PRIVATE_DIRECTORY} 0700 user user -\n`;
// Boat images boot a full GNOME desktop for streaming, audio and computer use. Agents use none of
// it, and it holds about 300 MB of memory. Boat's agent, snapshot units, Docker and SSH stay.
const UNUSED_SYSTEM_UNITS = [
  "accounts-daemon.service",
  "avahi-daemon.service",
  "avahi-daemon.socket",
  "colord.service",
  "cups-browsed.service",
  "cups.path",
  "cups.service",
  "cups.socket",
  "fwupd-refresh.timer",
  "fwupd.service",
  "gnome-remote-desktop.service",
  "lightdm.service",
  "ModemManager.service",
  "motd-news.timer",
  "power-profiles-daemon.service",
  "rtkit-daemon.service",
  "switcheroo-control.service",
  "udisks2.service",
  "update-notifier-download.timer",
  "upower.service",
  "wpa_supplicant.service",
];
// boat.dev defines these directly in /etc/systemd, where they cannot be masked.
const UNUSED_SYSTEM_UNITS_TO_DISABLE = [
  "ascii-streaming-audio.service",
  "moonlight-web.service",
  "sunshine.service",
];
const UNUSED_USER_UNITS = [
  "at-spi-dbus-bus.service",
  "evolution-addressbook-factory.service",
  "evolution-calendar-factory.service",
  "evolution-source-registry.service",
  "gnome-keyring-daemon.service",
  "gnome-keyring-daemon.socket",
  "gvfs-daemon.service",
  "gvfs-metadata.service",
  "pipewire-pulse.service",
  "pipewire-pulse.socket",
  "pipewire.service",
  "pipewire.socket",
  "pulseaudio.service",
  "pulseaudio.socket",
  "wireplumber.service",
  "xdg-desktop-portal-gtk.service",
  "xdg-desktop-portal.service",
  "xdg-document-portal.service",
  "xdg-permission-store.service",
];
// The computer-use driver restarts itself; only a mask in ~/.config overrides it.
const UNUSED_USER_UNITS_TO_MASK_FOR_USER = ["cua-driver.service"];

const env = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => `export ${name}=${shellQuote(value)}`);

/**
 * A resume boots the image before boat.dev restores /etc, so masked units start again on every
 * boot; this runs every session.
 */
const prepareSystemScript = () =>
  [
    "set -eu",
    ...env({
      TMPFILES,
      PROFILE_BLOCK,
      PROFILE_MARKER,
      SYSTEM_UNITS: UNUSED_SYSTEM_UNITS.join(" "),
      SYSTEM_UNITS_TO_DISABLE: UNUSED_SYSTEM_UNITS_TO_DISABLE.join(" "),
      USER_UNITS: UNUSED_USER_UNITS.join(" "),
      USER_UNITS_TO_MASK_FOR_USER: UNUSED_USER_UNITS_TO_MASK_FOR_USER.join(" "),
    }),
    'printf "%s" "$TMPFILES" > /etc/tmpfiles.d/t3-sandbox.conf',
    "systemd-tmpfiles --create /etc/tmpfiles.d/t3-sandbox.conf",
    // Ubuntu's ~/.bash_logout runs clear_console, which fails without a terminal and turns a
    // successful `set -e` login shell's exit into 1.
    "if cmp -s /etc/skel/.bash_logout /home/user/.bash_logout; then rm -f /home/user/.bash_logout; fi",
    'if ! grep -qxF "$PROFILE_MARKER" /home/user/.profile 2>/dev/null; then',
    '  printf "\\n%s" "$PROFILE_BLOCK" >> /home/user/.profile',
    "  chown user:user /home/user/.profile",
    "fi",
    // bubblewrap, which Codex's command sandbox uses, needs unprivileged user namespaces.
    "if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then",
    '  printf "%s\\n" "kernel.apparmor_restrict_unprivileged_userns = 0" > /etc/sysctl.d/60-t3-sandbox-userns.conf',
    "  sysctl --quiet --load /etc/sysctl.d/60-t3-sandbox-userns.conf || true",
    "fi",
    'systemctl mask $SYSTEM_UNITS >/dev/null 2>&1 || for unit in $SYSTEM_UNITS; do systemctl mask "$unit" >/dev/null 2>&1 || true; done',
    "systemctl disable $SYSTEM_UNITS_TO_DISABLE >/dev/null 2>&1 || true",
    "systemctl stop $SYSTEM_UNITS $SYSTEM_UNITS_TO_DISABLE >/dev/null 2>&1 || true",
    "systemctl set-default multi-user.target >/dev/null 2>&1 || true",
    "systemctl --global mask $USER_UNITS >/dev/null 2>&1 || true",
    "systemctl --user --machine=user@.host mask --now $USER_UNITS_TO_MASK_FOR_USER >/dev/null 2>&1 || true",
    "systemctl --user --machine=user@.host stop $USER_UNITS >/dev/null 2>&1 || true",
  ].join("\n");

const installToolsScript = () =>
  [
    "set -eu",
    ...env({
      APT_PACKAGES: APT_PACKAGES.join(" "),
      NPM_PACKAGES: NPM_PACKAGES.join(" "),
      RELAY_WS_PACKAGE,
      TOOLS_DIRECTORY,
      SETUP_VERSION,
      // boat.dev runs an nvm-managed Node, so root installs need an explicit global prefix.
      NPM_CONFIG_PREFIX: "/usr/local",
    }),
    '[ "$(cat "$TOOLS_DIRECTORY/setup-version" 2>/dev/null)" = "$SETUP_VERSION" ] && exit 0',
    "apt-get update",
    "DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends $APT_PACKAGES",
    "apt-get clean",
    "npm install --global --no-audit --no-fund --no-update-notifier $NPM_PACKAGES",
    'mkdir -p "$TOOLS_DIRECTORY"',
    'npm install --prefix "$TOOLS_DIRECTORY" --no-audit --no-fund --no-update-notifier "$RELAY_WS_PACKAGE"',
    'chown -R user:user "$TOOLS_DIRECTORY"',
    "t3 --version && claude --version && codex --version && gemini --version",
    'printf "%s" "$SETUP_VERSION" > "$TOOLS_DIRECTORY/setup-version"',
  ].join("\n");

/**
 * Runs on the VM. It accepts one WebSocket per ACP session, checks the token the host wrote to a
 * private file, starts the requested agent with the env the host forwards, and relays
 * newline-delimited JSON-RPC both ways. Credentials only travel inside the TLS stream, never in a
 * command or a file on the snapshotted disk.
 */
const SANDBOX_RELAY_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

const { WebSocketServer } = createRequire(process.env.TOOLS_DIRECTORY + "/")("ws");
const agents = JSON.parse(process.env.AGENT_COMMANDS);
const server = createServer((request, response) => {
  response.writeHead(request.url === "/healthz" ? 200 : 404).end(request.url === "/healthz" ? "ok" : "");
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
const tokenMatches = (token) => {
  try {
    const expected = Buffer.from(readFileSync(process.env.TOKEN_PATH, "utf8").trim());
    const actual = Buffer.from(String(token));
    return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
};
wss.on("connection", (socket) => {
  let child = null;
  socket.once("message", (data) => {
    let hello;
    try { hello = JSON.parse(String(data)); } catch { return socket.close(4400, "bad hello"); }
    if (!tokenMatches(hello.token)) return socket.close(4401, "unauthorized");
    const command = agents[hello.agent];
    if (!command) return socket.close(4404, "unknown agent");
    const env = { ...process.env, ...hello.env };
    delete env.TOKEN_PATH;
    delete env.AGENT_COMMANDS;
    child = spawn(command[0], command.slice(1), {
      cwd: hello.cwd || process.env.HOME,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim() && socket.readyState === 1) socket.send(line);
    });
    child.on("exit", (code) => socket.close(code === 0 ? 1000 : 4500, "agent exited"));
    child.on("error", () => socket.close(4500, "agent failed to start"));
    socket.on("message", (message) => child.stdin.write(String(message) + "\n"));
    socket.send(JSON.stringify({ t3SandboxRelay: "ready" }));
  });
  socket.on("close", () => child?.kill("SIGTERM"));
});
server.listen(Number(process.env.RELAY_PORT), "0.0.0.0");
`;

const startRelayScript = () =>
  [
    ...env({
      TOOLS_DIRECTORY,
      TOKEN_PATH: SANDBOX_RELAY_TOKEN_PATH,
      RELAY_PORT: String(SANDBOX_RELAY_PORT),
      AGENT_COMMANDS: JSON.stringify(SANDBOX_AGENT_COMMANDS),
    }),
    `exec node ${TOOLS_DIRECTORY}/relay.mjs >>/tmp/t3-sandbox-relay.log 2>&1`,
  ].join("\n");

const relayHealthScript = () =>
  [
    "for attempt in $(seq 1 40); do",
    `  curl --fail --silent --max-time 2 http://127.0.0.1:${SANDBOX_RELAY_PORT}/healthz >/dev/null && exit 0`,
    "  sleep 0.5",
    "done",
    "tail -n 20 /tmp/t3-sandbox-relay.log >&2 || true",
    "exit 1",
  ].join("\n");

export interface SandboxProjectSource {
  readonly bundle: Uint8Array;
  readonly branch: string | null;
  readonly originUrl: string | null;
  readonly directoryName: string;
  readonly gitUserName: string | null;
  readonly gitUserEmail: string | null;
}

export const remoteProjectPath = (directoryName: string) =>
  `${SANDBOX_WORK_DIRECTORY}/${directoryName}`;

const cloneProjectScript = (source: SandboxProjectSource, bundlePath: string) => {
  const target = remoteProjectPath(source.directoryName);
  return [
    "set -eu",
    `if [ ! -d ${shellQuote(`${target}/.git`)} ]; then`,
    `  mkdir -p ${shellQuote(SANDBOX_WORK_DIRECTORY)}`,
    `  git clone --quiet ${source.branch ? `--branch ${shellQuote(source.branch)} ` : ""}${shellQuote(bundlePath)} ${shellQuote(target)}`,
    source.originUrl
      ? `  git -C ${shellQuote(target)} remote set-url origin ${shellQuote(source.originUrl)}`
      : `  git -C ${shellQuote(target)} remote remove origin`,
    "fi",
    `rm -f ${shellQuote(bundlePath)}`,
    ...(source.gitUserName
      ? [`git config --global user.name ${shellQuote(source.gitUserName)}`]
      : []),
    ...(source.gitUserEmail
      ? [`git config --global user.email ${shellQuote(source.gitUserEmail)}`]
      : []),
  ].join("\n");
};

/** Every session: system prep, then the relay with a fresh token. */
export async function startSandboxSession(driver: SandboxDriver, id: string, relayToken: string) {
  await execOrThrow(driver, id, { script: prepareSystemScript(), sudo: true }, "Preparing the VM");
  await driver.writeFile(id, { path: SANDBOX_RELAY_TOKEN_PATH, content: relayToken, mode: 0o600 });
  await driver.startDetached(id, { script: startRelayScript() });
  await execOrThrow(driver, id, { script: relayHealthScript() }, "Starting the sandbox relay");
}

/** Once per VM: tools, the relay program, and the project checkout. */
export async function bootstrapSandbox(
  driver: SandboxDriver,
  id: string,
  source: SandboxProjectSource,
) {
  await execOrThrow(driver, id, { script: prepareSystemScript(), sudo: true }, "Preparing the VM");
  await execOrThrow(
    driver,
    id,
    { script: installToolsScript(), sudo: true, timeoutMs: SETUP_TIMEOUT_MS },
    "Installing agent tools",
  );
  await driver.writeFile(id, {
    path: `${TOOLS_DIRECTORY}/relay.mjs`,
    content: SANDBOX_RELAY_SOURCE,
  });
  const bundlePath = `${BOAT_PRIVATE_DIRECTORY}/project.bundle`;
  await driver.writeFile(id, { path: bundlePath, content: source.bundle, mode: 0o600 });
  await execOrThrow(
    driver,
    id,
    { script: cloneProjectScript(source, bundlePath), timeoutMs: SETUP_TIMEOUT_MS },
    "Cloning the project",
  );
}
