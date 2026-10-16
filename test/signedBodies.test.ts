// SPDX-License-Identifier: MIT
// GH #257: `em validate --check-signed-bodies` — the status-independent hash check through the real
// binary. A shipped (`implemented`) doc whose body moved after ratification is reported only when the
// opt-in is on; a pre-1.17 whole-body hash with an intact body passes; a deferral appended by
// `em slice defer` to a ratified doc never trips it. Real git, because ratify records the HEAD it signs.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sliceDocLegacyBodyHash } from "../src/catalog/sliceDoc.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const REVIEWED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";

describe("em validate --check-signed-bodies (GH #257, CLI, real git)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const read = () => readFileSync(docPath(), "utf8");
  const check = (...extra: string[]) => em(["validate", "model.em", "--check-signed-bodies", ...extra], dir);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh257-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(docPath(), REVIEWED + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    writeFileSync(join(dir, ".event-modeling.md"), "# State\n\n## Decisions log\n\n## Open questions / parking lot\n\n## Slice inventory\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed");
    const r = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    if (m.status !== 0) throw new Error(m.stderr);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a shipped doc with an intact body passes; a deferral written by defer passes; a hand edit fails only with the flag", () => {
    expect(read()).toContain("status: implemented\n");
    expect(check().status).toBe(0);
    const d = em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v2", "--decision", "fail fast", "--on", "2026-10-15"], dir);
    expect(d.status).toBe(0);
    expect(check().status).toBe(0);
    writeFileSync(docPath(), read().replace("Charge the customer.", "Charge the customer twice."));
    expect(em(["validate", "model.em"], dir).status).toBe(0); // default: nothing watches a shipped doc's body
    const strict = check();
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('slice "pay"\'s doc slices/pay.md (status: implemented, v1) was edited after ratification');
    const json = JSON.parse(check("--json").stdout);
    expect(json.diagnostics.map((x: { code: string; severity: string }) => [x.code, x.severity])).toEqual([["slice-body-changed-since-ratification", "error"]]);
  });

  it("a pre-1.17 whole-body hash with an intact body is legacy, not a mismatch", () => {
    writeFileSync(docPath(), read().replace("Charge the customer twice.", "Charge the customer."));
    const legacy = sliceDocLegacyBodyHash(read());
    writeFileSync(docPath(), read().replace(/ratifiedHash: \S+/, `ratifiedHash: ${legacy}`));
    expect(check().status).toBe(0);
  });
});
