// SPDX-License-Identifier: MIT
// GH #260: `em slice ratify --skip-review` persists the bypass on the doc (`reviewSkipped: <status>`),
// and every reader a host gate would use can see it — `em export` (schema 1.18) and
// `em validate --slice-ready --json` (schema 1.3) — until `em slice revise` clears it with the rest
// of the sign-off. Through the real binary; no git (ratify records the hash only outside a work tree).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const DRAFT = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n";

describe("em slice ratify --skip-review persists reviewSkipped (GH #260, CLI)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const read = () => readFileSync(docPath(), "utf8");
  const exportDoc = () => JSON.parse(em(["export", "model.em", "--slice", "pay"], dir).stdout);
  const readyJson = () => JSON.parse(em(["validate", "model.em", "--slice-ready", "pay", "--json"], dir).stdout);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh260-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(docPath(), DRAFT + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("ratify --skip-review from draft: notice on stderr AND reviewSkipped: draft on the doc; export and --slice-ready --json carry it; readiness itself is unaffected", () => {
    const r = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-15", "--skip-review"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('notice: --skip-review — ratifying "pay" without a recorded review (status was draft)');
    expect(read()).toContain("status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-15\nreviewSkipped: draft\nratifiedHash: sha256:");
    const exported = exportDoc();
    expect(exported.schemaVersion).toBe("1.19");
    expect(exported.slice.doc.reviewSkipped).toBe("draft");
    const ready = readyJson();
    expect(ready.validateSliceReadySchemaVersion).toBe("1.4");
    expect(ready.reviewSkipped).toBe("draft");
    expect(ready.ready).toBe(true);
    expect(ready.gates.ratified).toBe(true);
    // Idempotent re-run: no second marker, no change.
    const before = read();
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-15", "--skip-review"], dir).stdout).toContain("already ratified (no-op)");
    expect(read()).toBe(before);
  });

  it("revise --withdraw clears it with the sign-off; a reviewed ratification writes none", () => {
    expect(em(["slice", "revise", "model.em", "pay", "--withdraw"], dir).status).toBe(0);
    expect(read()).not.toContain("reviewSkipped");
    expect(exportDoc().slice.doc.reviewSkipped).toBeNull();
    expect(readyJson().reviewSkipped).toBeNull();
    expect(em(["slice", "review", "model.em", "pay", "--by", "Sam", "--on", "2026-10-15"], dir).status).toBe(0);
    const r = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-16", "--skip-review"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("notice: --skip-review"); // the flag did nothing: the doc was reviewed
    expect(read()).not.toContain("reviewSkipped");
    expect(exportDoc().slice.doc.reviewSkipped).toBeNull();
  });
});
