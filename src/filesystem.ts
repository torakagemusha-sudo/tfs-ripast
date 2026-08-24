import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { compareStrings } from "./order.js";
import type { FileSnapshot } from "./planner.js";

const excludedTopLevelDirectories = new Set([".git", ".tfs-ripast"]);

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function normalizeRequestedPath(path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f]/u.test(path)
  ) {
    throw new Error(`Target path must be a contained repository-relative POSIX path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Target path escapes the repository root: ${path}`);
  }
  return normalized;
}

function canonicalRelativePath(root: string, candidate: string): string {
  if (!isContained(root, candidate)) {
    throw new Error(`Target escapes the canonical repository root: ${candidate}`);
  }
  const path = relative(root, candidate).split(sep).join("/");
  return path === "" ? "." : path;
}

function isExcluded(path: string): boolean {
  const [topLevel] = path.split("/");
  return topLevel !== undefined && excludedTopLevelDirectories.has(topLevel);
}

function classifyEncoding(content: Buffer): FileSnapshot["encoding"] {
  if (content.includes(0)) {
    return "binary";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return "utf-8";
  } catch {
    return "other";
  }
}

function classifyNewline(content: Buffer): FileSnapshot["newline"] {
  let crlf = 0;
  let bareLf = 0;
  let bareCr = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0d) {
      if (content[index + 1] === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        bareCr += 1;
      }
    } else if (content[index] === 0x0a) {
      bareLf += 1;
    }
  }
  const kinds = Number(crlf > 0) + Number(bareLf > 0) + Number(bareCr > 0);
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1 || bareCr > 0) {
    return "mixed";
  }
  return crlf > 0 ? "crlf" : "lf";
}

function immutableSnapshot(
  path: string,
  content: Buffer,
  mode: number,
  encoding: FileSnapshot["encoding"],
): FileSnapshot {
  const snapshot = {
    path,
    hash: sha256(content),
    byteLength: content.byteLength,
    mode,
    newline: classifyNewline(content),
    encoding,
  } as FileSnapshot;
  Object.defineProperty(snapshot, "content", {
    enumerable: true,
    configurable: false,
    get: () => Uint8Array.from(content),
  });
  return Object.freeze(snapshot);
}

/**
 * Reads immutable snapshots through canonical parents beneath one resolved root.
 * Binary files and tool-owned state are deliberately absent from the result.
 */
export async function snapshotTargets(root: string, paths: readonly string[]): Promise<FileSnapshot[]> {
  const canonicalRoot = await realpath(resolve(root));
  const rootInfo = await stat(canonicalRoot);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Snapshot root is not a directory: ${root}`);
  }

  const snapshots = new Map<string, FileSnapshot>();
  const visitedDirectories = new Set<string>();

  const visit = async (requestedAbsolute: string): Promise<void> => {
    const requestedInfo = await lstat(requestedAbsolute);
    const canonical = await realpath(requestedAbsolute);
    if (!isContained(canonicalRoot, canonical)) {
      throw new Error(`Target symlink or canonical path escapes repository containment: ${requestedAbsolute}`);
    }
    const canonicalPath = canonicalRelativePath(canonicalRoot, canonical);
    if (canonicalPath !== "." && isExcluded(canonicalPath)) {
      return;
    }
    const info = requestedInfo.isSymbolicLink() ? await stat(canonical) : requestedInfo;
    if (info.isDirectory()) {
      if (visitedDirectories.has(canonical)) {
        return;
      }
      visitedDirectories.add(canonical);
      const directory = await opendir(canonical);
      const children: string[] = [];
      for await (const entry of directory) {
        const childPath = canonicalPath === "." ? entry.name : `${canonicalPath}/${entry.name}`;
        if (!isExcluded(childPath)) {
          children.push(resolve(canonical, entry.name));
        }
      }
      children.sort(compareStrings);
      for (const child of children) {
        await visit(child);
      }
      return;
    }
    if (!info.isFile()) {
      return;
    }

    const canonicalParent = await realpath(resolve(canonical, ".."));
    if (!isContained(canonicalRoot, canonicalParent)) {
      throw new Error(`Target real parent escapes repository containment: ${canonicalPath}`);
    }
    const before = await stat(canonical);
    const content = await readFile(canonical);
    const after = await stat(canonical);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`Target changed while it was being snapshotted: ${canonicalPath}`);
    }
    const encoding = classifyEncoding(content);
    if (encoding === "binary") {
      return;
    }
    snapshots.set(canonicalPath, immutableSnapshot(canonicalPath, content, after.mode & 0o7777, encoding));
  };

  for (const path of paths) {
    const normalized = normalizeRequestedPath(path);
    await visit(resolve(canonicalRoot, normalized));
  }
  return [...snapshots.values()].sort((left, right) => compareStrings(left.path, right.path));
}
