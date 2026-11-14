// @effect-diagnostics nodeBuiltinImport:off - real git repositories in a temp directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { headCommit, mirrorPatch, readProjectSource, workingTreePatch } from "./sandboxGit.ts";

const run = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

function repo() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-git-test-"));
  run(dir, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# app\n");
  NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), "node_modules/\n");
  run(dir, "add", ".");
  run(dir, "commit", "-qm", "init");
  return dir;
}

const read = (dir: string, file: string) => NodeFS.readFileSync(NodePath.join(dir, file), "utf8");

describe("sandbox git", () => {
  it("carries uncommitted, staged and untracked changes but not ignored files", async () => {
    const dir = repo();
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# app\nedited\n");
    NodeFS.writeFileSync(NodePath.join(dir, "new.ts"), "export const x = 1;\n");
    NodeFS.mkdirSync(NodePath.join(dir, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(dir, "node_modules", "big.js"), "ignored");
    run(dir, "add", "new.ts");
    const stagedBefore = run(dir, "diff", "--cached", "--name-only");

    const source = await readProjectSource(dir);
    const patch = Buffer.from(source.patch!).toString("utf8");
    expect(source.branch).toBe("main");
    expect(patch).toContain("+edited");
    expect(patch).toContain("new.ts");
    expect(patch).not.toContain("node_modules");
    // The user's own index is untouched.
    expect(run(dir, "diff", "--cached", "--name-only")).toBe(stagedBefore);
  });

  it("has no patch for a clean checkout", async () => {
    expect((await readProjectSource(repo())).patch).toBeNull();
  });

  it("mirrors a VM's working tree into a host worktree, replacing stale edits", async () => {
    const vm = repo();
    const host = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-host-"));
    run(host, "clone", "-q", vm, ".");
    const base = await headCommit(host);
    NodeFS.writeFileSync(NodePath.join(vm, "README.md"), "# app\nfrom the vm\n");
    NodeFS.writeFileSync(NodePath.join(vm, "added.txt"), "vm file\n");
    NodeFS.writeFileSync(NodePath.join(host, "stale.txt"), "left from an older turn\n");

    const vmPatch = await workingTreePatch(vm, base);
    expect(await mirrorPatch(host, base, vmPatch)).toBe(true);
    expect(read(host, "README.md")).toBe("# app\nfrom the vm\n");
    expect(read(host, "added.txt")).toBe("vm file\n");
    expect(NodeFS.existsSync(NodePath.join(host, "stale.txt"))).toBe(false);
    // Unchanged on the next turn: nothing is rewritten.
    expect(await mirrorPatch(host, base, vmPatch)).toBe(false);
  });
});
