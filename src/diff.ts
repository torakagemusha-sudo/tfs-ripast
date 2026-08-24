import { compareStrings } from "./order.js";
import { sha256 } from "./filesystem.js";
import type { FileSnapshot } from "./planner.js";
import type { Edit, EditPlan } from "./types.js";

export interface PreviewOptions {
  snapshots: readonly FileSnapshot[];
  contextLines?: number;
  maxLines?: number;
  maxBytes?: number;
}

interface UnifiedDiffOptions {
  contextLines?: number;
  maxLines?: number;
  maxBytes?: number;
}

function normalizedReplacement(replacement: string, newline: FileSnapshot["newline"]): Buffer {
  const normalized = newline === "crlf"
    ? replacement.replace(/\r?\n/gu, "\r\n")
    : replacement;
  return Buffer.from(normalized, "utf8");
}

export function applySnapshotEdits(snapshot: FileSnapshot, edits: readonly Edit[]): Buffer {
  const original = Buffer.from(snapshot.content);
  if (snapshot.hash !== sha256(original) || snapshot.byteLength !== original.byteLength) {
    throw new Error(`Preview snapshot is not immutable or does not match its hash: ${snapshot.path}`);
  }
  let output = original;
  const ordered = [...edits].sort((left, right) =>
    right.byteRange[0] - left.byteRange[0] || right.byteRange[1] - left.byteRange[1]);
  let previousStart = original.byteLength;
  for (const edit of ordered) {
    const [start, end] = edit.byteRange;
    if (
      edit.file !== snapshot.path ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > original.byteLength ||
      end > previousStart
    ) {
      throw new Error(`Edit is outside or overlaps immutable snapshot ${snapshot.path}: ${edit.id}`);
    }
    output = Buffer.concat([
      output.subarray(0, start),
      normalizedReplacement(edit.replacement, snapshot.newline),
      output.subarray(end),
    ]);
    previousStart = start;
  }
  return output;
}

function splitLines(value: string): string[] {
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function appendBounded(
  output: string[],
  line: string,
  maxLines: number,
  maxBytes: number,
): boolean {
  if (output.length >= maxLines) {
    return false;
  }
  const candidate = output.length === 0 ? line : `\n${line}`;
  const used = Buffer.byteLength(output.join("\n"));
  if (used + Buffer.byteLength(candidate) > maxBytes) {
    return false;
  }
  output.push(line);
  return true;
}

/** Produces a unified, line-oriented patch; omitted context is explicitly marked. */
export function renderUnifiedDiff(
  path: string,
  before: Uint8Array,
  after: Uint8Array,
  options: UnifiedDiffOptions = {},
): string {
  const contextLines = Math.max(0, options.contextLines ?? 3);
  const maxLines = Math.max(1, options.maxLines ?? Number.POSITIVE_INFINITY);
  const maxBytes = Math.max(1, options.maxBytes ?? Number.POSITIVE_INFINITY);
  const beforeLines = splitLines(Buffer.from(before).toString("utf8"));
  const afterLines = splitLines(Buffer.from(after).toString("utf8"));
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  if (prefix === beforeLines.length && prefix === afterLines.length) {
    return "";
  }

  const oldStart = Math.max(0, prefix - contextLines);
  const newStart = oldStart;
  const oldEnd = Math.min(beforeLines.length, beforeLines.length - suffix + contextLines);
  const newEnd = Math.min(afterLines.length, afterLines.length - suffix + contextLines);
  const body = [
    ...beforeLines.slice(oldStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `-${line}`),
    ...afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+${line}`),
    ...afterLines.slice(afterLines.length - suffix, newEnd).map((line) => ` ${line}`),
  ];
  const complete = oldStart === 0 && oldEnd === beforeLines.length && newEnd === afterLines.length;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
    ...body,
  ];
  const output: string[] = [];
  let truncated = !complete;
  for (const line of lines) {
    if (!appendBounded(output, line, maxLines, maxBytes)) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    const marker = "... preview truncated ...";
    while (output.length > 0 && !appendBounded(output, marker, maxLines, maxBytes)) {
      output.pop();
    }
    if (output.length === 0) {
      const bytes = Buffer.from(marker);
      return bytes.subarray(0, Math.min(bytes.byteLength, maxBytes)).toString("utf8");
    }
  }
  return output.join("\n");
}

/** Renders bounded human diff excerpts while leaving the complete edit plan untouched. */
export function renderPreview(editPlan: EditPlan, options: PreviewOptions): string {
  const snapshots = new Map(options.snapshots.map((snapshot) => [snapshot.path, snapshot]));
  const editsByFile = new Map<string, Edit[]>();
  for (const edit of editPlan.edits) {
    const edits = editsByFile.get(edit.file) ?? [];
    edits.push(edit);
    editsByFile.set(edit.file, edits);
  }
  const remainingLines = Math.max(1, options.maxLines ?? 400);
  const remainingBytes = Math.max(1, options.maxBytes ?? 64 * 1024);
  const sections: string[] = [];
  let linesUsed = 0;
  let bytesUsed = 0;
  for (const [path, edits] of [...editsByFile].sort(([left], [right]) => compareStrings(left, right))) {
    const snapshot = snapshots.get(path);
    if (snapshot === undefined) {
      throw new Error(`Preview has no immutable snapshot for edited file: ${path}`);
    }
    const separatorBytes = sections.length === 0 ? 0 : 2;
    const section = renderUnifiedDiff(path, snapshot.content, applySnapshotEdits(snapshot, edits), {
      ...(options.contextLines === undefined ? {} : { contextLines: options.contextLines }),
      maxLines: remainingLines - linesUsed,
      maxBytes: remainingBytes - bytesUsed - separatorBytes,
    });
    if (section.length === 0) {
      continue;
    }
    sections.push(section);
    linesUsed += section.split("\n").length;
    bytesUsed += Buffer.byteLength(section) + separatorBytes;
    if (linesUsed >= remainingLines || bytesUsed >= remainingBytes) {
      break;
    }
  }
  return sections.join("\n\n");
}
