import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RewriteOperation } from "../../src/types.js";
import { AstGrepProvider } from "../../src/providers/astGrep.js";

const fakeAstGrep = join(process.cwd(), "tests/fixtures/bin/fake-ast-grep");
const realAstGrep = process.env.AST_GREP_BIN ?? "ast-grep";
const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "tfs-ripast-ast-"));
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

const structuralOperation = (): RewriteOperation => ({
  id: "rename-call",
  paths: ["src"],
  search: "foo($ARG)",
  replace: "newCall(${ARG})",
  lexical: { type: "literal" },
  globs: ["*.ts"],
});

const readInvocations = async (path: string): Promise<string[][]> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

describe("AstGrepProvider", () => {
  it("kills an override provider's background descendant when its scan times out", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const marker = join(directory, "ast-grep-descendant-survived");
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
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
      operation: structuralOperation(),
      languageDecisions: { "src/app.ts": { language: "typescript", source: "extension" } },
    })).rejects.toMatchObject({ code: "ast-grep-timeout" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 5_000);

  it("groups paths by language with exact read-only argv", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const log = join(directory, "invocations.jsonl");
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
      env: {
        ...process.env,
        FAKE_PROVIDER_LOG: log,
        FAKE_PROVIDER_MODE: "no-matches",
      },
    });

    await provider.scan({
      root: directory,
      operation: { ...structuralOperation(), globs: undefined },
      languageDecisions: {
        "src/z.ts": { language: "typescript", source: "extension" },
        "src/a.ts": { language: "typescript", source: "override" },
        "src/tool.py": { language: "python", source: "extension" },
      },
    });

    const invocations = await readInvocations(log);
    expect(invocations).toEqual([
      ["--version"],
      [
        "run",
        "--json=stream",
        "--pattern",
        "foo($ARG)",
        "--lang",
        "python",
        "--globs",
        "!.git",
        "--globs",
        "!.git/**",
        "--globs",
        "!.tfs-ripast",
        "--globs",
        "!.tfs-ripast/**",
        "--",
        "src/tool.py",
      ],
      [
        "run",
        "--json=stream",
        "--pattern",
        "foo($ARG)",
        "--lang",
        "typescript",
        "--globs",
        "!.git",
        "--globs",
        "!.git/**",
        "--globs",
        "!.tfs-ripast",
        "--globs",
        "!.tfs-ripast/**",
        "--",
        "src/a.ts",
        "src/z.ts",
      ],
    ]);
    expect(invocations.flat()).not.toContain("--rewrite");
    expect(invocations.flat()).not.toContain("--update-all");
    expect(invocations.flat()).not.toContain("--interactive");
    expect(invocations.flat()).not.toContain("newCall(${ARG})");
  });

  it("parses structural ranges and captures with stable provenance", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new AstGrepProvider({ executable: fakeAstGrep });

    const result = await provider.scan({
      root: directory,
      operation: { ...structuralOperation(), globs: undefined },
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "override" },
      },
    });

    expect(result.provider).toBe("ast-grep");
    expect(result.operationId).toBe("rename-call");
    expect(result.version).toBe("ast-grep 0.45.1");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      operationId: "rename-call",
      provider: "ast-grep",
      file: "src/app.ts",
      byteRange: [14, 22],
      lineRange: [1, 1],
      language: "typescript",
      languageSource: "override",
      captures: { ARG: "bar" },
      confidence: "structural",
    });
    expect(result.evidence[0]?.id).toMatch(/^evidence:[a-f0-9]{64}$/);
    expect(result.evidence[0]?.matchedTextHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an ast-grep binary that is not exactly 0.45.1", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_AST_GREP_VERSION: "ast-grep 0.45.0" },
    });

    await expect(provider.scan({
      root: directory,
      operation: structuralOperation(),
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    })).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ast-grep-version-unsupported",
      operationId: "rename-call",
      paths: ["src"],
    });
  });

  it("reports unsupported languages and parse failures without erasing lexical evidence", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const unsupported = await new AstGrepProvider({ executable: fakeAstGrep }).scan({
      root: directory,
      operation: { ...structuralOperation(), paths: ["."], globs: undefined },
      languageDecisions: {
        "README.txt": { language: undefined, source: "unsupported" },
      },
    });
    expect(unsupported.evidence).toEqual([]);
    expect(unsupported.diagnostics).toEqual([
      {
        code: "ast-grep-unsupported-language",
        message: "No ast-grep language is available for README.txt.",
        operationId: "rename-call",
        paths: ["README.txt"],
      },
    ]);

    const failed = await new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "error" },
    }).scan({
      root: directory,
      operation: structuralOperation(),
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    });
    expect(failed.evidence).toEqual([]);
    expect(failed.diagnostics[0]).toMatchObject({
      code: "ast-grep-pattern-error",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
    expect(failed.diagnostics[0]?.message).toContain("pattern could not be parsed");
  });

  it("rejects malformed JSON output", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "malformed" },
    });

    await expect(
      provider.scan({
        root: directory,
        operation: structuralOperation(),
        languageDecisions: {
          "src/app.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ast-grep-malformed-json",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
  });

  it("reports malformed capture metadata as a structured parse failure", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "malformed-capture" },
    });

    await expect(
      provider.scan({
        root: directory,
        operation: structuralOperation(),
        languageDecisions: {
          "src/app.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ast-grep-malformed-capture",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
  });

  it("does not downgrade non-pattern execution failures to diagnostics", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const provider = new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_MODE: "scan-error" },
    });

    await expect(
      provider.scan({
        root: directory,
        operation: structuralOperation(),
        languageDecisions: {
          "src/app.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toMatchObject({
      name: "ProviderExecutionError",
      code: "ast-grep-exit",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
  });

  it("discovers a TypeScript call with the installed ast-grep binary", async () => {
    const directory = await makeTemporaryDirectory();
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/app.ts"), "const value = foo(bar);\n", "utf8");

    const result = await new AstGrepProvider({ executable: realAstGrep }).scan({
      root: directory,
      operation: structuralOperation(),
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      file: "src/app.ts",
      byteRange: [14, 22],
      language: "typescript",
      languageSource: "extension",
    });
    expect(result.version).toBe("ast-grep 0.45.1");
  });

  it("keeps tracked later-ignored targets while rejecting untracked ignored and reserved candidates", async () => {
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
    await writeFile(join(directory, "src/ignored.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, "src/normal.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/state.ts"), "foo(bar);\n", "utf8");

    const result = await new AstGrepProvider({ executable: realAstGrep }).scan({
      root: directory,
      operation: { ...structuralOperation(), paths: ["."] },
      languageDecisions: {
        "src/tracked.ts": { language: "typescript", source: "extension" },
        "src/ignored.ts": { language: "typescript", source: "extension" },
        "src/normal.ts": { language: "typescript", source: "extension" },
        ".tfs-ripast/state.ts": { language: "typescript", source: "extension" },
      },
    });

    expect(result.evidence.map((evidence) => evidence.file)).toEqual([
      "src/normal.ts",
      "src/tracked.ts",
    ]);
    expect(result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      paths: diagnostic.paths,
    }))).toEqual([
      { code: "ast-grep-git-ignored-path", paths: ["src/ignored.ts"] },
      { code: "ast-grep-reserved-path", paths: [".tfs-ripast/state.ts"] },
    ]);
  });

  it("intersects language decisions with operation scope and rejects unexpected emitted paths", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const log = join(directory, "invocations.jsonl");
    const outside = await new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_LOG: log, FAKE_PROVIDER_MODE: "no-matches" },
    }).scan({
      root: directory,
      operation: { ...structuralOperation(), globs: undefined },
      languageDecisions: {
        "other/app.ts": { language: "typescript", source: "extension" },
      },
    });
    expect(outside.evidence).toEqual([]);
    expect(outside.diagnostics).toEqual([
      {
        code: "ast-grep-path-outside-operation",
        message: "ast-grep target other/app.ts is outside operation rename-call paths.",
        operationId: "rename-call",
        language: "typescript",
        paths: ["other/app.ts"],
      },
    ]);
    expect(await readInvocations(log)).toEqual([["--version"]]);

    const unexpected = await new AstGrepProvider({ executable: fakeAstGrep }).scan({
      root: directory,
      operation: structuralOperation(),
      languageDecisions: {
        "src/other.ts": { language: "typescript", source: "extension" },
      },
    });
    expect(unexpected.evidence).toEqual([]);
    expect(unexpected.diagnostics[0]).toMatchObject({
      code: "ast-grep-unexpected-evidence-path",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
  });

  it("rejects operation language mismatches before ast-grep invocation", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const log = join(directory, "invocations.jsonl");
    const result = await new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_LOG: log },
    }).scan({
      root: directory,
      operation: { ...structuralOperation(), languages: ["python"] },
      languageDecisions: {
        "src/app.ts": { language: "typescript", source: "extension" },
      },
    });

    expect(result.evidence).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "ast-grep-language-outside-operation",
      operationId: "rename-call",
      language: "typescript",
      paths: ["src/app.ts"],
    });
    expect(await readInvocations(log)).toEqual([["--version"]]);
  });

  it("rejects explicit ignored and reserved operands before real ast-grep scans", async () => {
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, ".tfs-ripast"));
    await writeFile(join(directory, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(join(directory, "ignored.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/state.ts"), "foo(bar);\n", "utf8");
    const provider = new AstGrepProvider({ executable: realAstGrep });

    await expect(
      provider.scan({
        root: directory,
        operation: { ...structuralOperation(), paths: ["ignored.ts"] },
        languageDecisions: {
          "ignored.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toThrow(/ignored.*ignored\.ts/i);
    await expect(
      provider.scan({
        root: directory,
        operation: { ...structuralOperation(), paths: [".tfs-ripast/state.ts"] },
        languageDecisions: {
          ".tfs-ripast/state.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toThrow(/reserved.*\.tfs-ripast/i);
  });

  it("rejects an in-root ast-grep target symlink that escapes the root", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    await mkdir(join(directory, "src"));
    await writeFile(join(outside, "app.ts"), "foo(bar);\n", "utf8");
    await symlink(join(outside, "app.ts"), join(directory, "src/app.ts"));

    await expect(
      new AstGrepProvider({ executable: fakeAstGrep }).scan({
        root: directory,
        operation: { ...structuralOperation(), paths: ["."] },
        languageDecisions: {
          "src/app.ts": { language: "typescript", source: "extension" },
        },
      }),
    ).rejects.toThrow(/outside the repository.*src\/app\.ts/i);
  });

  it("rejects alias targets that are reserved, ignored, or outside operation scope before scan", async () => {
    await chmod(fakeAstGrep, 0o755);
    const directory = await makeTemporaryDirectory();
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "ignored"));
    await mkdir(join(directory, "other"));
    await mkdir(join(directory, ".tfs-ripast"));
    await writeFile(join(directory, ".gitignore"), "ignored/\n", "utf8");
    await writeFile(join(directory, "ignored/real.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, "other/real.ts"), "foo(bar);\n", "utf8");
    await writeFile(join(directory, ".tfs-ripast/real.ts"), "foo(bar);\n", "utf8");
    await symlink("../ignored/real.ts", join(directory, "src/ignored.ts"));
    await symlink("../other/real.ts", join(directory, "src/outside.ts"));
    await symlink("../.tfs-ripast/real.ts", join(directory, "src/reserved.ts"));
    const log = join(directory, "invocations.jsonl");

    const result = await new AstGrepProvider({
      executable: fakeAstGrep,
      env: { ...process.env, FAKE_PROVIDER_LOG: log, FAKE_PROVIDER_MODE: "no-matches" },
    }).scan({
      root: directory,
      operation: structuralOperation(),
      languageDecisions: {
        "src/ignored.ts": { language: "typescript", source: "extension" },
        "src/outside.ts": { language: "typescript", source: "extension" },
        "src/reserved.ts": { language: "typescript", source: "extension" },
      },
    });

    expect(result.evidence).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      paths: diagnostic.paths,
    }))).toEqual([
      {
        code: "ast-grep-git-ignored-identity",
        paths: ["src/ignored.ts", "ignored/real.ts"],
      },
      {
        code: "ast-grep-identity-outside-operation",
        paths: ["src/outside.ts", "other/real.ts"],
      },
      {
        code: "ast-grep-reserved-identity",
        paths: ["src/reserved.ts", ".tfs-ripast/real.ts"],
      },
    ]);
    expect(await readInvocations(log)).toEqual([["--version"]]);
  });
});
