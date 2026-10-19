// SPDX-License-Identifier: MIT
// GH #253: `ratifiedHash` leaves `## Open Questions`' deferrals out, so `em slice defer` writes to
// a RATIFIED / SHIPPED slice doc without moving the hash — superseding GH #236's state-file queue
// (1.16.x), whose read side stays until the leftovers drain. This file is the lifecycle walk the
// 1.17.0 slate asks for, seeded here: ratify → defer → --slice-ready still green → status/export
// count it → revise / mark-implemented reopen it. Pure tests for the hash scope and the kept queue
// readers sit at the top; the CLI walk runs through the real binary (spawnSync + tsx) in a real git
// repository, because `em slice ratify` records the HEAD it signs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countDeferredBeyond, ratifiedBody, ratifiedHashScope, sliceDocBodyHash, sliceDocLegacyBodyHash } from "../src/catalog/sliceDoc.js";
import { parseQueuedBullet, queuedBullet, queuedItems } from "../src/catalog/deferQueue.js";
import { drainQueueInState, finishSignedDocEdit, injectQueuedQuestions, isSignedDoc } from "../src/cli/defer.js";
import { replaceFieldValue } from "../src/cli/frontmatterSurgery.js";
import { writeModel117 } from "./helpers/model117.js";

vi.setConfig({ testTimeout: 20_000 });

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
  return r.stdout;
};

const DEFERRED = "- [x] retry policy — v1: fail fast (no retries); deferred to v2 (2026-10-12, Alex)";

describe("ratifiedBody / sliceDocBodyHash (pure)", () => {
  const fm = "---\nversion: 1\n---\n";
  it("drops the Open Questions heading, the section's blank lines and its deferred items; keeps everything else", () => {
    const body = `# Slice\n\n## Intent\n\nCharge.\n\n## Open Questions\n\n- [x] answered — yes\n${DEFERRED}\n- [ ] still open\n\n## Notes\n\nnone\n`;
    expect(ratifiedBody(body)).toBe("# Slice\n\n## Intent\n\nCharge.\n\n- [x] answered — yes\n- [ ] still open\n## Notes\n\nnone");
  });
  it("appending a deferred item never moves the hash — section present, empty, mid-doc, or absent", () => {
    const withSection = `${fm}# Slice\n\n## Open Questions\n\n- [x] answered — yes\n\n## Notes\n\nnone\n`;
    expect(sliceDocBodyHash(withSection.replace("- [x] answered — yes\n", `- [x] answered — yes\n${DEFERRED}\n`))).toBe(sliceDocBodyHash(withSection));
    const emptyMid = `${fm}# Slice\n\n## Open Questions\n\n## Notes\n\nnone\n`;
    expect(sliceDocBodyHash(emptyMid.replace("## Open Questions\n\n", `## Open Questions\n\n${DEFERRED}\n\n`))).toBe(sliceDocBodyHash(emptyMid));
    const emptyEnd = `${fm}# Slice\n\n## Open Questions\n`;
    expect(sliceDocBodyHash(`${emptyEnd}\n${DEFERRED}\n`)).toBe(sliceDocBodyHash(emptyEnd));
    const absent = `${fm}# Slice\n\nbody\n`;
    expect(sliceDocBodyHash(`${absent}\n## Open Questions\n\n${DEFERRED}\n`)).toBe(sliceDocBodyHash(absent));
  });
  it("a hand-added unchecked item, an edited answer, or any other edit DOES move the hash", () => {
    const doc = `${fm}# Slice\n\n## Open Questions\n\n- [x] answered — yes\n`;
    expect(sliceDocBodyHash(`${doc}- [ ] sneaked in\n`)).not.toBe(sliceDocBodyHash(doc));
    expect(sliceDocBodyHash(doc.replace("— yes", "— no"))).not.toBe(sliceDocBodyHash(doc));
    expect(sliceDocBodyHash(doc.replace("# Slice", "# Slice!"))).not.toBe(sliceDocBodyHash(doc));
  });
  it("ratifiedHashScope: current, legacy (whole-body), mismatch", () => {
    const doc = `${fm}# Slice\n\n## Open Questions\n\n- [x] answered — yes\n`;
    expect(ratifiedHashScope(doc, sliceDocBodyHash(doc))).toBe("current");
    expect(sliceDocLegacyBodyHash(doc)).not.toBe(sliceDocBodyHash(doc));
    expect(ratifiedHashScope(doc, sliceDocLegacyBodyHash(doc))).toBe("legacy");
    expect(ratifiedHashScope(`${doc}${DEFERRED}\n`, sliceDocLegacyBodyHash(doc))).toBe("mismatch"); // legacy scope sees the appended line
    expect(ratifiedHashScope(`${doc}${DEFERRED}\n`, sliceDocBodyHash(doc))).toBe("current");
    expect(ratifiedHashScope(`${doc}- [ ] new\n`, sliceDocBodyHash(doc))).toBe("mismatch");
  });
  it("countDeferredBeyond counts only items deferred past the given version", () => {
    const body = `## Open Questions\n\n${DEFERRED}\n- [x] later — v1: wait; deferred to v3 (2026-10-12)\n- [x] answered — yes\n- [ ] open\n`;
    expect(countDeferredBeyond(body, 1)).toBe(2);
    expect(countDeferredBeyond(body, 2)).toBe(1);
    expect(countDeferredBeyond(body, 3)).toBe(0);
    expect(countDeferredBeyond(body, null)).toBe(0);
    expect(countDeferredBeyond("# no section\n", 1)).toBe(0);
  });
});

describe("finishSignedDocEdit / replaceFieldValue (pure)", () => {
  const doc = (hash: string, body: string) => `---\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex\nratifiedHash: ${hash}\n---\n${body}`;
  const BODY = "# Slice\n\n## Open Questions\n\n- [x] answered — yes\n";
  it("current-scope hash: passes the edit through, no re-stamp", () => {
    const before = doc(sliceDocBodyHash(doc("x", BODY)), BODY);
    const after = `${before}${DEFERRED}\n`;
    expect(finishSignedDocEdit(before, after)).toEqual({ ok: true, content: after, restamped: false });
  });
  it("legacy-scope hash: re-stamps to the current scope in the same edit, byte-exact otherwise (CRLF too)", () => {
    const legacy = sliceDocLegacyBodyHash(doc("x", BODY));
    const before = doc(legacy, BODY);
    const after = `${before}${DEFERRED}\n`;
    const r = finishSignedDocEdit(before, after);
    expect(r).toMatchObject({ ok: true, restamped: true });
    if (!r.ok) return;
    expect(r.content).toBe(after.replace(legacy, sliceDocBodyHash(before)));
    const crlfBefore = before.replace(/\n/g, "\r\n");
    const crlfAfter = after.replace(/\n/g, "\r\n");
    const c = finishSignedDocEdit(crlfBefore, crlfAfter);
    expect(c.ok && c.content).toBe(crlfAfter.replace(legacy, sliceDocBodyHash(crlfBefore)));
  });
  it("refuses a doc whose body already fails its hash, and a doc with no hash passes untouched", () => {
    const moved = doc(sliceDocBodyHash(doc("x", BODY)), `${BODY}- [ ] edited in by hand\n`);
    expect(finishSignedDocEdit(moved, `${moved}${DEFERRED}\n`)).toMatchObject({ ok: false, message: expect.stringContaining("body no longer matches ratifiedHash") });
    const noHash = "---\nstatus: ready-to-implement\nratifiedBy: Alex\n---\nbody\n";
    expect(finishSignedDocEdit(noHash, `${noHash}x`)).toEqual({ ok: true, content: `${noHash}x`, restamped: false });
  });
  it("replaceFieldValue swaps one value, keeps prefix/EOL/everything else, null when absent", () => {
    expect(replaceFieldValue("---\na: 1\nratifiedHash:   old\nb: 2\n---\nbody\n", "ratifiedHash", "new")).toBe("---\na: 1\nratifiedHash:   new\nb: 2\n---\nbody\n");
    expect(replaceFieldValue("---\r\nratifiedHash: old\r\n---\r\nbody\r\n", "ratifiedHash", "new")).toBe("---\r\nratifiedHash: new\r\n---\r\nbody\r\n");
    expect(replaceFieldValue("---\na: 1\n---\nratifiedHash: in body\n", "ratifiedHash", "new")).toBeNull();
    expect(replaceFieldValue("no frontmatter\n", "ratifiedHash", "new")).toBeNull();
  });
  it("isSignedDoc: ratified or implemented only", () => {
    const fm = (s: string) => `---\nversion: 1\n${s}\n---\nbody\n`;
    expect(isSignedDoc(fm("status: ready-to-implement\nratifiedBy: Alex"))).toBe(true);
    expect(isSignedDoc(fm("status: implemented"))).toBe(true);
    expect(isSignedDoc(fm("status: ready-to-implement"))).toBe(false);
    expect(isSignedDoc(fm("status: draft\nshippedVersion: 1"))).toBe(false);
    expect(isSignedDoc(fm("status: reviewed"))).toBe(false);
  });
});

// GH #236's queue: the READ side is kept for one release so 1.16.x state files still drain.
const ITEM = { question: "retry policy", sliceKey: "pay", targetVersion: 2, until: 2, on: "2026-10-12", by: "Alex", decision: "fail fast (no retries)" };
const BULLET = "- retry policy (from slice pay, queued for pay@v2, until v2, 2026-10-12, by Alex; decision: fail fast (no retries))";

describe("the 1.16 queue's read side (pure, kept for leftovers)", () => {
  it("the queued bullet still parses, filters, drains and injects", () => {
    expect(queuedBullet(ITEM)).toBe(BULLET);
    expect(parseQueuedBullet(BULLET)).toEqual(ITEM);
    expect(parseQueuedBullet("- retry policy (from slice pay, deferred to v2)")).toBeNull();
    expect(queuedItems([BULLET, queuedBullet({ ...ITEM, sliceKey: "ship" })].join("\n"), "pay", 2)).toEqual([ITEM]);
    const r = drainQueueInState(`## Open questions / parking lot\r\n${BULLET}\r\n`, "pay", 2);
    expect(r).toEqual({ count: 1, content: "## Open questions / parking lot\r\n- retry policy (from slice pay, deferred to v2)\r\n" });
    const once = injectQueuedQuestions("# Slice\n", [ITEM]);
    expect(once.content).toBe("# Slice\n\n## Open Questions\n\n- [ ] retry policy — v1: fail fast (no retries) (queued 2026-10-12, Alex)\n");
    expect(injectQueuedQuestions(once.content, [ITEM]).count).toBe(0);
  });
});

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const STATE = "# State\n\n## Decisions log\n<!-- c -->\n- 2026-01-01: old — why\n\n## Open questions / parking lot\n<!-- c -->\n\n## Slice inventory\n";
const REVIEWED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";

describe("lifecycle walk: ratify → defer → ready → revise / mark-implemented (GH #253, CLI, real git)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const statePath = () => join(dir, ".event-modeling.md");
  const read = (p: string) => readFileSync(p, "utf8");
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);
  const ratify = () => em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02"], dir);
  const defer = (...extra: string[]) =>
    em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v2", "--decision", "fail fast (no retries)", "--by", "Alex", "--on", "2026-10-12", ...extra], dir);
  const statusJson = () => JSON.parse(em(["status", "model.em", "--json"], dir).stdout);
  const exportDoc = () => JSON.parse(em(["export", "model.em", "--slice", "pay"], dir).stdout).slice.doc;
  const recordedHash = () => /ratifiedHash: (\S+)/.exec(read(docPath()))![1];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh253-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(docPath(), REVIEWED + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    writeFileSync(statePath(), STATE);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed");
    const r = ratify();
    if (r.status !== 0) throw new Error(`fixture ratify failed: ${r.stderr}`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ratify records the 1.17-scope hash; defer on the ratified doc writes the deferred item, hash and readiness unchanged", () => {
    expect(recordedHash()).toBe(sliceDocBodyHash(read(docPath())));
    expect(ready().status).toBe(0);
    const hashBefore = recordedHash();
    const d = defer();
    expect(d.stderr).toBe("");
    expect(d.status).toBe(0);
    expect(d.stdout).toBe("deferred: slices/pay.md (retry policy → v2) — appended to the signed doc's Open Questions, outside ratifiedHash\n");
    const doc = read(docPath());
    expect(doc).toContain(`## Open Questions\n\n${DEFERRED}\n\n## Notes`);
    expect(doc).toContain("status: ready-to-implement\n");
    expect(recordedHash()).toBe(hashBefore);
    expect(ready().status).toBe(0);
    // The same mirror a draft-doc defer writes — no queue bullet anywhere.
    const state = read(statePath());
    expect(state).toContain("- retry policy (from slice pay, deferred to v2)");
    expect(state).toContain('- 2026-10-12: deferred "retry policy" on pay to v2 — v1: fail fast (no retries) — by Alex');
    expect(state).not.toContain("queued for");
    // ratify's own same-sign-off re-run still reads the doc as intact.
    expect(ratify()).toMatchObject({ status: 0, stdout: expect.stringContaining("already ratified") });
  });

  it("on a draft doc the parking lot and Decisions log carry the matched item's full text, not the substring (GH #283)", () => {
    writeFileSync(docPath(), REVIEWED + BODY.replace("## Open Questions\n", "## Open Questions\n\n- [ ] What is the retry policy for failed charges?\n"));
    const d = defer();
    expect(d.stderr).toBe("");
    expect(d.status).toBe(0);
    const state = read(statePath());
    expect(state).toContain("- What is the retry policy for failed charges? (from slice pay, deferred to v2)");
    expect(state).toContain('- 2026-10-12: deferred "What is the retry policy for failed charges?" on pay to v2 — v1: fail fast (no retries) — by Alex');
    expect(state).not.toContain("- retry policy (from slice");
  });

  it("a second identical run is a no-op", () => {
    defer();
    const before = [read(docPath()), read(statePath())];
    const d = defer();
    expect(d.status).toBe(0);
    expect(d.stdout).toBe("already deferred (no-op): slices/pay.md\n");
    expect([read(docPath()), read(statePath())]).toEqual(before);
  });

  it("keeps the --until / --decision validation, writing nothing", () => {
    const before = read(docPath());
    const d = em(["slice", "defer", "model.em", "pay", "q", "--until", "v1", "--decision", "x"], dir);
    expect(d.status).toBe(1);
    expect(d.stderr).toContain("--until v1 must be greater than the doc's current version v1");
    expect(read(docPath())).toBe(before);
    expect(read(statePath())).toBe(STATE);
  });

  it("em status and em export count the deferral as work waiting on a later version", () => {
    expect(exportDoc().queuedForNext).toBe(0);
    expect(statusJson().issues.queuedQuestions).toBe(0);
    defer();
    expect(exportDoc().queuedForNext).toBe(1);
    expect(statusJson().issues.queuedQuestions).toBe(1);
    expect(em(["status", "model.em"], dir).stdout).toContain("1 deferred to a later version");
    const full = JSON.parse(em(["export", "model.em"], dir).stdout);
    expect(full.schemaVersion).toBe("1.19");
    expect(full.model.slices[0].doc.queuedForNext).toBe(1);
  });

  it("a hand-added unchecked question on the ratified doc still fails readiness on the hash", () => {
    writeFileSync(docPath(), read(docPath()).replace("## Open Questions\n", "## Open Questions\n\n- [ ] sneaked in\n"));
    const r = em(["validate", "model.em", "--slice-ready", "pay", "--json"], dir);
    const codes = JSON.parse(r.stdout).diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain("slice-ready-body-changed-since-ratification");
    expect(codes).toContain("slice-ready-open-questions-unchecked");
    // And defer refuses to build on a doc that already fails its hash.
    const d = defer();
    expect(d.status).toBe(1);
    expect(d.stderr).toContain("body no longer matches ratifiedHash");
  });

  it("revise still refuses without --withdraw (pointing at defer); --withdraw reopens the deferred item in v2", () => {
    defer();
    const before = [read(docPath()), read(statePath())];
    const refused = em(["slice", "revise", "model.em", "pay"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("defer it instead");
    expect([read(docPath()), read(statePath())]).toEqual(before);
    const r = em(["slice", "revise", "model.em", "pay", "--withdraw"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ratification of v1 withdrawn (never shipped); v2 opened as draft");
    expect(r.stdout).toContain("re-opened 1 deferred question(s)");
    const doc = read(docPath());
    expect(doc).toContain("status: draft\nversion: 2\n");
    expect(doc).not.toContain("ratifiedHash:");
    expect(doc).toContain("## Open Questions\n\n- [ ] retry policy\n");
    expect(exportDoc().queuedForNext).toBe(0);
  });

  it("mark-implemented opens v2 as a draft with the deferred item reopened; a shipped doc takes a further deferral too", () => {
    defer();
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    expect(m.status).toBe(0);
    expect(m.stdout).toContain("opened draft v2: slices/pay.md — v1 stays shipped");
    expect(read(docPath())).toContain("shippedVersion: 1\n");
    expect(read(docPath())).toContain("- [ ] retry policy\n");
  });

  it("GH #284: a v2 ratified over a shipped v1 says v1 stays shipped on revise and on revise --withdraw --keep-version", () => {
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    expect(m.status).toBe(0);
    expect(read(docPath())).toContain("shippedVersion: 1\n");
    expect(em(["slice", "revise", "model.em", "pay"], dir).status).toBe(0); // opens the v2 draft over the shipped v1
    // Hand-write the review (as the fixture does), commit it, then ratify v2 over the shipped v1.
    writeFileSync(
      docPath(),
      read(docPath()).replace("status: draft\n", "status: reviewed\nreviewedBy: Sam\nreviewedOn: 2026-10-14\n"),
    );
    git(dir, "add", "slices/pay.md");
    git(dir, "commit", "-q", "-m", "v2 reviewed");
    const r2 = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-15"], dir);
    expect(r2.status).toBe(0);
    const ratifiedV2 = read(docPath());
    expect(ratifiedV2).toContain("version: 2\n");
    const plain = em(["slice", "revise", "model.em", "pay"], dir);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("ratification of v2 withdrawn; v1 stays shipped; v3 opened as draft");
    expect(plain.stdout).not.toContain("never shipped");
    // Same ratified v2 again, now with --keep-version.
    writeFileSync(docPath(), ratifiedV2);
    const kept = em(["slice", "revise", "model.em", "pay", "--withdraw", "--keep-version"], dir);
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain("ratification of v2 withdrawn; v1 stays shipped; reopened as draft at the same version (--keep-version)");
    expect(kept.stdout).not.toContain("never shipped");
  });

  it("a shipped doc (status: implemented, nothing deferred) takes a deferral in its body, outside the hash", () => {
    em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7"], dir);
    expect(read(docPath())).toContain("status: implemented\n");
    const hash = recordedHash();
    const d = defer("--until", "v3");
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("appended to the signed doc's Open Questions, outside ratifiedHash");
    expect(read(docPath())).toContain("- [x] retry policy — v1: fail fast (no retries); deferred to v3 (2026-10-12, Alex)\n");
    expect(recordedHash()).toBe(hash);
    expect(ratifiedHashScope(read(docPath()), hash)).toBe("current");
    expect(exportDoc().queuedForNext).toBe(1);
    // revise opens v2; the v3 deferral rides along as the ordinary checked deferral.
    expect(em(["slice", "revise", "model.em", "pay"], dir).status).toBe(0);
    expect(read(docPath())).toContain("- [x] retry policy — v1: fail fast (no retries); deferred to v3 (2026-10-12, Alex)\n");
  });

  it("defer --from-issue on the ratified doc: deferred item in the body, issue clause removed, hash unchanged, idempotent", () => {
    writeFileSync(join(dir, "model.em"), MODEL.replace("event Paid", 'event Paid issue "Is Paid final?"'));
    const hash = recordedHash();
    const d = em(["slice", "defer", "model.em", "pay", "--from-issue", "final", "--until", "v2", "--decision", "later", "--on", "2026-10-12"], dir);
    expect(d.status).toBe(0);
    expect(d.stdout).toContain('deferred: slices/pay.md (issue "Is Paid final?" → v2; issue clause removed from model.em:4) — appended to the signed doc\'s Open Questions');
    expect(read(docPath())).toContain("- [x] Is Paid final? — v1: later; deferred to v2 (2026-10-12)\n");
    expect(read(join(dir, "model.em"))).not.toContain("issue");
    expect(recordedHash()).toBe(hash);
    expect(ready().status).toBe(0);
    const again = em(["slice", "defer", "model.em", "pay", "--from-issue", "final", "--until", "v2", "--decision", "later", "--on", "2026-10-12"], dir);
    expect(again.stdout).toBe("already deferred (no-op): slices/pay.md\n");
  });

  it("a pre-1.17 whole-body hash is accepted as intact, and defer re-stamps it on first touch", () => {
    const legacy = sliceDocLegacyBodyHash(read(docPath()));
    writeFileSync(docPath(), read(docPath()).replace(/ratifiedHash: \S+/, `ratifiedHash: ${legacy}`));
    git(dir, "commit", "-qam", "legacy stamp");
    expect(ready().status).toBe(0);
    expect(ratify()).toMatchObject({ status: 0, stdout: expect.stringContaining("already ratified") });
    const d = defer();
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("ratifiedHash re-stamped to the 1.17 scope (body unchanged)");
    const doc = read(docPath());
    expect(doc).toContain(DEFERRED);
    expect(recordedHash()).not.toBe(legacy);
    expect(ratifiedHashScope(doc, recordedHash())).toBe("current");
    expect(ready().status).toBe(0);
    expect(defer().stdout).toBe("already deferred (no-op): slices/pay.md\n");
  });

  it("a no-op re-run on a legacy-scope doc leaves the old stamp alone (migration rides on a real write only)", () => {
    defer();
    const legacy = sliceDocLegacyBodyHash(read(docPath()));
    writeFileSync(docPath(), read(docPath()).replace(/ratifiedHash: \S+/, `ratifiedHash: ${legacy}`));
    const before = read(docPath());
    expect(defer().stdout).toBe("already deferred (no-op): slices/pay.md\n");
    expect(read(docPath())).toBe(before);
  });

  it("on a draft doc, defer still edits the existing item and never appends (unchanged behavior)", () => {
    em(["slice", "revise", "model.em", "pay", "--withdraw"], dir); // now a v2 draft
    const none = defer("--until", "v3");
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('no unchecked Open Question matching "retry policy"');
    writeFileSync(docPath(), read(docPath()).replace("## Open Questions\n", "## Open Questions\n\n- [ ] retry policy?\n"));
    const d = defer("--until", "v3");
    expect(d.stdout).toBe("deferred: slices/pay.md (retry policy → v3)\n");
    expect(read(docPath())).toContain("- [x] retry policy? — v2: fail fast (no retries); deferred to v3");
  });
});

describe("lifecycle walk: a 1.17.0 model upgraded to 1.18.0 (GH #290, CLI, real git)", () => {
  let dir: string;
  const exportShape = () => {
    const doc = JSON.parse(em(["export", "orders.em"], dir).stdout);
    const slices = doc.model.slices as Array<{ key: string; continuationOf: string | null; alsoReads: unknown }>;
    return { count: slices.length, shape: slices.map((s) => ({ key: s.key, continuationOf: s.continuationOf, alsoReads: s.alsoReads })) };
  };
  const upgradeCommits = () => git(dir, "log", "--format=%s").split("\n").filter((l) => l.startsWith("em upgrade:"));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh290-e2e-"));
    writeModel117(dir, { stage2: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "em test"); // CI runners have no global identity; `em upgrade --apply` commits
    git(dir, "config", "user.email", "em-test@example.com");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "1.17 model");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("em upgrade --apply takes every step, one commit each, and the model validates clean with the same read-model facts", () => {
    const before = exportShape();
    expect(before.count).toBe(10);
    const facts = (e: ReturnType<typeof exportShape>) => ({
      continuationOf: e.shape.map((s) => s.continuationOf).filter((c) => c !== null).sort(),
      // the events each read model also reads (the instance's slice, `atSlice`, is what the rewrite moves)
      alsoReads: e.shape.filter((s) => JSON.stringify(s.alsoReads) !== "[]").map((s) => [s.key, (s.alsoReads as Array<{ event: string }>).map((r) => r.event)]),
    });
    expect(facts(before).continuationOf).toEqual(["orders", "shipments"]);
    const ALL = ["collapse-alternative-events", "fold-continuations", "view-doc-sources-stale", "slice-index-stale", "parking-lot-fragments"];
    const dry = em(["upgrade", "orders.em"], dir);
    for (const id of ALL) expect(dry.stdout).toContain(`[x] ${id}`);

    const applied = em(["upgrade", "orders.em", "--apply"], dir);
    expect(applied.status, applied.stderr).toBe(0);
    for (const id of ALL) {
      expect(upgradeCommits().filter((l) => l.startsWith(`em upgrade: ${id}`))).toHaveLength(1);
    }
    expect(applied.stdout).toContain("Shape (em validate --shape, advisory):");
    expect(applied.stdout).toContain("shape-accepted:");
    expect(existsSync(join(dir, "shape.waive"))).toBe(false);
    const v = em(["validate", "orders.em"], dir);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    const after = exportShape();
    expect(after.count).toBe(before.count - 1); // the two cancel columns became one slice; the hand-named continuation became the synthesized column
    expect(facts(after)).toEqual(facts(before)); // identical continuationOf targets and alsoReads
    expect(after.shape.map((s) => s.key)).toContain("ship-order--again");
    expect(readFileSync(join(dir, "orders.em"), "utf8")).toContain("event Order Cancelled By Customer | Order Cancelled By Timeout @Sales");
    expect(readFileSync(join(dir, "slices", "orders.md"), "utf8")).toContain('"Order Placed Manually" (via "Orders manual")');
    expect(readFileSync(join(dir, ".event-modeling.md"), "utf8")).toContain("- Retry policy (from slice place-order, deferred to v2)");
    const sync = em(["slice", "sync", "orders.em", "--check"], dir);
    expect(sync.status, sync.stdout).toBe(0);
    expect(em(["slice", "index", "orders.em", "--check"], dir).status).toBe(0);

    const commits = upgradeCommits().length;
    expect(em(["upgrade", "orders.em", "--apply"], dir).status).toBe(0);
    expect(upgradeCommits()).toHaveLength(commits);
  });

  it("a ratified doc with a stale view region is left byte-for-byte alone and its hash still verifies after --apply", () => {
    const docPath = join(dir, "slices", "orders.md");
    const plain = readFileSync(docPath, "utf8");
    const withHash = (h: string) => plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${h}`);
    writeFileSync(docPath, withHash(sliceDocBodyHash(plain)));
    git(dir, "add", "slices/orders.md");
    git(dir, "commit", "-q", "-m", "ratify orders");
    const signedBytes = readFileSync(docPath, "utf8");
    expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(0);

    const dry = em(["upgrade", "orders.em"], dir);
    expect(dry.stdout).toContain("[ ] view-doc-sources-stale");
    expect(dry.stdout).toContain("view-doc-sources-stale-signed");
    const applied = em(["upgrade", "orders.em", "--apply"], dir);
    expect(applied.status, applied.stderr).toBe(0);
    expect(upgradeCommits().some((l) => l.startsWith("em upgrade: view-doc-sources-stale"))).toBe(false);
    expect(readFileSync(docPath, "utf8")).toBe(signedBytes);
    const hash = /ratifiedHash: (\S+)/.exec(signedBytes)![1];
    expect(ratifiedHashScope(signedBytes, hash)).toBe("current");
    expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(0);
    expect(em(["validate", "orders.em", "--slice-ready", "orders"], dir).stdout).not.toContain("slice-ready-ratified-hash-mismatch");
  });

  it("em storyline suggest prints a patch that git apply accepts and never writes the model", () => {
    const r = em(["storyline", "suggest", "orders.em"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('+storyline "Place" source "docs/orders.md#place" {');
    expect(git(dir, "status", "--porcelain")).toBe("");
    writeFileSync(join(dir, "s.patch"), r.stdout);
    git(dir, "apply", "s.patch");
    expect(readFileSync(join(dir, "orders.em"), "utf8")).toContain('storyline "Place"');
    expect(em(["validate", "orders.em"], dir).status).toBe(0);
  });
});
