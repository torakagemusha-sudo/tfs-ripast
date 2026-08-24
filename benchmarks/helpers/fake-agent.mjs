import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const cwd = process.cwd();
const prompt = await readFile(join(cwd, "prompt.md"), "utf8");
const target = prompt.includes("legacyMode") ? "src/config.ts" : "src/settings.ts";
const source = await readFile(join(cwd, target), "utf8");
const sequence = (tool, status = "ok") => console.log(`TFS_BENCH_EVENT ${JSON.stringify({ sequence: globalThis.eventSequence = (globalThis.eventSequence ?? 0) + 1, tool, status, startedNs: process.hrtime.bigint().toString(), endedNs: process.hrtime.bigint().toString() })}`);
sequence("read");
if (process.env.TFS_BENCH_FAIL === "1") {
  sequence("edit", "failed");
  process.exit(2);
}
const changed = target.endsWith("config.ts")
  ? source.replaceAll("legacyMode:", "safeMode:").replaceAll(".legacyMode", ".safeMode")
  : source.replaceAll("unsafeDefault:", "verifiedDefault:").replaceAll(".unsafeDefault", ".verifiedDefault");
await writeFile(join(cwd, target), changed, "utf8");
sequence(process.env.TFS_RIPAST_MODE === "ripast" ? "tfs-ripast" : "edit");
if (process.env.TFS_RIPAST_MODE === "normal" && process.env.TFS_RIPAST_BIN) throw new Error(`normal mode exposed ${basename(process.env.TFS_RIPAST_BIN)}`);
sequence("acceptance");
