import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli.js";
import { parseRewritePlan, parseTransactionRecord } from "../src/schema.js";
import {
  resolveValidationInvocations,
  runPreparedValidations,
  runValidations,
} from "../src/validation.js";
import { assertProcessContainmentSupported, runArgumentVector } from "../src/providers/process.js";
import type { AstGrepLanguage, RewritePlan, TrustedValidationCommand, ValidationSpec } from "../src/types.js";

const temporaryRoots: string[] = [];
const execute = promisify(execFile);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-validation-"));
  temporaryRoots.push(root);
  return root;
}

async function executableFixture(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function trusted(overrides: Partial<TrustedValidationCommand> = {}): TrustedValidationCommand {
  return {
    executable: process.execPath,
    args: ["check.mjs"],
    cwd: ".",
    timeoutMs: 1_000,
    maxOutputBytes: 8_192,
    ...overrides,
  };
}

function captureIo(root: string, options: { isTTY?: boolean; confirm?: () => Promise<boolean> } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isTTY: options.isTTY ?? false,
    confirm: options.confirm ?? (async () => false),
    cwd: root,
  };
  return { io, stdout, stderr };
}

async function writePlan(root: string, plan: RewritePlan): Promise<string> {
  const path = join(root, "plan.json");
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return path;
}

function validationPlan(root: string, validation: ValidationSpec, keepOnCheckFailure = false): RewritePlan {
  return {
    version: 1,
    name: "validation integration",
    root,
    operations: [{
      id: "rename",
      paths: ["input.txt"],
      search: "old",
      replace: "new",
      lexical: { type: "literal" },
      matchPolicy: { onUnparseable: "allow" },
    }],
    policy: keepOnCheckFailure ? { keepOnCheckFailure: true } : {},
    validations: [validation],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validation invocation authority", () => {
  it("resolves named adapters to exact argument vectors and executes with a contained cwd", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "project"));
    const npm = await executableFixture(root, "fake-npm", [
      "process.stdout.write(JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));",
    ].join("\n"));
    const specs: ValidationSpec[] = [{
      type: "npm-test",
      cwd: "project",
      timeoutMs: 1_234,
      maxOutputBytes: 4_096,
    }];

    const [invocation] = await resolveValidationInvocations(specs, {
      root,
      stage: "postcommit",
      changedPaths: [],
      executables: { "npm-test": npm },
    });
    const results = await runValidations(specs, {
      root,
      stage: "postcommit",
      changedPaths: [],
      executables: { "npm-test": npm },
    });

    expect(invocation).toMatchObject({
      source: "named-adapter",
      adapter: "npm-test",
      executable: npm,
      argv: ["test"],
      cwd: "project",
      executionCwd: join(root, "project"),
      timeoutMs: 1_234,
      rollbackPolicy: "rollback-on-failure",
      stage: "postcommit",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "named-adapter",
      adapter: "npm-test",
      executable: npm,
      argv: ["test"],
      cwd: "project",
      status: "passed",
      exitCode: 0,
    });
    expect(JSON.parse(results[0]?.output ?? "{}")).toEqual({
      argv: ["test"],
      cwd: join(root, "project"),
    });
  });

  it("rejects cwd symlink escapes before spawning", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, "outside"));

    await expect(runValidations([{ type: "npm-test", cwd: "outside" }], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/cwd|contain|escape|symlink/i);
  });

  it("bounds timeout and combined output while preserving audit status", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "slow.mjs"), "setInterval(() => {}, 1_000);\n", "utf8");
    await writeFile(join(root, "loud.mjs"), "process.stdout.write('x'.repeat(100_000));\n", "utf8");

    const timed = await runValidations([trusted({ args: ["slow.mjs"], timeoutMs: 20 })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    });
    const truncated = await runValidations([trusted({ args: ["loud.mjs"], maxOutputBytes: 64 })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    });

    expect(timed[0]).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
    expect(truncated[0]).toMatchObject({ status: "failed", truncated: true });
    expect(Buffer.byteLength(truncated[0]?.output ?? "")).toBeLessThanOrEqual(64);
  });

  it("rejects an oversized argument vector at the validation authority boundary", async () => {
    const root = await temporaryRoot();

    await expect(runValidations([trusted({ args: ["x".repeat(140 * 1024)] })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/argument.*bytes.*limit/i);
  });

  it("bounds repeated spawn-error audits and rejects oversized persisted invocation fields", async () => {
    const root = await temporaryRoot();
    const missing = join(root, `missing-${"x".repeat(180)}`);
    const results = await runValidations([
      { type: "npm-test", maxOutputBytes: 32 },
      { type: "typescript-typecheck", maxOutputBytes: 32 },
    ], {
      root,
      stage: "postcommit",
      changedPaths: [],
      executables: { "npm-test": missing, "typescript-typecheck": missing },
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("spawn-error");
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32);
    }
    await expect(runValidations([trusted({ executable: `/${"x".repeat(5_000)}` })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/executable.*limit|executable.*bytes/i);
    await expect(runValidations([trusted({ args: ["x".repeat(17 * 1024)] })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/argument.*limit|argument.*bytes/i);
  });

  it("turns invalid UTF-8 validator output into a nonempty bounded failed audit", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "invalid-output.mjs"), [
      "const bytes = Buffer.alloc(8 * 1024, 0x61);",
      "bytes[0] = 0xff;",
      "process.stdout.write(bytes);",
    ].join("\n"), "utf8");

    const [result] = await runValidations([trusted({ args: ["invalid-output.mjs"], maxOutputBytes: 8 * 1024 })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    });

    expect(result).toMatchObject({ status: "failed", truncated: false });
    expect(result?.output).toMatch(/invalid.*utf-?8/i);
    expect(Buffer.byteLength(result?.output ?? "")).toBeLessThanOrEqual(8 * 1024);
  });

  it("rejects shell executables and command-string expansion even though process spawning uses shell false", async () => {
    const root = await temporaryRoot();
    await symlink("/bin/sh", join(root, "validator"));

    await expect(runValidations([trusted({ executable: "/bin/sh", args: ["-c", "printf owned"] })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/shell|executable|authority/i);
    await expect(runValidations([trusted({ args: ["-c", "print('owned')"] })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/-c|command string|expansion|authority/i);
    await expect(runValidations([trusted({ executable: "./validator", args: ["check.mjs"] })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    })).rejects.toThrow(/shell|executable|authority/i);
    expect(() => parseRewritePlan({
      version: 1,
      name: "untrusted command",
      root: ".",
      operations: [],
      policy: {},
      validations: [{ type: "command", executable: "node", args: ["check.mjs"] }],
    })).toThrow();
  });

  it("requires absolute native executables and rejects symlinked shells, shebang wrappers, env, and combined shell flags", async () => {
    const root = await temporaryRoot();
    await symlink("/bin/sh", join(root, "path-validator"));
    const wrapper = join(root, "wrapper");
    await writeFile(wrapper, `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");
    await chmod(wrapper, 0o755);
    const context = { root, stage: "postcommit" as const, changedPaths: [], env: { ...process.env, PATH: "" } };

    await expect(runValidations([trusted({ executable: "node", args: ["check"] })], context))
      .rejects.toThrow(/absolute|executable|authority/i);
    await expect(runValidations([trusted({ executable: "./path-validator", args: ["check"] })], context))
      .rejects.toThrow(/absolute|executable|authority/i);
    await expect(runValidations([trusted({ executable: join(root, "path-validator"), args: ["check"] })], context))
      .rejects.toThrow(/shell|identity|authority/i);
    await expect(runValidations([trusted({ executable: wrapper, args: ["check"] })], context))
      .rejects.toThrow(/shell|shebang|wrapper|authority/i);
    await expect(runValidations([trusted({ executable: "/usr/bin/env", args: ["bash", "-lc", "printf owned"] })], context))
      .rejects.toThrow(/shell|env|wrapper|authority/i);
    await expect(runValidations([trusted({ executable: "/usr/bin/env", args: ["-u", "IGNORED", "bash", "-lc", "printf owned"] })], context))
      .rejects.toThrow(/shell|env|wrapper|authority/i);
    await expect(runValidations([trusted({ executable: "/usr/bin/env", args: ["-Sbash -lc", "printf owned"] })], context))
      .rejects.toThrow(/shell|env|wrapper|authority/i);
    await expect(runValidations([trusted({ executable: "/usr/bin/env", args: ["-S", "'bash -lc printf owned'"] })], context))
      .rejects.toThrow(/shell|env|wrapper|authority/i);
    await expect(runValidations([trusted({ args: ["-lc", "printf owned"] })], context))
      .rejects.toThrow(/-lc|command.string|expansion|authority/i);
  });

  it("pins a permitted explicit executable symlink to its inspected realpath identity", async () => {
    const root = await temporaryRoot();
    const alias = join(root, "node-alias");
    await symlink(process.execPath, alias);

    const [invocation] = await resolveValidationInvocations([trusted({ executable: alias })], {
      root,
      stage: "postcommit",
      changedPaths: [],
    });

    expect(invocation?.executable).toBe(await realpath(process.execPath));
  });
});

describe("bounded process trees", () => {
  it("fails closed before spawn when process-group descendant containment is unavailable on Windows", async () => {
    expect(() => assertProcessContainmentSupported("win32"))
      .toThrow(/windows|containment|unsupported|refus/i);
    if (process.platform !== "win32") {
      expect(() => assertProcessContainmentSupported()).not.toThrow();
    }
    if (process.platform === "win32") {
      await expect(runArgumentVector("C:\\definitely-missing.exe", [], {
        cwd: process.cwd(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      })).rejects.toThrow(/windows|containment|unsupported|refus/i);
    }
  });

  it("handles a closed child stdin without an unhandled EPIPE and enforces the input cap", async () => {
    const input = Buffer.alloc(16 * 1024 * 1024, 0x78);
    const result = await runArgumentVector("/bin/true", [], {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      maxInputBytes: input.byteLength,
      input,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdinError).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    await expect(runArgumentVector("/bin/true", [], {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      maxInputBytes: input.byteLength - 1,
      input,
    })).rejects.toThrow(/input.*bytes.*limit/i);
  });

  it("cleans background descendants even when the direct child exits successfully", async () => {
    if (process.platform === "win32") {
      await expect(runArgumentVector(process.execPath, ["--version"], {
        cwd: process.cwd(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      })).rejects.toThrow(/windows|containment|unsupported|refus/i);
      return;
    }
    const root = await temporaryRoot();
    const marker = join(root, "successful-parent-grandchild-survived");
    await writeFile(join(root, "background.mjs"), [
      "import { spawn } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 250)`], { stdio: 'ignore' }).unref();",
    ].join("\n"), "utf8");

    const result = await runArgumentVector(process.execPath, ["background.mjs"], {
      cwd: root,
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));

    expect(result.exitCode).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 5_000);

  it.each(["timeout", "overflow"] as const)(
    "terminates the exact POSIX process group and its background grandchild on %s",
    async (mode) => {
      if (process.platform === "win32") {
        await expect(runArgumentVector(process.execPath, ["--version"], {
          cwd: process.cwd(),
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
        })).rejects.toThrow(/windows|containment|unsupported|refus/i);
        return;
      }
      const root = await temporaryRoot();
      const marker = join(root, `${mode}-grandchild-survived`);
      await writeFile(join(root, "tree.mjs"), [
        "import { spawn } from 'node:child_process';",
        `const marker = ${JSON.stringify(marker)};`,
        "spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 250)`], { stdio: 'ignore' });",
        mode === "overflow" ? "process.stdout.write('x'.repeat(100_000));" : "setInterval(() => {}, 1000);",
      ].join("\n"), "utf8");

      const result = await runArgumentVector(process.execPath, ["tree.mjs"], {
        cwd: root,
        timeoutMs: mode === "timeout" ? 30 : 2_000,
        maxOutputBytes: mode === "overflow" ? 64 : 8_192,
        killGraceMs: 50,
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));

      expect(mode === "timeout" ? result.timedOut : result.truncated).toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    5_000,
  );

  it("kills the isolated child group when the owning parent exits", async () => {
    if (process.platform === "win32") {
      await expect(runArgumentVector(process.execPath, ["--version"], {
        cwd: process.cwd(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      })).rejects.toThrow(/windows|containment|unsupported|refus/i);
      return;
    }
    const root = await temporaryRoot();
    const marker = join(root, "parent-exit-grandchild-survived");
    await writeFile(join(root, "tree.mjs"), [
      "import { spawn } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 500)`], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    const processModule = pathToFileURL(join(process.cwd(), "src", "providers", "process.ts")).href;
    await writeFile(join(root, "owner.ts"), [
      `import { runArgumentVector } from ${JSON.stringify(processModule)};`,
      "void runArgumentVector(process.execPath, ['tree.mjs'], { cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 1024 });",
      "setTimeout(() => process.exit(0), 100);",
    ].join("\n"), "utf8");

    await execute(join(process.cwd(), "node_modules", ".bin", "vite-node"), [join(root, "owner.ts")], { cwd: root });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 5_000);
});

describe("CLI validation lifecycle", () => {
  it("keeps serialized validation adapters inert without matching CLI authority", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "validation-ran");
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const prettier = await executableFixture(root, "marker-prettier", `await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, 'ran'); for await (const chunk of process.stdin) process.stdout.write(chunk);`);
    const source = await writePlan(root, validationPlan(root, { type: "prettier", paths: ["input.txt"] }));
    const capture = captureIo(root);

    expect(await main(["plan", source, "--json"], capture.io, {
      validationExecutables: { prettier },
    })).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      planning: { validations: [{ type: "prettier" }] },
    });
    expect((JSON.parse(capture.stdout.join("")) as { planning: { validationInvocations: Array<{ adapter: string }> } }).planning.validationInvocations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ adapter: "prettier" })]));
  });
  it("distinguishes normal empty roots from missing descendants for every structural parser", async () => {
    const root = await temporaryRoot();
    const languages: AstGrepLanguage[] = [
      "javascript", "jsx", "typescript", "tsx", "python", "rust", "go", "java", "c", "cpp",
      "csharp", "ruby", "swift", "kotlin", "scala", "html", "css", "json", "yaml",
    ];

    const outcome = await runPreparedValidations([], languages.map((language, index) => ({
      path: `input-${String(index)}.txt`,
      content: Buffer.from("   \n", "utf8"),
      mode: 0o644,
      language,
    })), { root });

    expect(outcome.results).toHaveLength(languages.length * 2);
    expect(outcome.results.every((result) => result.status === "passed")).toBe(true);
  });

  it("keeps a source UTF-8 BOM byte-identical through a prepared formatter", async () => {
    const root = await temporaryRoot();
    const prettier = await executableFixture(root, "bom-prettier", [
      "for await (const chunk of process.stdin) process.stdout.write(chunk);",
    ].join("\n"));
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("plain text\n", "utf8")]);

    const outcome = await runPreparedValidations(
      [{ type: "prettier", paths: ["input.txt"] }],
      [{ path: "input.txt", content: source, mode: 0o644 }],
      { root, executables: { prettier } },
    );

    expect(outcome.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "prettier", status: "passed" }),
    ]));
    expect(Buffer.from(outcome.outputs["input.txt"]!)).toEqual(source);
  });

  it("formats prepared output before approval and previews the exact invocation without touching source", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.ts"), "const old = {value: 1};\n", "utf8");
    await writeFile(join(root, ".prettierrc.json"), JSON.stringify({ marker: "repo-policy" }), "utf8");
    const prettier = await executableFixture(root, "fake-prettier", [
      "const fs = await import('node:fs/promises');",
      "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
      "const policy = JSON.parse(await fs.readFile('.prettierrc.json', 'utf8'));",
      "const filepath = process.argv[process.argv.indexOf('--stdin-filepath') + 1];",
      "process.stderr.write(JSON.stringify({cwd: process.cwd(), filepath, policy}));",
      "process.stdout.write(Buffer.concat(chunks).toString('utf8').replace('{value: 1}', `{ value: 1 /* ${policy.marker} */ }`));",
    ].join("\n"));
    const source = await writePlan(root, {
      ...validationPlan(root, {
        type: "prettier",
        paths: ["input.ts"],
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
      operations: [{
        id: "rename",
        paths: ["input.ts"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
    });
    let previewAtApproval = "";
    const capture = captureIo(root, {
      isTTY: true,
      confirm: async () => {
        previewAtApproval = capture.stdout.join("");
        expect(await readFile(join(root, "input.ts"), "utf8")).toBe("const old = {value: 1};\n");
        return true;
      },
    });

    const code = await main(["plan", source, "--check", "prettier"], capture.io, {
      validationExecutables: { prettier },
    });

    expect(code, capture.stderr.join("")).toBe(0);
    expect(previewAtApproval).toContain("repo-policy");
    expect(previewAtApproval).toContain(`executable=${prettier}`);
    expect(previewAtApproval).toContain(`argv=[\"--stdin-filepath\",\"${join(root, "input.ts")}\"]`);
    expect(previewAtApproval).toContain(`actualCwd=${root}`);
    expect(previewAtApproval).toMatch(/config=.*original.*stdin-filepath/i);
    expect(previewAtApproval).toMatch(/stage=precommit.*rollback=not-applicable/i);
    expect(previewAtApproval).toMatch(/Git scope audit:.*root=.*mode=all/i);
    expect(previewAtApproval).toMatch(/Validation policy:.*rollback=rollback-on-failure.*authority=default/i);
    expect(await readFile(join(root, "input.ts"), "utf8")).toContain("const new = { value: 1 /* repo-policy */ }");
  });

  it("blocks invalid prepared syntax with real ast-grep before any rename even without a formatter", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "const value = old;\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", ")",
      "--lang", "typescript",
      "--write",
      "--json",
      "input.txt",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/syntax|parse|error/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("const value = old;\n");
    await expect(readdir(join(root, ".tfs-ripast", "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks prepared syntax containing tree-sitter missing nodes before any rename", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.ts"), "old\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "function f() {",
      "--write",
      "--json",
      "input.ts",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/syntax|parse|missing/i);
    expect(await readFile(join(root, "input.ts"), "utf8")).toBe("old\n");
    await expect(readdir(join(root, ".tfs-ripast", "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts valid whitespace-only prepared JavaScript without mistaking its empty root for a missing node", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.js"), "old\n", "utf8");
    const capture = captureIo(root);

    const code = await main([
      "--search", "old",
      "--replace", "   ",
      "--write",
      "--json",
      "input.js",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(await readFile(join(root, "input.js"), "utf8")).toBe("   \n");
  });

  it("persists successful syntax and unsupported-language diagnostics with validation policy on every record", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.ts"), "const old = 1;\n", "utf8");
    await writeFile(join(root, "notes.txt"), "old notes\n", "utf8");
    const capture = captureIo(root);

    expect(await main([
      "--search", "old",
      "--replace", "next",
      "--write",
      "--json",
      ".",
    ], capture.io), JSON.stringify({ stdout: capture.stdout, stderr: capture.stderr }, null, 2)).toBe(0);
    const recordName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", recordName!),
      "utf8",
    )));

    expect(record.validationPolicy).toEqual({
      keepOnCheckFailure: false,
      rollbackPolicy: "rollback-on-failure",
      authority: "default",
    });
    expect(record.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "ast-grep-syntax", stage: "precommit", status: "passed" }),
      expect.objectContaining({
        adapter: "ast-grep-syntax",
        stage: "precommit",
        status: "unsupported",
        output: expect.stringMatching(/unsupported.*notes\.txt/i),
      }),
    ]));
  });

  it("keeps disjoint changed-byte accounting stable across a no-op prepared formatter", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.ts"), `const a = old;\n${"x".repeat(2_000)}\nconst b = old;\n`, "utf8");
    const prettier = await executableFixture(root, "noop-prettier", [
      "for await (const chunk of process.stdin) process.stdout.write(chunk);",
    ].join("\n"));
    const source = await writePlan(root, {
      ...validationPlan(root, { type: "prettier", paths: ["input.ts"] }),
      policy: { maxChangedBytes: 6 },
      operations: [{
        id: "rename",
        paths: ["input.ts"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
    });
    const capture = captureIo(root);

    const code = await main(["plan", source, "--check", "prettier", "--write", "--json"], capture.io, {
      validationExecutables: { prettier },
    });

    expect(code, capture.stderr.join("")).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      planning: { changedBytes: 6, policy: { actual: { changedBytes: 6 } } },
    });
  });

  it("rolls back a committed transaction when a postcommit check fails and records its bounded audit", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const npm = await executableFixture(root, "failing-npm", "process.stderr.write('check failed'); process.exitCode = 7;");
    const source = await writePlan(root, validationPlan(root, {
      type: "npm-test",
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    }));
    const capture = captureIo(root);

    const code = await main(["plan", source, "--check", "npm-test", "--check", "typescript-typecheck", "--write", "--json"], capture.io, {
      validationExecutables: { "npm-test": npm },
    });

    expect(code).toBe(1);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    const transactionFiles = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .filter((name) => name.endsWith(".json"));
    expect(transactionFiles).toHaveLength(1);
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", transactionFiles[0]!),
      "utf8",
    )));
    expect(record.state).toBe("rolled-back");
    expect(record.validations).toEqual(expect.arrayContaining([expect.objectContaining({
      source: "named-adapter",
      adapter: "npm-test",
      executable: npm,
      argv: ["test"],
      cwd: ".",
      status: "failed",
      exitCode: 7,
      output: "check failed",
    })]));
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      outcome: "failed",
      state: "rolled-back",
      exitCode: 1,
    });
  });

  it("keeps repeated missing-adapter spawn errors inside the preflight reservation and final loader cap", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const missing = join(root, `missing-${"x".repeat(180)}`);
    const source = await writePlan(root, {
      ...validationPlan(root, { type: "npm-test", maxOutputBytes: 64 }),
      validations: [
        { type: "npm-test", maxOutputBytes: 64 },
        { type: "typescript-typecheck", maxOutputBytes: 64 },
      ],
    });
    const capture = captureIo(root);

    const code = await main([
      "plan", source,
      "--check", "npm-test",
      "--check", "typescript-typecheck",
      "--write", "--json",
    ], capture.io, {
      validationExecutables: { "npm-test": missing, "typescript-typecheck": missing },
    });

    expect(code).toBe(1);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    const recordName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const serialized = await readFile(join(root, ".tfs-ripast", "transactions", recordName!), "utf8");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8 * 1024 * 1024);
    const record = parseTransactionRecord(JSON.parse(serialized));
    const spawnErrors = record.validations.filter((result) => result.status === "spawn-error");
    expect(spawnErrors).toHaveLength(2);
    for (const result of spawnErrors) {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64);
    }
  });

  it("holds the transaction lock through postcheck and rolls back a mutating failure from authoritative siblings", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const npm = await executableFixture(root, "mutating-failure", [
      "const fs = await import('node:fs/promises');",
      "await fs.access('.tfs-ripast/lock');",
      "await fs.writeFile('input.txt', 'check mutation\\n');",
      "const transactions = await fs.readdir('.tfs-ripast/transactions');",
      "for (const transaction of transactions) {",
      "  const artifact = `.tfs-ripast/transactions/${transaction}/before/input.txt`;",
      "  try { await fs.writeFile(artifact, 'corrupt artifact\\n'); } catch {}",
      "}",
      "process.stderr.write('mutated then failed');",
      "process.exitCode = 7;",
    ].join("\n"));
    const source = await writePlan(root, validationPlan(root, { type: "npm-test" }));
    const capture = captureIo(root);

    const code = await main(["plan", source, "--check", "npm-test", "--write", "--json"], capture.io, {
      validationExecutables: { "npm-test": npm },
    });

    expect(code).toBe(1);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    const recordName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", recordName!), "utf8",
    )));
    expect(record.state).toBe("rolled-back");
    expect(record.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "npm-test", status: "failed", output: "mutated then failed" }),
    ]));
  });

  it("keeps committed files after a failed check only when the persisted policy explicitly opts in", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const npm = await executableFixture(root, "failing-npm", "process.exitCode = 9;");
    const source = await writePlan(root, validationPlan(root, { type: "npm-test" }));
    const capture = captureIo(root);

    const code = await main(["plan", source, "--check", "npm-test", "--keep-on-check-failure", "--write", "--json"], capture.io, {
      validationExecutables: { "npm-test": npm },
    });

    expect(code).toBe(1);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({ state: "committed", outcome: "failed" });
    const recordName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", recordName!), "utf8",
    )));
    expect(record.validationPolicy).toEqual({
      keepOnCheckFailure: true,
      rollbackPolicy: "keep-on-failure",
      authority: "cli-override",
    });
    expect(record.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "npm-test", rollbackPolicy: "keep-on-failure" }),
    ]));
  });

  it("audits and rolls back when a nominally passing postcommit check changes a committed target", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const npm = await executableFixture(root, "mutating-npm", [
      "const fs = await import('node:fs/promises');",
      "await fs.writeFile('input.txt', 'validation mutation\\n');",
    ].join("\n"));
    const source = await writePlan(root, validationPlan(root, { type: "npm-test" }));
    const capture = captureIo(root);

    const code = await main(["plan", source, "--check", "npm-test", "--write", "--json"], capture.io, {
      validationExecutables: { "npm-test": npm },
    });

    expect(code).toBe(1);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      state: "rolled-back",
      outcome: "failed",
      exitCode: 1,
    });
    const recordName = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .find((name) => name.endsWith(".json"));
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", recordName!), "utf8",
    )));
    expect(record.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "transaction-integrity", status: "failed" }),
    ]));
  });

  it("accepts explicit argv only from CLI authority and records the explicit-command discriminator", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await writeFile(join(root, "check.mjs"), "process.stdout.write('explicit ok');\n", "utf8");
    const capture = captureIo(root);
    const command = JSON.stringify([process.execPath, "check.mjs"]);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--validation-command", command,
      "--write",
      "--json",
      "input.txt",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    const transactionFiles = (await readdir(join(root, ".tfs-ripast", "transactions")))
      .filter((name) => name.endsWith(".json"));
    const record = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", transactionFiles[0]!),
      "utf8",
    )));
    expect(record.validations).toEqual(expect.arrayContaining([expect.objectContaining({
      source: "explicit-command",
      executable: process.execPath,
      argv: ["check.mjs"],
      output: "explicit ok",
      status: "passed",
    })]));
    expect(capture.stderr.join("")).toContain(`executable=${process.execPath}`);
    expect(capture.stderr.join("")).toContain("argv=[\"check.mjs\"]");
    expect(capture.stderr.join("")).toMatch(/stage=postcommit.*rollback=rollback-on-failure/i);
  });

  it("proves a worst-case escaped JSON audit bound before mutating sources", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await writeFile(join(root, "check.mjs"), "process.stdout.write('ok');\n", "utf8");
    const capture = captureIo(root);
    const command = JSON.stringify([process.execPath, "check.mjs", "policy\u0001quoted\""]);

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--validation-command", command,
      "--validation-command", command,
      "--write",
      "--json",
      "input.txt",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/transaction record|serialization|loader|bytes|limit/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    await expect(readdir(join(root, ".tfs-ripast", "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
