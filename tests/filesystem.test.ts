import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPreview } from "../src/diff.js";
import { snapshotTargets } from "../src/filesystem.js";
import type { FileSnapshot } from "../src/planner.js";
import type { EditPlan } from "../src/types.js";

const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-filesystem-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function hash(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function previewPlan(root: string, snapshot: FileSnapshot): EditPlan {
  const oldText = Buffer.from(snapshot.content).toString("utf8");
  const target = "line 6";
  const start = Buffer.byteLength(oldText.slice(0, oldText.indexOf(target)));
  return {
    version: 1,
    id: "edit-plan:preview",
    rewritePlan: {
      version: 1,
      name: "preview",
      root,
      operations: [{
        id: "rename",
        paths: [snapshot.path],
        search: target,
        replace: "replacement line with complete edit data",
        lexical: { type: "literal" },
      }],
      policy: {},
      validations: [],
    },
    rewritePlanHash: "sha256:rewrite",
    inputFiles: [{
      path: snapshot.path,
      hash: snapshot.hash,
      byteLength: snapshot.byteLength,
      mode: snapshot.mode,
      newline: snapshot.newline,
      encoding: snapshot.encoding,
    }],
    evidence: [{
      id: "evidence:preview",
      operationId: "rename",
      provider: "ripgrep",
      file: snapshot.path,
      byteRange: [start, start + Buffer.byteLength(target)],
      lineRange: [6, 6],
      matchedTextHash: hash(target),
      languageSource: "unsupported",
      confidence: "lexical",
    }],
    edits: [{
      id: "edit:preview",
      operationIds: ["rename"],
      file: snapshot.path,
      byteRange: [start, start + Buffer.byteLength(target)],
      replacement: "replacement line with complete edit data",
      evidenceIds: ["evidence:preview"],
    }],
    conflicts: [],
    diagnostics: [],
    providerVersions: { ripgrep: "15.2.0" },
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("snapshotTargets", () => {
  it("rejects traversal and symlinks whose targets escape the real repository root", async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(snapshotTargets(root, ["../outside.txt"])).rejects.toThrow(/contain|escape|relative/i);
    await expect(snapshotTargets(root, ["escape.txt"])).rejects.toThrow(/symlink|contain|escape/i);
  });

  it("skips binary and state files while classifying invalid UTF-8 as non-writable text", async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".tfs-ripast"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "src", "valid.txt"), "valid\n");
    await writeFile(join(root, "src", "binary.dat"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, "src", "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, ".tfs-ripast", "record.json"), "private\n");
    await writeFile(join(root, ".git", "config"), "private\n");

    const snapshots = await snapshotTargets(root, ["."]);

    expect(snapshots.map((snapshot) => snapshot.path)).toEqual([
      "src/invalid.txt",
      "src/valid.txt",
    ]);
    expect(snapshots.find((snapshot) => snapshot.path === "src/invalid.txt")?.encoding).toBe("other");
    expect(snapshots.find((snapshot) => snapshot.path === "src/valid.txt")?.encoding).toBe("utf-8");
  });

  it("captures SHA-256, executable mode, and CRLF without exposing mutable snapshot bytes", async () => {
    const root = await temporaryRepository();
    const path = join(root, "script.txt");
    const bytes = Buffer.from("first\r\nsecond\r\n");
    await writeFile(path, bytes);
    await chmod(path, 0o751);

    const [snapshot] = await snapshotTargets(root, ["script.txt"]);
    expect(snapshot).toMatchObject({
      path: "script.txt",
      hash: hash(bytes),
      byteLength: bytes.byteLength,
      mode: 0o751,
      newline: "crlf",
      encoding: "utf-8",
    });

    const exposed = snapshot?.content;
    if (exposed !== undefined) {
      exposed[0] = 0x78;
    }
    expect(Buffer.from(snapshot?.content ?? []).toString("utf8")).toBe("first\r\nsecond\r\n");
    expect(snapshot?.hash).toBe(hash(bytes));
  });

  it.each([
    ["one\ntwo\n", "lf"],
    ["one\r\ntwo\n", "mixed"],
    ["one", "none"],
  ] as const)("classifies %j as %s newlines", async (content, newline) => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), content);

    const [snapshot] = await snapshotTargets(root, ["input.txt"]);

    expect(snapshot?.newline).toBe(newline);
  });
});

describe("renderPreview", () => {
  it("renders a bounded unified diff without truncating the edit plan", async () => {
    const root = await temporaryRepository();
    const content = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\n") + "\n";
    await writeFile(join(root, "input.txt"), content);
    const [snapshot] = await snapshotTargets(root, ["input.txt"]);
    if (snapshot === undefined) {
      throw new Error("missing snapshot");
    }
    const plan = previewPlan(root, snapshot);

    const preview = renderPreview(plan, { snapshots: [snapshot], contextLines: 1, maxLines: 7, maxBytes: 320 });

    expect(preview).toContain("--- a/input.txt");
    expect(preview).toContain("+++ b/input.txt");
    expect(preview).toContain("replacement line with complete edit data");
    expect(preview).toContain("preview truncated");
    expect(preview.split("\n").length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(320);
    expect(plan.edits[0]?.replacement).toBe("replacement line with complete edit data");
  });
});
