// @effect-diagnostics nodeBuiltinImport:off - host git plumbing for the sandbox provisioner, outside Effect's platform layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { SandboxProjectSource } from "./sandboxSetup.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
/** A larger patch is almost always build output that .gitignore misses; it fails the start. */
const MAX_SANDBOX_PATCH_BYTES = 64 * 1024 * 1024;

const git = async (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  (
    await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 1024 * 1024,
      ...(env ? { env } : {}),
    })
  ).stdout.trim();
const gitOrNull = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).then(
    (value) => value || null,
    () => null,
  );

async function withTempDir<A>(run: (directory: string) => Promise<A>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-git-"));
  try {
    return await run(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Every change from `base` to the working tree, untracked files included and ignored files left
 * out. A throwaway index keeps the checkout's own index and staging untouched.
 */
export function workingTreePatch(cwd: string, base: string): Promise<Uint8Array> {
  return withTempDir(async (directory) => {
    const env = { ...process.env, GIT_INDEX_FILE: NodePath.join(directory, "index") };
    const output = NodePath.join(directory, "changes.patch");
    await git(cwd, ["read-tree", base], env);
    await git(cwd, ["add", "--all"], env);
    await git(cwd, ["diff", "--cached", "--binary", `--output=${output}`, base], env);
    const patch = await NodeFSP.readFile(output);
    if (patch.byteLength > MAX_SANDBOX_PATCH_BYTES) {
      throw new Error(
        "The uncommitted changes are larger than 64 MiB; commit or ignore build output.",
      );
    }
    return patch;
  });
}

/** The current branch's committed history plus a patch of everything not yet committed. */
export async function readProjectSource(hostCwd: string): Promise<SandboxProjectSource> {
  const root = await git(hostCwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("Boat sandboxes need a project that is a git repository with a commit.");
  });
  const branch = await gitOrNull(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const bundle = await withTempDir(async (directory) => {
    const bundlePath = NodePath.join(directory, "project.bundle");
    await git(root, ["bundle", "create", bundlePath, "HEAD", ...(branch ? [branch] : [])]);
    return NodeFSP.readFile(bundlePath);
  });
  const patch = await workingTreePatch(root, base);
  return {
    bundle,
    patch: patch.byteLength > 0 ? patch : null,
    base,
    branch,
    originUrl: await gitOrNull(root, ["remote", "get-url", "origin"]),
    directoryName: NodePath.basename(root).replace(/[^A-Za-z0-9._-]/g, "-") || "project",
    gitUserName: await gitOrNull(root, ["config", "user.name"]),
    gitUserEmail: await gitOrNull(root, ["config", "user.email"]),
  };
}

export const headCommit = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);

/**
 * Makes a host worktree show exactly the VM's changes on top of `base`, so T3's own checkpoints and
 * diffs read the agent's work. Only for a T3 worktree that mirrors a VM: local edits there are
 * replaced.
 */
export async function mirrorPatch(hostCwd: string, base: string, vmPatch: Uint8Array) {
  const current = await workingTreePatch(hostCwd, base);
  if (Buffer.compare(Buffer.from(current), Buffer.from(vmPatch)) === 0) return false;
  await git(hostCwd, ["reset", "--hard", "--quiet", base]);
  await git(hostCwd, ["clean", "-fd", "--quiet"]);
  if (vmPatch.byteLength > 0) {
    await withTempDir(async (directory) => {
      const file = NodePath.join(directory, "vm.patch");
      await NodeFSP.writeFile(file, vmPatch);
      await git(hostCwd, ["apply", "--binary", "--whitespace=nowarn", file]);
    });
  }
  return true;
}
