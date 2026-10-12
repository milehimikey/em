// SPDX-License-Identifier: MIT
// GH #236: `em slice defer` on a RATIFIED / SHIPPED slice doc queues the question in
// `.event-modeling.md` instead of editing the signed body; `revise` / `mark-implemented` inject the
// queue into the v<N+1> draft; `revise` refuses an unshipped ratified doc without `--withdraw`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sliceDocBodyHash } from "../src/catalog/sliceDoc.js";
import { parseQueuedBullet, queuedBullet, queuedItems } from "../src/catalog/deferQueue.js";
import { applyQueueStateFile, drainQueueInState, injectQueuedQuestions, isLockedDoc } from "../src/cli/defer.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const ITEM = { question: "retry policy", sliceKey: "pay", targetVersion: 2, until: 2, on: "2026-10-12", by: "Alex", decision: "fail fast (no retries)" };
const BULLET = "- retry policy (from slice pay, queued for pay@v2, until v2, 2026-10-12, by Alex; decision: fail fast (no retries))";

describe("the queued bullet (pure)", () => {
  it("has one exact shape and round-trips, including a decision with parentheses and no --by", () => {
    expect(queuedBullet(ITEM)).toBe(BULLET);
    expect(parseQueuedBullet(BULLET)).toEqual(ITEM);
    const noBy = { ...ITEM, by: undefined };
    delete (noBy as { by?: string }).by;
    expect(parseQueuedBullet(queuedBullet(noBy))).toEqual(noBy);
  });
  it("is not confused with an ordinary parking-lot mirror, and queuedItems filters by slice and version", () => {
    expect(parseQueuedBullet("- retry policy (from slice pay, deferred to v2)")).toBeNull();
    const state = [BULLET, queuedBullet({ ...ITEM, sliceKey: "ship" }), queuedBullet({ ...ITEM, targetVersion: 3, until: 3 })].join("\n");
    expect(queuedItems(state, "pay", 2)).toEqual([ITEM]);
  });
  it("drain turns the queued bullet into the ordinary mirror, leaving others alone", () => {
    const other = queuedBullet({ ...ITEM, sliceKey: "ship" });
    const r = drainQueueInState(`## Open questions / parking lot\r\n${BULLET}\r\n${other}\r\n`, "pay", 2);
    expect(r.count).toBe(1);
    expect(r.content).toBe(`## Open questions / parking lot\r\n- retry policy (from slice pay, deferred to v2)\r\n${other}\r\n`);
  });
  it("applyQueueStateFile writes the queued bullet and a dated Decisions-log bullet, idempotently", () => {
    const state = "## Decisions log\n- a\n\n## Open questions / parking lot\n- b\n\n## Slice inventory\n";
    const r = applyQueueStateFile(state, { question: "retry policy", sliceKey: "pay", until: 2, decision: "fail fast (no retries)", by: "Alex", on: "2026-10-12", currentVersion: 1 });
    expect(r).toMatchObject({ ok: true, changed: true });
    if (!r.ok) return;
    expect(r.content).toContain(`- b\n${BULLET}\n\n## Slice inventory`);
    expect(r.content).toContain('- a\n- 2026-10-12: queued "retry policy" on pay for pay@v2 (until v2) — v1: fail fast (no retries) — by Alex\n');
    expect(applyQueueStateFile(r.content, { question: "retry policy", sliceKey: "pay", until: 2, decision: "fail fast (no retries)", by: "Alex", on: "2026-10-12", currentVersion: 1 })).toMatchObject({ ok: true, changed: false });
  });
  it("isLockedDoc: ratified or implemented only", () => {
    const fm = (s: string) => `---\nversion: 1\n${s}\n---\nbody\n`;
    expect(isLockedDoc(fm("status: ready-to-implement\nratifiedBy: Alex"))).toBe(true);
    expect(isLockedDoc(fm("status: implemented"))).toBe(true);
    expect(isLockedDoc(fm("status: ready-to-implement"))).toBe(false);
    expect(isLockedDoc(fm("status: draft\nshippedVersion: 1"))).toBe(false);
    expect(isLockedDoc(fm("status: reviewed"))).toBe(false);
  });
  it("injectQueuedQuestions creates the section when missing and skips a present line", () => {
    const once = injectQueuedQuestions("# Slice\n", [ITEM]);
    expect(once.content).toBe("# Slice\n\n## Open Questions\n\n- [ ] retry policy — v1: fail fast (no retries) (queued 2026-10-12, Alex)\n");
    expect(injectQueuedQuestions(once.content, [ITEM]).count).toBe(0);
  });
});

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const STATE = "# State\n\n## Decisions log\n<!-- c -->\n- 2026-01-01: old — why\n\n## Open questions / parking lot\n<!-- c -->\n\n## Slice inventory\n";
const frontmatter = (extra: string) =>
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n" +
  `reviewedBy: Sam\nreviewedOn: 2026-10-01\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash("---\n---\n" + BODY)}\n${extra}---\n`;

describe("em slice defer / revise / mark-implemented on a ratified, unshipped doc (GH #236, CLI)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const statePath = () => join(dir, ".event-modeling.md");
  const read = (p: string) => readFileSync(p, "utf8");
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);
  const defer = (...extra: string[]) =>
    em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v2", "--decision", "fail fast (no retries)", "--by", "Alex", "--on", "2026-10-12", ...extra], dir);
  const statusJson = () => JSON.parse(em(["status", "model.em", "--json"], dir).stdout);
  const exportDoc = () => JSON.parse(em(["export", "model.em", "--slice", "pay"], dir).stdout).slice.doc;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-defer-queue-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(docPath(), frontmatter("") + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    writeFileSync(statePath(), STATE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the issue's repro: defer queues, leaves body + ratifiedHash alone, --slice-ready stays green", () => {
    expect(ready().status).toBe(0);
    const docBefore = read(docPath());
    const d = defer();
    expect(d.stderr).toBe("");
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("queued, not edited: slices/pay.md stays as ratified (v1)");
    expect(d.stdout).toContain("queued for pay@v2 in .event-modeling.md");
    expect(read(docPath())).toBe(docBefore);
    expect(ready().status).toBe(0);
    const state = read(statePath());
    expect(state).toContain(`<!-- c -->\n${BULLET}\n`);
    expect(state).toContain('- 2026-10-12: queued "retry policy" on pay for pay@v2 (until v2) — v1: fail fast (no retries) — by Alex');
  });

  it("a second identical run is a no-op", () => {
    defer();
    const before = [read(docPath()), read(statePath())];
    const d = defer();
    expect(d.status).toBe(0);
    expect(d.stdout).toBe("already queued (no-op): slices/pay.md\n");
    expect([read(docPath()), read(statePath())]).toEqual(before);
  });

  it("keeps the --until / --decision validation", () => {
    const d = em(["slice", "defer", "model.em", "pay", "q", "--until", "v1", "--decision", "x"], dir);
    expect(d.status).toBe(1);
    expect(d.stderr).toContain("--until v1 must be greater than the doc's current version v1");
    expect(read(statePath())).toBe(STATE);
  });

  it("em status and em export --slice surface the queued count", () => {
    expect(exportDoc().queuedForNext).toBe(0);
    expect(statusJson().issues.queuedQuestions).toBe(0);
    defer();
    expect(exportDoc().queuedForNext).toBe(1);
    expect(statusJson().issues.queuedQuestions).toBe(1);
    expect(em(["status", "model.em"], dir).stdout).toContain("1 queued for next version");
    const full = JSON.parse(em(["export", "model.em"], dir).stdout);
    expect(full.schemaVersion).toBe("1.17");
    expect(full.model.slices[0].doc.queuedForNext).toBe(1);
  });

  it("revise refuses without --withdraw, writing nothing and keeping the queue", () => {
    defer();
    const before = [read(docPath()), read(statePath())];
    const r = em(["slice", "revise", "model.em", "pay"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would withdraw the ratification of the only implementable version");
    expect(r.stderr).toContain('em slice defer <model> <key> "<question>"');
    expect([read(docPath()), read(statePath())]).toEqual(before);
  });

  it("revise --withdraw proceeds, injects the queued question, and clears the queue", () => {
    defer();
    const r = em(["slice", "revise", "model.em", "pay", "--withdraw"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ratification of v1 withdrawn (never shipped); v2 opened as draft");
    expect(r.stdout).toContain("injected 1 queued question(s)");
    const doc = read(docPath());
    expect(doc).toContain("status: draft\nversion: 2\n");
    expect(doc).toContain("## Open Questions\n\n- [ ] retry policy — v1: fail fast (no retries) (queued 2026-10-12, Alex)\n");
    const state = read(statePath());
    expect(state).not.toContain("queued for pay@v2");
    expect(state).toContain("- retry policy (from slice pay, deferred to v2)");
    expect(exportDoc().queuedForNext).toBe(0);
  });

  it("mark-implemented opens v2 as a draft with the question injected, and clears the queue", () => {
    defer();
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    expect(m.status).toBe(0);
    expect(m.stdout).toContain("opened draft v2: slices/pay.md — re-opened 0 deferred question(s), injected 1 queued question(s)");
    const doc = read(docPath());
    expect(doc).toContain("status: draft\n");
    expect(doc).toContain("shippedVersion: 1\n");
    expect(doc).toContain("version: 2\n");
    expect(doc).toContain("- [ ] retry policy — v1: fail fast (no retries) (queued 2026-10-12, Alex)\n");
    expect(read(statePath())).not.toContain("queued for pay@v2");
    // Re-running the merge is still a no-op.
    expect(em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7"], dir).stdout).toContain("already implemented (no-op)");
  });

  it("mark-implemented with nothing queued still leaves the slice implemented", () => {
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7"], dir);
    expect(m.status).toBe(0);
    expect(read(docPath())).toContain("status: implemented\n");
  });

  it("a shipped doc (status: implemented) queues too, and revise injects into v2 unchanged by --withdraw", () => {
    em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7"], dir);
    const before = read(docPath());
    const d = defer("--until", "v3");
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("queued, not edited: slices/pay.md stays as ratified (v1)");
    expect(read(docPath())).toBe(before);
    const r = em(["slice", "revise", "model.em", "pay"], dir);
    expect(r.status).toBe(0);
    // --until v3 beyond the draft's own version: carried as an ordinary deferral, not an open question.
    expect(read(docPath())).toContain("- [x] retry policy — v1: fail fast (no retries); deferred to v3 (2026-10-12, Alex)\n");
  });

  it("defer --from-issue queues too: doc untouched, issue clause removed from the .em", () => {
    writeFileSync(join(dir, "model.em"), MODEL.replace("event Paid", 'event Paid issue "Is Paid final?"'));
    const before = read(docPath());
    const d = em(["slice", "defer", "model.em", "pay", "--from-issue", "final", "--until", "v2", "--decision", "later", "--on", "2026-10-12"], dir);
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("queued, not edited: slices/pay.md");
    expect(read(docPath())).toBe(before);
    expect(read(join(dir, "model.em"))).not.toContain("issue");
    expect(read(statePath())).toContain("- Is Paid final? (from slice pay, queued for pay@v2, until v2, 2026-10-12; decision: later)");
    const again = em(["slice", "defer", "model.em", "pay", "--from-issue", "final", "--until", "v2", "--decision", "later", "--on", "2026-10-12"], dir);
    expect(again.stdout).toBe("already queued (no-op): slices/pay.md\n");
  });

  it("on a draft doc, defer still edits the body (unchanged behavior)", () => {
    writeFileSync(docPath(), frontmatter("").replace("status: ready-to-implement", "status: draft") + BODY.replace("## Open Questions\n", "## Open Questions\n\n- [ ] retry policy?\n"));
    const d = defer();
    expect(d.stdout).toBe("deferred: slices/pay.md (retry policy → v2)\n");
    expect(read(docPath())).toContain("- [x] retry policy? — v1: fail fast (no retries); deferred to v2 (2026-10-12, Alex)");
    expect(read(statePath())).toContain("- retry policy (from slice pay, deferred to v2)");
    expect(read(statePath())).not.toContain("queued for");
  });
});
