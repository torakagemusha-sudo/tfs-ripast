import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface FileAssertion {
  path: string;
  contains: string[];
  excludes: string[];
}

export interface FixtureManifest {
  version: 1;
  id: string;
  workload: string;
  allowedPaths: string[];
  acceptance: { files: FileAssertion[] };
}

export interface FixtureBaseline {
  manifest: FixtureManifest;
  treeHash: string;
  files: Record<string, string>;
}

export interface CorrectnessResult {
  success: boolean;
  acceptanceExitCode: number;
  resultTreeHash: string;
  violations: string[];
}

async function pathsBelow(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`fixture symlinks are not allowed: ${relative(root, absolute)}`);
    if (entry.isDirectory()) paths.push(...await pathsBelow(root, absolute));
    else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join("/"));
  }
  return paths;
}

async function snapshot(root: string): Promise<{ treeHash: string; files: Record<string, string> }> {
  const tree = createHash("sha256");
  const files: Record<string, string> = {};
  for (const path of await pathsBelow(root)) {
    const bytes = await readFile(join(root, path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    files[path] = digest;
    tree.update(path).update("\0").update(bytes).update("\0");
  }
  return { treeHash: tree.digest("hex"), files };
}

function parseManifest(value: unknown): FixtureManifest {
  const manifest = value as Partial<FixtureManifest>;
  const acceptance = manifest.acceptance as { files?: unknown } | undefined;
  const assertions = acceptance?.files;
  if (manifest.version !== 1 || typeof manifest.id !== "string" || typeof manifest.workload !== "string"
    || !Array.isArray(manifest.allowedPaths) || !manifest.allowedPaths.every(validRelativePath)
    || !Array.isArray(assertions) || assertions.length === 0 || assertions.length > 100
    || !assertions.every((assertion) => {
      const item = assertion as Partial<FileAssertion>;
      return typeof assertion === "object" && assertion !== null && validRelativePath(item.path)
        && Array.isArray(item.contains) && item.contains.length <= 100 && item.contains.every((text) => typeof text === "string" && Buffer.byteLength(text) <= 16_384)
        && Array.isArray(item.excludes) && item.excludes.length <= 100 && item.excludes.every((text) => typeof text === "string" && Buffer.byteLength(text) <= 16_384);
    })) {
    throw new Error("invalid benchmark fixture manifest");
  }
  return manifest as FixtureManifest;
}

function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4_096
    && !isAbsolute(value) && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export async function prepareFixture(fixtureDir: string, destination: string): Promise<FixtureBaseline> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(fixtureDir, destination, { recursive: true, errorOnExist: true, force: false });
  const manifest = parseManifest(JSON.parse(await readFile(join(destination, "fixture.json"), "utf8")));
  return { manifest, ...await snapshot(destination) };
}

export async function checkFixture(options: {
  trialDir: string;
  baseline: FixtureBaseline;
}): Promise<CorrectnessResult> {
  const current = await snapshot(options.trialDir);
  const violations: string[] = [];
  const allowed = new Set(options.baseline.manifest.allowedPaths);
  for (const path of Object.keys(current.files)) {
    if (!(path in options.baseline.files)) violations.push(`unexpected file: ${path}`);
    else if (current.files[path] !== options.baseline.files[path] && !allowed.has(path)) violations.push(`unauthorized change: ${path}`);
  }
  for (const path of Object.keys(options.baseline.files)) {
    if (!(path in current.files)) violations.push(`deleted file: ${path}`);
  }
  for (const assertion of options.baseline.manifest.acceptance.files) {
    const text = await readFile(join(options.trialDir, assertion.path), "utf8");
    for (const required of assertion.contains) if (!text.includes(required)) violations.push(`acceptance missing ${JSON.stringify(required)} in ${assertion.path}`);
    for (const forbidden of assertion.excludes) if (text.includes(forbidden)) violations.push(`acceptance found forbidden ${JSON.stringify(forbidden)} in ${assertion.path}`);
  }
  const acceptanceExitCode = violations.some((violation) => violation.startsWith("acceptance ")) ? 1 : 0;
  return {
    success: violations.length === 0,
    acceptanceExitCode,
    resultTreeHash: current.treeHash,
    violations,
  };
}
