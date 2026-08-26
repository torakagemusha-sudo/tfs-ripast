import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("CLI", () => {
  it("requires search and replacement for an ad hoc rewrite", async () => {
    const errors: string[] = [];
    const code = await main([], {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
      isTTY: false,
      confirm: async () => false,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--search");
  });

  it("documents multiple ad-hoc PATH operands", async () => {
    const chunks: string[] = [];
    const code = await main(["--help"], {
      stdout: (value) => chunks.push(value),
      stderr: () => undefined,
      isTTY: false,
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("tfs-ripast --search TEXT --replace TEXT [PATH ...]");
  });

  it("reports 0.1.1", async () => {
    const chunks: string[] = [];
    const code = await main(["--version"], {
      stdout: (value) => chunks.push(value),
      stderr: () => undefined,
      isTTY: false,
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(chunks.join("")).toBe("tfs-ripast 0.1.1\n");
  });
});
