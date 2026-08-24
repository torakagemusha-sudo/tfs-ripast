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
});
