// SPDX-License-Identifier: MIT
// Guard (MIL-216): a test that computes an expected "today" with the UTC calendar date
// (`toISOString().slice(0, 10)` and its `.substring`/`.split("T")[0]` siblings) silently
// diverges from what the CLI actually stamps — every date-defaulting command has used the
// *local* calendar date since MIL-206 (PR #149, `localIsoDate()` in src/util/localDate.ts).
// West of UTC after ~17:00 local, "today" in UTC is already tomorrow: the 1.12.0 release
// preflight hit exactly this — three tests green in CI (which runs in UTC) and red on the
// owner's machine that same evening (see PR #158). Sweeps every test/**/*.ts file (except this
// guard itself, which necessarily names the forbidden patterns as strings, and
// test/localDate.test.ts, which documents localIsoDate()'s own contract) and fails, naming
// file:line, on any occurrence outside a `//` comment. Fix: use `localIsoDate()` instead.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const EXCLUDED = new Set([SELF, join(TEST_DIR, "localDate.test.ts")]);

// Each pattern reads the UTC calendar date, not the local one `localIsoDate()` produces.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /toISOString\(\)\.slice\(0,\s*10\)/,
  /toISOString\(\)\.substring\(0,\s*10\)/,
  /toISOString\(\)\.split\("T"\)\[0\]/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(TEST_DIR)) {
    if (EXCLUDED.has(file)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      // A pattern that only appears after a `//` on the line is prose (a comment explaining the
      // rule, e.g. this file's own header), not live code — only flag matches before it.
      const commentIdx = line.indexOf("//");
      const code = commentIdx === -1 ? line : line.slice(0, commentIdx);
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(code)) {
          violations.push({ file: relative(TEST_DIR, file), line: idx + 1, text: line.trim() });
        }
      }
    });
  }
  return violations;
}

describe("no UTC-\"today\" date literals in tests (MIL-216)", () => {
  it("finds test files to sweep (guards against a silently empty walk)", () => {
    expect(walk(TEST_DIR).length).toBeGreaterThan(10);
  });

  it("no test/**/*.ts file computes an expected date with the UTC calendar date", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const detail = violations.map((v) => `  test/${v.file}:${v.line}: ${v.text}`).join("\n");
      throw new Error(
        `Found UTC "today" date literal(s) that diverge from localIsoDate() (src/util/localDate.ts) ` +
          `after ~17:00 in zones west of UTC — use localIsoDate() instead:\n${detail}`,
      );
    }
  });
});
