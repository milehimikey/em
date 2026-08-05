// SPDX-License-Identifier: MIT
// Every model in examples/ is committed alongside a rendered SVG/PNG, so it must stay
// renderable: no parse errors, no validate errors (warnings are fine — order-fulfillment.em
// keeps a few on purpose, see docs/tutorial.md), and a well-formed self-contained SVG out the
// other end. Guards against parser/pipeline regressions silently breaking a shipped example.
//
// examples/timeline-rules-invalid.em is excluded — it exists specifically to demonstrate
// `em validate` rejecting illegal arrows and is never rendered (see its header comment).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { renderDot } from "../src/render/render.js";
import { hasErrors } from "../src/model/validate.js";

const EXAMPLES_DIR = "examples";
const EXCLUDED = new Set(["timeline-rules-invalid.em"]);

const files = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".em") && !EXCLUDED.has(f))
  .sort();

describe("examples/*.em render cleanly", () => {
  it("finds the example models (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file} parses, validates without errors, and renders to a well-formed SVG`, async () => {
      const path = join(EXAMPLES_DIR, file);
      const source = readFileSync(path, "utf8");
      const { dot, model, diagnostics } = compile(source); // throws ParseError on bad syntax

      expect(hasErrors(diagnostics)).toBe(false);

      const dir = mkdtempSync(join(tmpdir(), "em-examples-"));
      try {
        const out = join(dir, "out.svg");
        await renderDot(dot, model, out, "svg", EXAMPLES_DIR);
        const svg = readFileSync(out, "utf8");
        expect(svg).toMatch(/<svg\b/);
        expect(svg.trim().endsWith("</svg>")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
