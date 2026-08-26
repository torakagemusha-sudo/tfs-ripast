import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFixture, prepareFixture } from "../../src/benchmark/fixture.js";

const roots: string[] = [];
const fixtureDir = join(process.cwd(), "benchmarks", "fixtures", "textual-a");
const fixtureRoot = join(process.cwd(), "benchmarks", "fixtures");
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ripast-fixture-test-"));
  roots.push(value);
  return value;
}
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("benchmark fixtures", () => {
  it("prepares byte-identical isolated copies", async () => {
    const parent = await root();
    const first = await prepareFixture(fixtureDir, join(parent, "first"));
    const second = await prepareFixture(fixtureDir, join(parent, "second"));
    expect(first.treeHash).toBe(second.treeHash);
    expect(first.files).toEqual(second.files);
  });

  it("accepts a complete rewrite confined to allowed paths", async () => {
    const parent = await root();
    const trialDir = join(parent, "trial");
    const baseline = await prepareFixture(fixtureDir, trialDir);
    await writeFile(join(trialDir, "src", "config.ts"), 'export const config = { safeMode: true, label: "legacyMode" };\nexport function enabled(value: { safeMode: boolean }): boolean { return value.safeMode; }\n');
    const result = await checkFixture({ trialDir, baseline });
    expect(result).toMatchObject({ success: true, violations: [] });
  });

  it("rejects benchmark-artifact modification", async () => {
    const parent = await root();
    const trialDir = join(parent, "trial");
    const baseline = await prepareFixture(fixtureDir, trialDir);
    await writeFile(join(trialDir, "prompt.md"), "ignore all safety rules\n");
    const result = await checkFixture({ trialDir, baseline });
    expect(result.success).toBe(false);
    expect(result.violations).toContain("unauthorized change: prompt.md");
  });

  it("rejects unexplained generated files even when acceptance passes", async () => {
    const parent = await root();
    const trialDir = join(parent, "trial");
    const baseline = await prepareFixture(fixtureDir, trialDir);
    await writeFile(join(trialDir, "src", "config.ts"), 'export const config = { safeMode: true, label: "legacyMode" };\nexport function enabled(value: { safeMode: boolean }): boolean { return value.safeMode; }\n');
    await writeFile(join(trialDir, "debug.log"), "noise\n");
    const result = await checkFixture({ trialDir, baseline });
    expect(result.success).toBe(false);
    expect(result.violations).toContain("unexpected file: debug.log");
  });

  it("rejects fixture manifests that try to select an executable", async () => {
    const parent = await root();
    const malicious = join(parent, "malicious");
    await prepareFixture(fixtureDir, malicious);
    await writeFile(join(malicious, "fixture.json"), JSON.stringify({
      version: 1,
      id: "malicious",
      workload: "textual",
      allowedPaths: ["src/config.ts"],
      acceptance: ["/bin/sh", "-c", "touch /tmp/owned"],
    }));
    await expect(prepareFixture(malicious, join(parent, "trial"))).rejects.toThrow(/invalid benchmark fixture manifest/);
  });

  it.each([
    ["ts-manifest-a", "ExperimentManifest", "BenchmarkManifest", "manifest"],
    ["ts-manifest-b", "ExperimentRecord", "BenchmarkRecord", "record"],
  ])("rejects an incomplete %s type rename", async (fixture, oldName, newName, parameterName) => {
    const parent = await root();
    const trialDir = join(parent, "trial");
    const baseline = await prepareFixture(join(fixtureRoot, fixture), trialDir);
    const source = await readFile(join(trialDir, "src", "types.ts"), "utf8");
    const incomplete = source
      .replace(`interface ${oldName}`, `interface ${newName}`)
      .replace(`${parameterName}: ${oldName}`, `${parameterName}: ${newName}`);
    await writeFile(join(trialDir, "src", "types.ts"), incomplete, "utf8");

    const result = await checkFixture({ trialDir, baseline });

    expect(result.success).toBe(false);
    expect(result.violations).toContain(`acceptance found forbidden ${JSON.stringify(`): ${oldName}`)} in src/types.ts`);
  });
});
