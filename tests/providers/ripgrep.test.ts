import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RewriteOperation } from "../../src/types.js";
import { runArgumentVector } from "../../src/providers/process.js";
import { RipgrepProvider } from "../../src/providers/ripgrep.js";

const fakeRipgrep = join(process.cwd(), "tests/fixtures/bin/fake-rg");
const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "tfs-ripast-rg-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const literalOperation = (): RewriteOperation => ({
  id: "rename-call",
  paths: ["src"],
  search: "foo(bar)",
  replace: "newCall()",
  lexical: { type: "literal" },
  globs: ["*.ts"],
});

const readInvocations = async (path: string): Promise<string[][]> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

describe("runArgumentVector", () => {
  it("times out by terminating the spawned process", async () => {
    await chmod(fakeRipgrep, 0o755);
    const result = await runArgumentVector(fakeRipgrep, [], {
      cwd: process.cwd(),
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      env: { ...process.env, FAKE_PROVIDER_MODE: "timeout" },
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("bounds captured output without retaining the excess", async () => {
    await chmod(fakeRipgrep, 0o755);
    const result = await runArgumentVector(fakeRipgrep, [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 64,
      env: { ...process.env, FAKE_PROVIDER_MODE: "overflow" },
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
  });

  it("rejects an oversized argument vector before spawning", async () => {
    await chmod(fakeRipgrep, 0o755);
    await expect(
      runArgumentVector(fakeRipgrep, ["x".repeat(128)], {
        cwd: process.cwd(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxArgumentBytes: 64,
      }),
    ).rejects.toThrow(/argument vector.*64 bytes/i);
  });

  it("settles after bounded escalation when a child ignores SIGTERM and a descendant holds pipes", async () => {
    await chmod(fakeRipgrep, 0o755);
    const startedAt = performance.now();
    const result = await runArgumentVector(fakeRipgrep, [], {
      cwd: process.cwd(),
      timeoutMs: 250,
      maxOutputBytes: 1_024,
      killGraceMs: 40,
      env: { ...process.env, FAKE_PROVIDER_MODE: "stubborn" },
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(performance.now() - startedAt).toBeLessThan(700);
  });

  it("detects adversarial invalid UTF-8 near the output limit in linear bounded time", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(join(directory, "invalid-output.mjs"), [
      "const bytes = Buffer.alloc(64 * 1024, 0x61);",
      "bytes[0] = 0xff;",
      "process.stdout.write(bytes);",
    ].join("\n"), "utf8");
    const startedAt = performance.now();

    const result = await runArgumentVector(process.execPath, ["invalid-output.mjs"], {
      cwd: directory,
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });

    expect(result).toMatchObject({ exitCode: 0, truncated: false, invalidUtf8: true });
    expect(result.stdout).toBe("");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("preserves a valid leading UTF-8 BOM in exact runner output", async () => {
    const directory = await makeTemporaryDirectory();
    const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("source\n", "utf8")]);
    await writeFile(join(directory, "bom-output.mjs"), [
      "const { stdout } = process;",
      "stdout.write(Buffer.from([0xef, 0xbb, 0xbf]));",
      "stdout.write('source\\n');",
    ].join("\n"), "utf8");

    const result = await runArgumentVector(process.execPath, ["bom-output.mjs"], {
      cwd: directory,
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });

    expect(result).toMatchObject({ exitCode: 0, truncated: false, invalidUtf8: false });
    expect(Buffer.from(result.stdout, "utf8")).toEqual(expected);
  });
});

describe("RipgrepProvider", () => {
  it("kills an override provider's background descendant when its scan times out", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const marker = join(directory, "ripgrep-descendant-survived");
    const provider = new RipgrepProvider({
      executable: fakeRipgrep,
      timeoutMs: 500,
      env: {
        ...process.env,
        FAKE_PROVIDER_MODE: "stubborn",
        FAKE_PROVIDER_MARKER: marker,
        FAKE_PROVIDER_MARKER_DELAY: "1000",
      },
    });

    await expect(provider.scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {},
    })).rejects.toMatchObject({ code: "ripgrep-timeout" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 5_000);

  it("uses an exact read-only argv and converts ripgrep JSON byte spans", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const log = join(directory, "invocations.jsonl");
    const provider = new RipgrepProvider({
      executable: fakeRipgrep,
      env: { ...process.env, FAKE_PROVIDER_LOG: log },
    });

    const result = await provider.scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "override" },
      },
    });

    const invocations = await readInvocations(log);
    expect(invocations).toEqual([
      ["--version"],
      [
        "--json",
        "--hidden",
        "--glob",
        "!.git",
        "--glob",
        "!.git/**",
        "--glob",
        "!.tfs-ripast",
        "--glob",
        "!.tfs-ripast/**",
        "--text",
        "--no-ignore-vcs",
        "--fixed-strings",
        "-e",
        "foo(bar)",
        "--",
        "src",
      ],
    ]);
    expect(invocations.flat()).not.toContain("--replace");
    expect(invocations.flat()).not.toContain("newCall()");
    expect(result.provider).toBe("ripgrep");
    expect(result.operationId).toBe("rename-call");
    expect(result.version).toBe("ripgrep 99.0.0 (fake)");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      operationId: "rename-call",
      provider: "ripgrep",
      file: "src/app.ts",
      byteRange: [13, 21],
      lineRange: [4, 4],
      language: "typescript",
      languageSource: "override",
      confidence: "lexical",
    });
    expect(result.evidence[0]?.id).toMatch(/^evidence:[a-f0-9]{64}$/);
    expect(result.evidence[0]?.matchedTextHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const repeated = await provider.scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "override" },
      },
    });
    expect(repeated.evidence[0]?.id).toBe(result.evidence[0]?.id);
  });

  it("preserves ripgrep exit 1 as an empty successful scan", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new RipgrepProvider({
      executable: fakeRipgrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "no-matches" },
    });

    const result = await provider.scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {},
    });

    expect(result.evidence).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.operationId).toBe("rename-call");
  });

  it("rejects malformed JSON and exit codes greater than one", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const scan = (mode: string) =>
      new RipgrepProvider({
        executable: fakeRipgrep,
        env: { ...process.env, FAKE_PROVIDER_MODE: mode },
      }).scan({ root: directory, operation: literalOperation(), languageDecisions: {} });

    await expect(scan("malformed")).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ripgrep-malformed-json",
      operationId: "rename-call",
      paths: ["src"],
    });
    await expect(scan("error")).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ripgrep-exit",
      operationId: "rename-call",
      paths: ["src"],
    });
  });

  it("discovers a real TypeScript call while honoring Git ignores", async () => {
    const directory = await makeTemporaryDirectory();
    await mkdir(join(directory, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, ".tfs-ripast"), { recursive: true });
    await writeFile(join(directory, ".gitignore"), "src/ignored.ts\n", "utf8");
    await writeFile(join(directory, "src/app.ts"), "const value = foo(bar);\n", "utf8");
    await writeFile(join(directory, "src/app.js"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, "src/ignored.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/state.ts"), "foo(bar);\n", "utf8");

    const result = await new RipgrepProvider({ executable: "rg" }).scan({
      root: directory,
      operation: { ...literalOperation(), paths: ["."] },
      languageDecisions: {},
    });

    expect(result.evidence.map((evidence) => evidence.file)).toEqual(["src/app.ts"]);
    expect(result.version).toMatch(/^ripgrep \d+\.\d+\.\d+/);
  });

  it("rejects explicit ignored and reserved operands before real ripgrep scans", async () => {
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, ".tfs-ripast"), { recursive: true });
    await writeFile(join(directory, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(join(directory, "ignored.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/state.ts"), "foo(bar);\n", "utf8");
    const provider = new RipgrepProvider({ executable: "rg" });

    await expect(
      provider.scan({
        root: directory,
        operation: { ...literalOperation(), paths: ["ignored.ts"] },
        languageDecisions: {},
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "provider-git-ignored-operation-path",
      operationId: "rename-call",
      paths: ["ignored.ts"],
    });
    await expect(
      provider.scan({
        root: directory,
        operation: { ...literalOperation(), paths: [".tfs-ripast/state.ts"] },
        languageDecisions: {},
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "provider-reserved-operation-path",
      operationId: "rename-call",
      paths: [".tfs-ripast/state.ts"],
    });

    const optedOut = await provider.scan({
      root: directory,
      operation: { ...literalOperation(), paths: ["ignored.ts"] },
      languageDecisions: {},
      respectGitIgnore: false,
    });
    expect(optedOut.evidence.map((evidence) => evidence.file)).toEqual(["ignored.ts"]);
  });

  it("keeps a tracked file eligible when a later ignore rule matches it", async () => {
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "tracked.ts"), "foo(bar);\n", "utf8");
    execFileSync("git", ["add", "tracked.ts"], { cwd: directory });
    await writeFile(join(directory, ".gitignore"), "tracked.ts\n", "utf8");

    const result = await new RipgrepProvider({ executable: "rg" }).scan({
      root: directory,
      operation: { ...literalOperation(), paths: ["tracked.ts"] },
      languageDecisions: {},
    });

    expect(result.evidence.map((evidence) => evidence.file)).toEqual(["tracked.ts"]);
  });

  it("keeps tracked later-ignored files in directory scans while excluding untracked ignored and reserved files", async () => {
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, ".tfs-ripast"));
    await writeFile(join(directory, "src/tracked.ts"), "foo(bar);\n", "utf8");
    execFileSync("git", ["add", "src/tracked.ts"], { cwd: directory });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "track fixture"],
      { cwd: directory },
    );
    await writeFile(
      join(directory, ".gitignore"),
      "src/tracked.ts\nsrc/ignored.ts\n",
      "utf8",
    );
    await writeFile(join(directory, ".ignore"), "src/local-ignore.ts\n", "utf8");
    await writeFile(join(directory, "src/ignored.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, "src/local-ignore.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, "src/normal.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/state.ts"), "foo(bar);\n", "utf8");

    const result = await new RipgrepProvider({ executable: "rg" }).scan({
      root: directory,
      operation: { ...literalOperation(), paths: ["."] },
      languageDecisions: {},
    });

    expect(result.evidence.map((evidence) => evidence.file)).toEqual([
      "src/normal.ts",
      "src/tracked.ts",
    ]);
  });

  it("rejects a visible symlink operand whose in-root target is Git-ignored", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "ignored"));
    await writeFile(join(directory, ".gitignore"), "ignored/\n", "utf8");
    await writeFile(join(directory, "ignored/real.ts"), "foo(bar);\n", "utf8");
    await symlink("../ignored/real.ts", join(directory, "src/alias.ts"));
    const log = join(directory, "invocations.jsonl");

    await expect(
      new RipgrepProvider({
        executable: fakeRipgrep,
        env: { ...process.env, FAKE_PROVIDER_LOG: log },
      }).scan({
        root: directory,
        operation: { ...literalOperation(), paths: ["src/alias.ts"] },
        languageDecisions: {
          "src/alias.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "provider-git-ignored-operation-identity",
      operationId: "rename-call",
      paths: ["src/alias.ts", "ignored/real.ts"],
    });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies operation globs and languages to emitted alias and target identity", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/real.js"), "foo(bar);\n", "utf8");
    await symlink("real.js", join(directory, "src/app.ts"));

    const result = await new RipgrepProvider({ executable: fakeRipgrep }).scan({
      root: directory,
      operation: { ...literalOperation(), paths: ["src"], languages: ["typescript"] },
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    });

    expect(result.evidence).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "ripgrep-identity-outside-globs",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts", "src/real.js"],
    });
  });

  it("rejects escaping symlink operands and emitted evidence by real identity", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    await writeFile(join(outside, "app.ts"), "foo(bar);\n", "utf8");
    await symlink(outside, join(directory, "src"), "dir");

    await expect(
      new RipgrepProvider({ executable: fakeRipgrep }).scan({
        root: directory,
        operation: literalOperation(),
        languageDecisions: {},
      }),
    ).rejects.toThrow(/outside the repository.*src/i);

    await rm(join(directory, "src"));
    await mkdir(join(directory, "src"));
    await symlink(join(outside, "app.ts"), join(directory, "src/app.ts"));
    await expect(
      new RipgrepProvider({ executable: fakeRipgrep }).scan({
        root: directory,
        operation: { ...literalOperation(), paths: ["."] },
        languageDecisions: {},
      }),
    ).rejects.toThrow(/outside the repository.*src\/app\.ts/i);
  });

  it("rejects evidence outside operation paths and allowed languages with structured diagnostics", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const outsideScope = await new RipgrepProvider({
      executable: fakeRipgrep,
      env: { ...process.env, FAKE_PROVIDER_PATH: "other/app.ts" },
    }).scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {
        "other/app.ts": { language: "typescript", source: "extension" },
      },
    });
    expect(outsideScope.evidence).toEqual([]);
    expect(outsideScope.diagnostics).toEqual([
      {
        code: "ripgrep-path-outside-operation",
        message: "ripgrep reported other/app.ts outside operation rename-call paths.",
        operationId: "rename-call",
        language: "typescript",
        paths: ["other/app.ts"],
      },
    ]);

    const wrongLanguage = await new RipgrepProvider({ executable: fakeRipgrep }).scan({
      root: directory,
      operation: { ...literalOperation(), languages: ["python"] },
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    });
    expect(wrongLanguage.evidence).toEqual([]);
    expect(wrongLanguage.diagnostics[0]).toMatchObject({
      code: "ripgrep-language-outside-operation",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
  });

  it("parses base64 JSON fields and diagnoses unrepresentable path bytes", async () => {
    await chmod(fakeRipgrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const binary = await new RipgrepProvider({
      executable: fakeRipgrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "bytes" },
    }).scan({ root: directory, operation: literalOperation(), languageDecisions: {} });

    expect(binary.evidence[0]).toMatchObject({
      file: "src/app.ts",
      byteRange: [2, 10],
      matchedTextHash: "sha256:3a448835449030d2fdc65f44f50cbb340c7b9d5ee1d8232b269e46ebce327941",
    });
    expect(binary.diagnostics[0]).toMatchObject({
      code: "ripgrep-non-utf8-content",
      operationId: "rename-call",
      paths: ["src/app.ts"],
    });

    const badPath = await new RipgrepProvider({
      executable: fakeRipgrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "path-bytes" },
    }).scan({ root: directory, operation: literalOperation(), languageDecisions: {} });
    expect(badPath.evidence).toEqual([]);
    expect(badPath.diagnostics).toEqual([
      {
        code: "ripgrep-unrepresentable-path",
        message: "ripgrep reported a path that is not valid UTF-8.",
        operationId: "rename-call",
        paths: [],
      },
    ]);
  });

  it("discovers and marks real invalid-UTF8 content as non-writable", async () => {
    const directory = await makeTemporaryDirectory();
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "src/invalid.ts"),
      Buffer.from([0xff, 0x20, ...Buffer.from("foo(bar)\n")]),
    );

    const result = await new RipgrepProvider({ executable: "rg" }).scan({
      root: directory,
      operation: literalOperation(),
      languageDecisions: {},
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ file: "src/invalid.ts", byteRange: [2, 10] });
    expect(result.diagnostics[0]).toMatchObject({
      code: "ripgrep-non-utf8-content",
      operationId: "rename-call",
      paths: ["src/invalid.ts"],
    });
  });
});
