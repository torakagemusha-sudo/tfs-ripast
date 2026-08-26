import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .trim().split("\n").filter((file) => file.length > 0);
const docs = (await readdir("docs", { recursive: true }))
  .filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`);
const files = [...new Set([...tracked, ...docs])];
const machinePath = /(?:\/home\/k1|\/Users\/|[A-Za-z]:\\)/u;
const missing = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (machinePath.test(source)) throw new Error(`machine-specific path in ${file}`);
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split("#", 1)[0];
    if (target.length === 0 || /^(?:https?:|mailto:)/u.test(target)) continue;
    try {
      await access(resolve(dirname(file), decodeURIComponent(target)));
    } catch {
      missing.push(`${file}: ${target}`);
    }
  }
}
if (missing.length > 0) throw new Error(`missing documentation links:\n${missing.join("\n")}`);
console.log(`checked ${files.length} maintained Markdown files`);
