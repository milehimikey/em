// SPDX-License-Identifier: MIT
// GH #256: `em validate --slice-ready <key> --require-ratified-hash` — strict mode through the real
// binary: a ready-to-implement doc with no `ratifiedHash:` passes by default (a pre-1.15 doc, or a
// hand-edited frontmatter) and fails under the flag with a stable code and `ready: false` in --json.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Open Questions\n\n## Notes\n\nnone\n";
// Hand-edited to ready with a sign-off and no hash — exactly the doc the issue describes.
const HAND_RATIFIED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n---\n";

describe("em validate --slice-ready --require-ratified-hash (GH #256, CLI)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh256-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), HAND_RATIFIED + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("default: the hashless ready doc passes; strict: exit 1, the code on stderr, ready:false + the code in --json", () => {
    expect(em(["validate", "model.em", "--slice-ready", "pay"], dir).status).toBe(0);
    const strict = em(["validate", "model.em", "--slice-ready", "pay", "--require-ratified-hash"], dir);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain("is ready-to-implement with no ratifiedHash — --require-ratified-hash is on");
    const json = JSON.parse(em(["validate", "model.em", "--slice-ready", "pay", "--require-ratified-hash", "--json"], dir).stdout);
    expect(json.ready).toBe(false);
    expect(json.gates.ratified).toBe(true);
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["slice-ready-missing-ratified-hash"]);
    expect(JSON.parse(em(["validate", "model.em", "--slice-ready", "pay", "--json"], dir).stdout).ready).toBe(true);
  });

  it("after a real ratification (hash recorded) strict mode passes; the flag without --slice-ready is refused", () => {
    expect(em(["slice", "revise", "model.em", "pay", "--withdraw"], dir).status).toBe(0);
    expect(em(["slice", "review", "model.em", "pay", "--by", "Sam"], dir).status).toBe(0);
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Alex"], dir).status).toBe(0);
    expect(em(["validate", "model.em", "--slice-ready", "pay", "--require-ratified-hash"], dir).status).toBe(0);
    const alone = em(["validate", "model.em", "--require-ratified-hash"], dir);
    expect(alone.status).toBe(1);
    expect(alone.stderr).toContain("--require-ratified-hash applies only with --slice-ready <key>");
  });
});
