// SPDX-License-Identifier: MIT
// Coverage for `em contract`'s core logic (src/cli/contract.ts): reading the packaged
// reference/implement.md verbatim. CLI-level exit-code/process coverage lives in
// test/cli.test.ts, same split as `em export`/`em slice index`.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractPath, readContract } from "../src/cli/contract.js";

describe("contractPath", () => {
  it("points at reference/implement.md inside the given skill directory", () => {
    expect(contractPath("/some/skill/dir")).toBe(join("/some/skill/dir", "reference", "implement.md"));
  });
});

describe("readContract", () => {
  it("returns the packaged implement.md's exact bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-contract-"));
    try {
      mkdirSync(join(dir, "reference"));
      writeFileSync(join(dir, "reference", "implement.md"), "# Implementing a ratified slice\n\nbody text\n");

      expect(readContract(dir)).toBe("# Implementing a ratified slice\n\nbody text\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
