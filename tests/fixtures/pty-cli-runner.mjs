import { spawnSync } from "node:child_process";

const cli = process.env.TFS_RIPAST_PTY_CLI;
const encodedArguments = process.env.TFS_RIPAST_PTY_ARGV;
if (cli === undefined || encodedArguments === undefined) {
  throw new Error("PTY runner requires TFS_RIPAST_PTY_CLI and TFS_RIPAST_PTY_ARGV.");
}
const parsed = JSON.parse(encodedArguments);
if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
  throw new Error("PTY runner arguments must be a JSON string array.");
}
const result = spawnSync(process.execPath, [cli, ...parsed], { stdio: "inherit" });
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
