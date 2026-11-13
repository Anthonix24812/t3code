# Fork notes

This is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) that adds
**Run on → Boat sandbox**: a thread can run its agent on its own [boat.dev](https://boat.dev) VM.
[`fork-upstream.json`](fork-upstream.json) records the upstream tag and commit this fork is based
on. The app compares it with upstream's latest release and shows "Upstream T3 X is out" in the
sidebar and in Settings → About. That notice only links here. The app never installs official
binaries over the fork. Desktop builds take their update feed from `GITHUB_REPOSITORY`
(`T3CODE_DESKTOP_UPDATE_REPOSITORY` overrides it), so a fork build updates from the fork's own
releases. Never point it at `pingdotgg/t3code`.

## Boat sandbox

1. Settings → Environments → Boat sandbox: add a boat.dev API key (`BOAT_API_KEY` in the
   server environment also works), and pick a size and the idle minutes (0 never stops).
2. In a new thread's composer, choose **Run on → Boat sandbox**. That switches the thread to the
   Boat provider of the same agent family (Claude, Codex or Gemini). You can also pick
   "Claude · Boat sandbox" (or Codex/Gemini) in the provider picker.
3. The first message creates the VM, installs the tools, clones the current branch from a git
   bundle to `/home/user/work/<name>`, applies your uncommitted changes (untracked files included,
   ignored files left out) as a patch, and runs the agent there.

Agents on the VM get no credentials from this machine unless you opt in: on the Boat provider
instance in Settings → Providers, add environment variables named `T3_SANDBOX_ENV_<NAME>`, for
example `T3_SANDBOX_ENV_ANTHROPIC_API_KEY`, `T3_SANDBOX_ENV_CLAUDE_CODE_OAUTH_TOKEN`,
`T3_SANDBOX_ENV_OPENAI_API_KEY` or `T3_SANDBOX_ENV_GEMINI_API_KEY`. The agent sees them without
the prefix. Your local CLI logins and the server's own env stay here. The values travel inside
the TLS connection to the VM's relay and never appear in a command or on the VM's snapshotted
disk.

The thread stays a normal thread on this server, so the phone and other clients see it. A VM
stops after the idle window and resumes from its snapshot on the next message. Archiving or
deleting the thread deletes the VM, and Settings lists every VM with Stop and Delete.

Diffs and checkpoints: Run on → Boat sandbox also picks a new worktree. After every turn the
server copies the VM's working tree into that worktree before the turn ends, so T3's checkpoints,
diffs and pull request actions see the agent's work. Only a T3 worktree is mirrored. A thread
running in the project root keeps your checkout untouched and its diffs stay empty.

Tasks: the agent on the VM gets T3's own tools through the relay, plus `github_issue_create` and
`sandbox_capacity`. `delegate_task` with `isolation: "worktree"` and a Boat provider starts a task
thread with its own worktree, branch and VM. That task can split off more tasks. Pull requests
and issues are opened on this machine with your GitHub login, which never goes to a VM. The
thread-scoped T3 credential never goes there either: the server adds it to each tunneled call.
A thread tree runs at most 4 VMs at once (Settings → Environments → Boat sandbox → VMs per thread
tree).

How it works: the Boat provider instances are local ACP agents whose command is
`t3 __sandbox-acp <agent>`. That process pipes ACP to this server
([`SandboxAcpBridge.ts`](apps/server/src/sandbox/SandboxAcpBridge.ts)), which provisions the VM
([`SandboxProvisioner.ts`](apps/server/src/sandbox/SandboxProvisioner.ts)) and relays ACP over a
WebSocket to the agent on the VM. The Boat driver is ported from dum-e
([`providers/boat.ts`](apps/server/src/sandbox/providers/boat.ts)). The same WebSocket carries
the agent's MCP calls back here
([`sandboxTunnel.ts`](apps/server/src/sandbox/sandboxTunnel.ts)).

## Syncing with upstream

The scheduled [upstream-sync workflow](.github/workflows/upstream-sync.yml) opens a PR named
`chore: sync upstream T3 Code <tag>` when upstream publishes a release. It never merges. To sync by
hand, or when that PR conflicts:

```sh
git fetch upstream --tags
git switch -c sync/upstream-<tag> origin/main
git merge <tag>            # or, for the feature branch: git rebase <tag>
# resolve conflicts, then update fork-upstream.json (baseTag, baseSha, checkedAt)
vp install && vp run check:changed
vp test run apps/server/src/sandbox apps/web/src/sandbox apps/web/src/forkUpstream
```

Almost everything lives in fork-only files: `apps/server/src/sandbox/`,
`packages/contracts/src/sandbox.ts`, `apps/web/src/sandbox/`, `apps/web/src/forkUpstream/`, this
file and `fork-upstream.json`. The sandbox table is created by the sandbox service itself, not by
the upstream migration list, so upstream's next migration number never collides with it. These
upstream files carry small hooks, which is where conflicts appear:

| File                                                        | Hook                                   |
| ----------------------------------------------------------- | -------------------------------------- |
| `packages/contracts/src/settings.ts`                        | `sandbox` setting and patch field      |
| `packages/contracts/src/rpc.ts`                             | `...SANDBOX_RPCS` in `WsRpcGroup`      |
| `packages/contracts/src/clientRpcPermissions.ts`            | `...SANDBOX_RPC_SCOPES`                |
| `packages/contracts/src/index.ts`                           | export of `sandbox.ts`                 |
| `apps/server/src/auth/RpcAuthorization.ts`                  | `...SANDBOX_READ_RPC_SCOPES`           |
| `apps/server/src/observability/RpcInstrumentation.ts`       | three `"sandbox"` categories           |
| `apps/server/src/settingsSecrets.ts`                        | the `sandbox-boat-api-key` secret slot |
| `apps/server/src/server.ts`                                 | `SandboxProvisioner.layer`             |
| `apps/server/src/ws.ts`                                     | `...sandboxRpcHandlers(...)`           |
| `apps/server/src/binMain.ts`                                | `__sandbox-acp` fast path              |
| `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`  | Run on → Boat sandbox                  |
| `apps/web/src/components/BranchToolbar.tsx`, `ChatView.tsx` | pass `sandboxRunOn`                    |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`  | `<SandboxSettings />`                  |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`         | `<SidebarForkUpstreamNotice />`        |
| `apps/web/src/components/settings/SettingsPanels.tsx`       | `<AboutForkUpstreamRow />`             |

Never open PRs, issues or comments on `pingdotgg/t3code` from this fork.
