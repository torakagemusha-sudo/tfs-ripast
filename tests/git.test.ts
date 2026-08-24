import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli.js";
import { resolveGitScope } from "../src/git.js";

const execute = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-git-"));
  temporaryRoots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "TFS Ripast Tests"]);
  await git(root, ["config", "user.email", "tests@example.invalid"]);
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function captureIo(root: string): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd: root,
      isTTY: false,
      confirm: async () => false,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("resolveGitScope", () => {
  it("kills an override Git provider's background descendant when scope detection times out", async () => {
    const root = await repository();
    const marker = join(root, "git-descendant-survived");
    const executable = join(root, "fake-git");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const { spawn } = require('node:child_process');",
      `const marker = ${JSON.stringify(marker)};`,
      "const child = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 250)`], { stdio: 'ignore' });",
      "child.unref();",
      "process.on('SIGTERM', () => undefined);",
      "setInterval(() => undefined, 1000);",
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);

    await expect(resolveGitScope({ root, executable, timeoutMs: 30 }))
      .rejects.toThrow(/Git|timed out|execute/i);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enumerates tracked-later-ignored and visible untracked files without admitting untracked ignored files", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.ts"), "old(value);\n", "utf8");
    await commit(root, "tracked baseline");
    await writeFile(join(root, ".gitignore"), "tracked.ts\nignored.ts\n", "utf8");
    await writeFile(join(root, "visible.ts"), "visible\n", "utf8");
    await writeFile(join(root, "ignored.ts"), "ignored\n", "utf8");

    const scope = await resolveGitScope({ root });
    const includingIgnored = await resolveGitScope({ root, includeIgnored: true });

    expect(scope.repository).toBe(true);
    expect(scope.files).toEqual([".gitignore", "tracked.ts", "visible.ts"]);
    expect(scope.trackedFiles).toEqual(["tracked.ts"]);
    expect(scope.dirty).toBe(true);
    expect(includingIgnored.files).toEqual([".gitignore", "ignored.ts", "tracked.ts", "visible.ts"]);
  });

  it("distinguishes tracked, staged, and changed scopes with index-aware argument vectors", async () => {
    const root = await repository();
    await writeFile(join(root, "unstaged.txt"), "base\n", "utf8");
    await writeFile(join(root, "staged.txt"), "base\n", "utf8");
    await commit(root, "baseline");
    await writeFile(join(root, "unstaged.txt"), "worktree\n", "utf8");
    await writeFile(join(root, "staged.txt"), "index\n", "utf8");
    await git(root, ["add", "staged.txt"]);
    await writeFile(join(root, "untracked.txt"), "new\n", "utf8");

    const tracked = await resolveGitScope({ root, trackedOnly: true });
    const staged = await resolveGitScope({ root, staged: true });
    const changed = await resolveGitScope({ root, changedOnly: true });

    expect(tracked.files).toEqual(["staged.txt", "unstaged.txt"]);
    expect(staged.files).toEqual(["staged.txt"]);
    expect(changed.files).toEqual(["staged.txt", "unstaged.txt", "untracked.txt"]);
  });

  it("resolves a since revision to a commit before using it as a diff operand", async () => {
    const root = await repository();
    await writeFile(join(root, "before.txt"), "before\n", "utf8");
    const baseline = await commit(root, "baseline");
    await writeFile(join(root, "before.txt"), "after\n", "utf8");
    await writeFile(join(root, "added.txt"), "added\n", "utf8");
    await commit(root, "later");
    await writeFile(join(root, "worktree.txt"), "untracked and therefore not ref-relative\n", "utf8");

    const scope = await resolveGitScope({ root, since: baseline });

    expect(scope.files).toEqual(["added.txt", "before.txt"]);
    expect(scope.sinceCommit).toBe(baseline);
    await expect(resolveGitScope({ root, since: "--output=/tmp/tfs-ripast-owned" }))
      .rejects.toThrow(/revision|ref|unsafe|resolve/i);
  });

  it("reports changed, staged, and since paths relative to a nested root and excludes same-name files outside it", async () => {
    const repositoryRoot = await repository();
    const root = join(repositoryRoot, "packages", "inside");
    await mkdir(root, { recursive: true });
    await mkdir(join(repositoryRoot, "packages", "outside"), { recursive: true });
    await writeFile(join(root, "same.ts"), "inside baseline\n", "utf8");
    await writeFile(join(repositoryRoot, "packages", "outside", "same.ts"), "outside baseline\n", "utf8");
    const baseline = await commit(repositoryRoot, "nested baseline");
    await writeFile(join(root, "same.ts"), "inside changed\n", "utf8");
    await writeFile(join(repositoryRoot, "packages", "outside", "same.ts"), "outside changed\n", "utf8");
    await git(repositoryRoot, ["add", "packages/inside/same.ts", "packages/outside/same.ts"]);

    expect((await resolveGitScope({ root, changedOnly: true })).files).toEqual(["same.ts"]);
    expect((await resolveGitScope({ root, staged: true })).files).toEqual(["same.ts"]);
    expect((await resolveGitScope({ root, since: baseline })).files).toEqual(["same.ts"]);
  });

  it("reports clean and dirty state and rejects require-clean before mutation", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "clean\n", "utf8");
    const head = await commit(root, "clean baseline");

    expect(await resolveGitScope({ root, requireClean: true })).toMatchObject({
      dirty: false,
      head,
    });

    await writeFile(join(root, "tracked.txt"), "dirty\n", "utf8");
    await expect(resolveGitScope({ root, requireClean: true })).rejects.toThrow(/dirty|clean/i);
  });

  it("treats changes outside a nested rewrite root as repository-wide require-clean drift", async () => {
    const repositoryRoot = await repository();
    const root = join(repositoryRoot, "nested");
    await mkdir(root);
    await writeFile(join(root, "inside.txt"), "clean\n", "utf8");
    await writeFile(join(repositoryRoot, "outside.txt"), "clean\n", "utf8");
    await commit(repositoryRoot, "clean nested baseline");
    await writeFile(join(repositoryRoot, "outside.txt"), "dirty outside\n", "utf8");

    await expect(resolveGitScope({ root, requireClean: true })).rejects.toThrow(/dirty|clean/i);
  });

  it("keeps Git optional until a Git-only scope or clean policy is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfs-ripast-non-git-"));
    temporaryRoots.push(root);

    await expect(resolveGitScope({ root })).resolves.toMatchObject({
      repository: false,
      dirty: false,
      files: [],
      trackedFiles: [],
    });
    await expect(resolveGitScope({ root, changedOnly: true })).rejects.toThrow(/Git repository/i);
    await expect(resolveGitScope({ root, requireClean: true })).rejects.toThrow(/Git repository/i);
  });
});

describe("CLI Git scopes", () => {
  it("limits provider candidates to changed tracked and visible untracked files", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.txt"), "old baseline\n", "utf8");
    await writeFile(join(root, "unchanged.txt"), "old baseline\n", "utf8");
    await commit(root, "baseline");
    await writeFile(join(root, "changed.txt"), "old changed\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "old untracked\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--changed-only",
      "--write",
      ".",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(await readFile(join(root, "changed.txt"), "utf8")).toBe("new changed\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("new untracked\n");
    expect(await readFile(join(root, "unchanged.txt"), "utf8")).toBe("old baseline\n");
  });

  it("rejects --require-clean before provider or transaction mutation", async () => {
    const root = await repository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await commit(root, "baseline");
    await writeFile(join(root, "input.txt"), "old dirty\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--require-clean",
      "--write",
      "input.txt",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/dirty|clean/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old dirty\n");
  });

  it("enumerates a tracked-later-ignored pure AST candidate that ripgrep cannot discover lexically", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.ts"), "const result = old(value);\n", "utf8");
    await commit(root, "tracked baseline");
    await writeFile(join(root, ".gitignore"), "tracked.ts\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old($ARG)",
      "--replace", "new(${ARG})",
      "--lang", "typescript",
      "--write",
      "--json",
      ".",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      outcome: "written",
      planning: { classifications: { "ast-only": 1 } },
    });
    expect(await readFile(join(root, "tracked.ts"), "utf8")).toContain("new(value)");
  });

  it("does not traverse or mutate a Git submodule scope entry", async () => {
    const root = await repository();
    await mkdir(join(root, "embedded"));
    await git(join(root, "embedded"), ["init", "-q"]);
    await git(join(root, "embedded"), ["config", "user.name", "TFS Ripast Tests"]);
    await git(join(root, "embedded"), ["config", "user.email", "tests@example.invalid"]);
    await writeFile(join(root, "embedded", "input.txt"), "old submodule\n", "utf8");
    await commit(join(root, "embedded"), "submodule baseline");
    await writeFile(join(root, "root.txt"), "old root\n", "utf8");
    await commit(root, "root baseline");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--write",
      ".",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(await readFile(join(root, "root.txt"), "utf8")).toBe("new root\n");
    expect(await readFile(join(root, "embedded", "input.txt"), "utf8")).toBe("old submodule\n");
  });

  it("keeps the exact saved-plan artifact outside Git-aware apply re-derivation", async () => {
    const root = await repository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await commit(root, "baseline");
    const planned = captureIo(root);
    expect(await main([
      "--search", "old",
      "--replace", "new",
      "--plan-out", "saved.json",
      "--json",
      ".",
    ], planned.io), planned.stderr.join("")).toBe(0);
    const applied = captureIo(root);

    const code = await main(["apply", "saved.json", "--write", "--json"], applied.io);

    expect(code, applied.stderr.join("")).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(root, "saved.json"), "utf8")).toContain('"search": "old"');
  });

  it("persists canonical Git scope and blob identities and automatically reuses the saved scope", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.txt"), "old changed\n", "utf8");
    await writeFile(join(root, "unchanged.txt"), "old unchanged\n", "utf8");
    const head = await commit(root, "scope baseline");
    await writeFile(join(root, "changed.txt"), "old changed again\n", "utf8");
    const planned = captureIo(root);

    expect(await main([
      "--search", "old",
      "--replace", "new",
      "--changed-only",
      "--plan-out", "saved.json",
      "--json",
      ".",
    ], planned.io), planned.stderr.join("")).toBe(0);
    const saved = JSON.parse(await readFile(join(root, "saved.json"), "utf8")) as {
      gitScope: {
        repositoryRoot: string;
        head: string;
        mode: string;
        dirty: boolean;
        inputs: Array<{ path: string; worktreeBlob: string; indexBlob?: string }>;
      };
    };
    expect(saved.gitScope).toMatchObject({ repositoryRoot: root, head, mode: "changed", dirty: true });
    expect(saved.gitScope.inputs).toEqual([
      expect.objectContaining({ path: "changed.txt", worktreeBlob: expect.stringMatching(/^[0-9a-f]{40,64}$/u) }),
    ]);
    expect(saved.gitScope.inputs[0]?.indexBlob).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(saved.gitScope.inputs[0]?.indexBlob).not.toBe(saved.gitScope.inputs[0]?.worktreeBlob);

    const applied = captureIo(root);
    expect(await main(["apply", "saved.json", "--write", "--json"], applied.io), applied.stderr.join(""))
      .toBe(0);
    expect(await readFile(join(root, "changed.txt"), "utf8")).toBe("new changed again\n");
    expect(await readFile(join(root, "unchanged.txt"), "utf8")).toBe("old unchanged\n");
    const transactionName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const transaction = JSON.parse(await readFile(join(root, ".tfs-ripast", "transactions", transactionName!), "utf8"));
    expect(transaction.gitScope).toEqual(saved.gitScope);
  });

  it("rechecks require-clean after approval and before the first source write", async () => {
    const root = await repository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await commit(root, "clean baseline");
    const capture = captureIo(root);
    capture.io.isTTY = true;
    capture.io.confirm = async () => {
      await writeFile(join(root, "unrelated.txt"), "became dirty during approval\n", "utf8");
      return true;
    };

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--require-clean",
      "input.txt",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/dirty|clean|changed/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("does not treat its own transaction lock as require-clean drift", async () => {
    const root = await repository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await commit(root, "clean baseline");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--require-clean",
      "--write",
      "input.txt",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });
});
