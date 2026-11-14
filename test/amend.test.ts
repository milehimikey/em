// SPDX-License-Identifier: MIT
// GH #488: `em slice amend` — re-sign a prose-only change to a signed slice doc in place. A pure
// suite over the frontmatter transition (applyAmendFrontmatter), then CLI tests that run the real
// binary in a real temporary git repository (the ref/uncommitted rules are git behaviour).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { applyAmendFrontmatter, AmendInputs } from "../src/cli/amend.js";
import { applyRatifyFrontmatter, resolveRatifiedIdentity } from "../src/cli/ratify.js";
import { SIGN_OFF_KEYS } from "../src/cli/revise.js";
import { parseSliceDoc, sliceDocBodyHash } from "../src/catalog/sliceDoc.js";
import { DEFAULT_PROSE_HEADINGS, proseHeadingsFor, ratifiedSectionsValue } from "../src/catalog/sectionSignature.js";

vi.setConfig({ testTimeout: 20_000 });

const FM = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";
const BODY = (intent = "Charge the customer.", behaviour = "| total | decimal |") =>
  `# Slice: Pay\n\n## Intent\n\n${intent}\n\n## Command / Input\n\n${behaviour}\n\n## Open Questions\n\n- [x] answered\n`;

/** A ratified (no-ref) doc, as `em slice ratify --no-ref` would leave it. */
function ratifiedDoc(body = BODY()): string {
  const raw = FM + body;
  const id = resolveRatifiedIdentity(null, "/nowhere", "slices/pay.md", raw);
  if (!id.ok) throw new Error(id.message);
  const r = applyRatifyFrontmatter(raw, "pay", "Alex", "2026-10-02", false, null, id.identity);
  if (!r.ok) throw new Error(r.message);
  return r.content;
}
const editBody = (doc: string, from: string, to: string) => {
  expect(doc).toContain(from);
  return doc.replace(from, to);
};
const inputs = (by = "Blair", on = "2026-11-13"): AmendInputs => ({
  sliceKey: "pay",
  by,
  on,
  identity: (raw) => resolveRatifiedIdentity(null, "/nowhere", "slices/pay.md", raw),
});
const amend = (doc: string, by?: string, on?: string) => applyAmendFrontmatter(doc, inputs(by, on));

describe("applyAmendFrontmatter (GH #488)", () => {
  it("a prose-only change re-stamps the hashes and records amendedBy/amendedOn, touching nothing else", () => {
    const signed = ratifiedDoc();
    const edited = editBody(signed, "Charge the customer.", "Charge the customer once.");
    const r = amend(edited);
    if (!r.ok) throw new Error(r.message);
    expect(r.changed).toBe(true);
    expect(r.changedProse).toEqual(["Intent"]);
    const doc = parseSliceDoc(r.content);
    expect(doc).toMatchObject({ status: "ready-to-implement", version: 1, ratifiedBy: "Alex", ratifiedOn: "2026-10-02", reviewedBy: "Sam", amendedBy: "Blair", amendedOn: "2026-11-13" });
    expect(doc.ratifiedHash).toBe(sliceDocBodyHash(r.content));
    expect(r.content).toContain(`ratifiedSections: ${ratifiedSectionsValue(r.content)}\namendedBy: Blair\namendedOn: 2026-11-13\n`);
    // Body byte-identical; frontmatter differs only in the three re-stamped/added line groups.
    expect(r.content.slice(r.content.indexOf("# Slice: Pay"))).toBe(edited.slice(edited.indexOf("# Slice: Pay")));
    const lines = (s: string) => s.slice(0, s.indexOf("# Slice: Pay")).split("\n");
    const before = new Set(lines(edited));
    const added = lines(r.content).filter((l) => !before.has(l));
    expect(added.map((l) => l.split(":")[0]).sort()).toEqual(["amendedBy", "amendedOn", "ratifiedHash", "ratifiedSections"]);
    expect(r.content).not.toContain("ratifiedRef:");
  });

  it("the latest amendment wins: an earlier amendedBy/amendedOn pair is replaced, not accumulated", () => {
    const first = amend(editBody(ratifiedDoc(), "Charge the customer.", "Charge once."), "Blair", "2026-11-13");
    if (!first.ok) throw new Error(first.message);
    const second = amend(editBody(first.content, "Charge once.", "Charge it once."), "Casey", "2026-11-14");
    if (!second.ok) throw new Error(second.message);
    expect(second.content.match(/^amendedBy:/gm)).toHaveLength(1);
    expect(second.content.match(/^amendedOn:/gm)).toHaveLength(1);
    expect(parseSliceDoc(second.content)).toMatchObject({ amendedBy: "Casey", amendedOn: "2026-11-14" });
  });

  it("an unchanged body is a no-op: content identical, changed false", () => {
    const signed = ratifiedDoc();
    expect(amend(signed)).toEqual({ ok: true, content: signed, changed: false, changedProse: [] });
  });

  it("a changed behaviour section is refused with the heading named, and so is an unknown heading", () => {
    const behaviour = amend(editBody(ratifiedDoc(), "| total | decimal |", "| total | money |"));
    expect(behaviour.ok).toBe(false);
    if (!behaviour.ok) {
      expect(behaviour.message).toContain('"Command / Input"');
      expect(behaviour.message).toContain("em slice revise");
      expect(behaviour.message).toContain("--withdraw");
    }
    const unknown = amend(ratifiedDoc() + "\n## Mystery Notes\n\nnew\n");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain('"Mystery Notes"');
  });

  it("a prose change alongside a behaviour change is refused whole (the prose heading is not blamed)", () => {
    let doc = editBody(ratifiedDoc(), "Charge the customer.", "Charge twice.");
    doc = editBody(doc, "| total | decimal |", "| total | money |");
    const r = amend(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('"Command / Input"');
      expect(r.message).not.toContain('"Intent"');
    }
  });

  it("a shipped doc's refusal points at revise without --withdraw", () => {
    const shipped = ratifiedDoc().replace("status: ready-to-implement", "status: implemented\nshippedVersion: 1");
    const r = amend(editBody(shipped, "| total | decimal |", "| total | money |"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("--withdraw");
  });

  it("a doc with no section hashes is refused, naming em upgrade", () => {
    const stripped = ratifiedDoc().replace(/^ratifiedSections: .*\n/m, "");
    const r = amend(editBody(stripped, "Charge the customer.", "Charge once."));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("em upgrade");
  });

  it("draft / reviewed docs are refused (just edit them); no sign-off or no ratifiedHash points at ratify", () => {
    const reviewed = amend(FM + BODY());
    expect(reviewed.ok).toBe(false);
    if (!reviewed.ok) expect(reviewed.message).toContain("just edit the doc");
    const draft = amend((FM + BODY()).replace("status: reviewed", "status: draft"));
    expect(draft.ok).toBe(false);
    const noHash = amend(ratifiedDoc().replace(/^ratifiedHash: .*\n/m, ""));
    expect(noHash.ok).toBe(false);
    if (!noHash.ok) expect(noHash.message).toContain("em slice ratify");
    const noSignoff = amend(ratifiedDoc().replace(/^ratifiedBy: .*\n/m, ""));
    expect(noSignoff.ok).toBe(false);
    if (!noSignoff.ok) expect(noSignoff.message).toContain("em slice ratify");
  });

  it("refuses a bad name, bad date and control characters", () => {
    const edited = editBody(ratifiedDoc(), "Charge the customer.", "Charge once.");
    expect(amend(edited, "  ").ok).toBe(false);
    expect(amend(edited, "Bl\nair").ok).toBe(false);
    expect(amend(edited, "Blair", "13/11/2026").ok).toBe(false);
  });

  it("keeps shipped*/conformed*/implementedIn/meaning keys and version untouched on a shipped doc", () => {
    const shipped = ratifiedDoc()
      .replace("status: ready-to-implement", "status: implemented\nimplementedIn: https://github.com/o/r/pull/1\nshippedVersion: 1\nshippedRef: abc1234\nshippedOn: 2026-10-05\nconformedVersion: 1\nmeaningConfirmed: true");
    const r = amend(editBody(shipped, "Charge the customer.", "Charge once."));
    if (!r.ok) throw new Error(r.message);
    expect(parseSliceDoc(r.content)).toMatchObject({
      status: "implemented",
      version: 1,
      implementedIn: "https://github.com/o/r/pull/1",
      shippedVersion: 1,
      shippedRef: "abc1234",
      shippedOn: "2026-10-05",
      conformedVersion: 1,
      meaningConfirmed: true,
    });
  });

  it("a ref-less identity drops a stale ratifiedRef; a ref identity replaces it; a pre-1.15 shipped doc keeps it", () => {
    const withRef = ratifiedDoc().replace("ratifiedHash:", "ratifiedRef: 1111111111111111111111111111111111111111\nratifiedHash:");
    const edited = editBody(withRef, "Charge the customer.", "Charge once.");
    const dropped = amend(edited);
    if (!dropped.ok) throw new Error(dropped.message);
    expect(dropped.content).not.toContain("ratifiedRef:");
    const head = "2222222222222222222222222222222222222222";
    const replaced = applyAmendFrontmatter(edited, { ...inputs(), identity: (raw) => ({ ok: true, identity: { ref: head, hash: sliceDocBodyHash(raw), sections: ratifiedSectionsValue(raw) } }) });
    if (!replaced.ok) throw new Error(replaced.message);
    expect(replaced.content).toContain(`ratifiedRef: ${head}\n`);
    expect(replaced.content.match(/^ratifiedRef:/gm)).toHaveLength(1);
    const legacy = edited.replace("status: ready-to-implement", "status: implemented");
    const kept = applyAmendFrontmatter(legacy, { ...inputs(), identity: (raw) => ({ ok: true, identity: { ref: head, hash: sliceDocBodyHash(raw), sections: ratifiedSectionsValue(raw) } }) });
    if (!kept.ok) throw new Error(kept.message);
    expect(kept.content).toContain("ratifiedRef: 1111111111111111111111111111111111111111\n");
  });

  it("an identity failure (uncommitted doc) surfaces as the refusal", () => {
    const edited = editBody(ratifiedDoc(), "Charge the customer.", "Charge once.");
    const r = applyAmendFrontmatter(edited, { ...inputs(), identity: () => ({ ok: false, message: "x has uncommitted changes" }) });
    expect(r).toEqual({ ok: false, message: "x has uncommitted changes" });
  });

  it("preserves CRLF line endings", () => {
    const crlf = editBody(ratifiedDoc(), "Charge the customer.", "Charge once.").replace(/\n/g, "\r\n");
    const r = amend(crlf);
    if (!r.ok) throw new Error(r.message);
    expect(r.content).not.toMatch(/[^\r]\n/);
    expect(r.content).toContain("amendedBy: Blair\r\namendedOn: 2026-11-13\r\n");
  });

  it("amendedBy/amendedOn are sign-off keys: `em slice revise` clears them", () => {
    expect(SIGN_OFF_KEYS).toEqual(expect.arrayContaining(["amendedBy", "amendedOn"]));
  });
});

describe("proseHeadingsFor", () => {
  it("returns the default list when no em-policy.yaml declares one", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-prose-default-"));
    try {
      expect(proseHeadingsFor(dir)).toEqual(DEFAULT_PROSE_HEADINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns amendment.prose-sections from em-policy.yaml when declared (GH #493)", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-prose-policy-"));
    try {
      writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\namendment:\n  prose-sections:\n    - Intent\n');
      expect(proseHeadingsFor(dir)).toEqual(["Intent"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- CLI, real git ----

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

describe("em slice amend (CLI, real git)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const read = () => readFileSync(docPath(), "utf8");
  const write = (s: string) => writeFileSync(docPath(), s);
  const commit = (msg: string) => {
    git(dir, "add", "slices/pay.md");
    git(dir, "commit", "-q", "-m", msg);
  };
  const amendCli = (...extra: string[]) => em(["slice", "amend", "model.em", "pay", "--by", "Blair", "--on", "2026-11-13", ...extra], dir);
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh488-"));
    mkdirSync(join(dir, "slices"));
    write(FM + BODY());
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "model.em", "slices/pay.md");
    git(dir, "commit", "-q", "-m", "reviewed");
    const r = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02"], dir);
    expect(r.status, r.stderr).toBe(0);
    commit("ratified");
  });
  afterEach(() => rmTemp(dir));

  it("amends a prose-only change: slice-ready again, HEAD recorded, everything else kept", () => {
    write(editBody(read(), "Charge the customer.", "Charge the customer once."));
    commit("prose fix");
    const before = ready();
    expect(before.status).toBe(1);
    expect(before.stderr + before.stdout).toContain("slice-ready-body-changed-since-ratification");
    expect(before.stderr + before.stdout).toContain("em slice amend");
    const r = amendCli();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("amended: slices/pay.md (amendedBy: Blair, amendedOn: 2026-11-13; prose changed: Intent)\n");
    const doc = read();
    expect(parseSliceDoc(doc)).toMatchObject({ status: "ready-to-implement", version: 1, ratifiedBy: "Alex", ratifiedOn: "2026-10-02", reviewedBy: "Sam", amendedBy: "Blair", amendedOn: "2026-11-13" });
    expect(doc).toContain(`ratifiedRef: ${git(dir, "rev-parse", "HEAD")}\n`);
    expect(doc).toContain(`ratifiedHash: ${sliceDocBodyHash(doc)}\n`);
    expect(ready().status).toBe(0);
    // Idempotent: the amended body now matches, so a re-run is the no-op.
    commit("amended");
    expect(amendCli()).toMatchObject({ status: 0, stdout: "body matches ratifiedHash — nothing to amend (no-op): slices/pay.md\n" });
  });

  it("refuses a behaviour change, naming the heading, and leaves the file untouched", () => {
    write(editBody(editBody(read(), "| total | decimal |", "| total | money |"), "Charge the customer.", "Charge once."));
    commit("behaviour edit");
    const snapshot = read();
    const r = amendCli();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('behaviour section(s) changed since sign-off — "Command / Input"');
    expect(r.stderr).toContain("em slice revise");
    expect(r.stderr).toContain("--withdraw");
    expect(read()).toBe(snapshot);
  });

  it("an unchanged body is a no-op that says so (exit 0, file untouched)", () => {
    const snapshot = read();
    const r = amendCli();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("body matches ratifiedHash — nothing to amend (no-op): slices/pay.md\n");
    expect(read()).toBe(snapshot);
  });

  it("refuses a doc without section hashes, pointing at em upgrade", () => {
    write(read().replace(/^ratifiedSections: .*\n/m, ""));
    commit("pre-1.23 doc");
    write(editBody(read(), "Charge the customer.", "Charge once."));
    commit("prose fix");
    const snapshot = read();
    const r = amendCli();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em upgrade");
    expect(read()).toBe(snapshot);
  });

  it("refuses a draft/reviewed doc", () => {
    write(read().replace("status: ready-to-implement", "status: reviewed"));
    const r = amendCli();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("just edit the doc");
  });

  it("an uncommitted edit is refused like ratify; --no-ref amends with the hash only and drops ratifiedRef", () => {
    write(editBody(read(), "Charge the customer.", "Charge once."));
    const refused = amendCli();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("has uncommitted changes");
    expect(read()).not.toContain("amendedBy");
    const r = amendCli("--no-ref");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("— ratifiedHash only, no ratifiedRef (--no-ref)");
    const doc = read();
    expect(doc).toContain("amendedBy: Blair\n");
    expect(doc).not.toContain("ratifiedRef:");
    expect(ready().status).toBe(0);
  });

  it("amends a shipped doc in place at the shipped version, shipped record intact; revise then clears the amended keys", () => {
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    expect(m.status, m.stderr).toBe(0);
    commit("shipped");
    const shipped = parseSliceDoc(read());
    expect(shipped.status).toBe("implemented");
    write(editBody(read(), "Charge the customer.", "Charge the customer once."));
    commit("prose fix");
    const r = amendCli();
    expect(r.status, r.stderr).toBe(0);
    const doc = parseSliceDoc(read());
    expect(doc).toMatchObject({
      status: "implemented",
      version: 1,
      implementedIn: shipped.implementedIn,
      shippedVersion: shipped.shippedVersion,
      shippedRef: shipped.shippedRef,
      shippedOn: shipped.shippedOn,
      ratifiedBy: "Alex",
      amendedBy: "Blair",
    });
    expect(doc.ratifiedHash).toBe(sliceDocBodyHash(read()));
    commit("amended");

    const rev = em(["slice", "revise", "model.em", "pay"], dir);
    expect(rev.status, rev.stderr).toBe(0);
    const after = read();
    expect(after).not.toContain("amendedBy");
    expect(after).not.toContain("amendedOn");
    expect(parseSliceDoc(after)).toMatchObject({ status: "draft", version: 2, shippedVersion: 1 });
  });

  it("revise --withdraw on an amended, never-shipped doc clears the amended keys", () => {
    write(editBody(read(), "Charge the customer.", "Charge once."));
    commit("prose fix");
    expect(amendCli().status).toBe(0);
    expect(read()).toContain("amendedBy: Blair");
    commit("amended");
    const rev = em(["slice", "revise", "model.em", "pay", "--withdraw"], dir);
    expect(rev.status, rev.stderr).toBe(0);
    expect(read()).not.toContain("amended");
    expect(parseSliceDoc(read()).status).toBe("draft");
  });

  it("export --doc-json exposes amendedBy/amendedOn (null before any amendment)", () => {
    const before = JSON.parse(em(["export", "model.em", "--doc-json"], dir).stdout);
    expect(before.schemaVersion).toBe("1.2");
    expect(before.model.slices[0]).toMatchObject({ amendedBy: null, amendedOn: null });
    write(editBody(read(), "Charge the customer.", "Charge once."));
    commit("prose fix");
    expect(amendCli().status).toBe(0);
    const after = JSON.parse(em(["export", "model.em", "--doc-json"], dir).stdout);
    expect(after.model.slices[0]).toMatchObject({ amendedBy: "Blair", amendedOn: "2026-11-13" });
  });
});
