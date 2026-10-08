// SPDX-License-Identifier: MIT
// MIL-276: the shipped examples pass the 1.14 gates a first-time user runs — every
// `ready-to-implement` example slice doc passes `em validate --slice-ready`, and every example
// model with a `public` element has a current committed contract (`em api check`).
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const all = walk(EXAMPLES);
const readyDocs = all.filter(
  (p) => /[\\/]slices[\\/][^\\/]+\.md$/.test(p) && /^status:\s*ready-to-implement\s*$/m.test(readFileSync(p, "utf8")),
);
/** The `.em` beside (or one level above) a slice doc's `slices/` dir. */
function modelFor(doc: string): string {
  const base = dirname(dirname(doc));
  const em = readdirSync(base).find((n) => n.endsWith(".em"));
  if (!em) throw new Error(`no .em beside ${doc}`);
  return join(base, em);
}
const publicModels = all.filter(
  (p) => p.endsWith(".em") && /\bpublic\b/.test(readFileSync(p, "utf8").replace(/#.*$/gm, "")),
);

describe("examples pass their own gates (MIL-276)", () => {
  it("finds the ready docs and public models this gate covers", () => {
    expect(readyDocs.length).toBeGreaterThan(0);
    expect(publicModels.length).toBeGreaterThan(0);
  });
  for (const doc of readyDocs) {
    it(`--slice-ready passes: ${relative(EXAMPLES, doc)}`, () => {
      const model = modelFor(doc);
      const key = basename(doc, ".md");
      const r = em(["validate", basename(model), "--slice-ready", key], dirname(model));
      expect({ status: r.status, out: r.stdout + r.stderr }).toMatchObject({ status: 0 });
    });
  }
  for (const model of publicModels) {
    it(`api check is current: ${relative(EXAMPLES, model)}`, () => {
      const r = em(["api", "check", basename(model)], dirname(model));
      expect({ status: r.status, out: r.stdout + r.stderr }).toMatchObject({ status: 0 });
    });
  }
});
