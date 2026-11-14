// SPDX-License-Identifier: MIT
// GH #487: the per-section signature — ratify records `ratifiedSections:`, `classifySections`
// reports which authored sections moved since sign-off, the exclusions match `ratifiedHash`'s.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRatifyFrontmatter, resolveRatifiedIdentity } from "../src/cli/ratify.js";
import { applyReviseFrontmatter } from "../src/cli/revise.js";
import { keepSignature } from "../src/cli/sliceSync.js";
import { applyDeferOrAppend } from "../src/cli/defer.js";
import { insertLineAfterField } from "../src/cli/frontmatterSurgery.js";
import { parseSliceDoc, sliceDocBodyHash } from "../src/catalog/sliceDoc.js";
import {
  authoredSections,
  classifySections,
  decodeSectionHashes,
  DEFAULT_PROSE_HEADINGS,
  encodeSectionHashes,
  ratifiedSectionsValue,
  recordedSectionHashes,
} from "../src/catalog/sectionSignature.js";

const FM = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";
const REGION = (inner: string) =>
  `<!-- GENERATED:em-slice-command:start — generated from the model by \`em slice sync\`; do not hand-edit -->\n${inner}\n<!-- GENERATED:em-slice-command:end -->`;
const BODY = (opts: { intent?: string; scenario?: string; region?: string; consumed?: string; extra?: string } = {}) =>
  [
    "# Slice: Pay",
    "",
    "## Intent",
    opts.intent ?? "Charge the customer.",
    "",
    "## Trigger & Actor",
    "The shopper presses Pay.",
    "",
    "## Command / Input",
    REGION(opts.region ?? "| total | decimal |"),
    "",
    "## Read Model / View",
    "- **View:** `Orders`",
    `- **Consumed by:** ${opts.consumed ?? "the orders screen"}`,
    "  wrapped continuation",
    "- **Freshness:** real-time",
    "",
    "## Scenarios (Given / When / Then)",
    opts.scenario ?? "### Scenario: Happy path\n- **Given:**\n  - nothing\n- **When:**\n  - Pay\n- **Then:**\n  - Paid",
    "",
    "## Dependencies & Read Models Affected",
    "- upstream: none",
    ...(opts.extra ? ["", "## Mystery Notes", opts.extra] : []),
    "",
    "## Open Questions",
    "- [x] answered — yes",
    "",
  ].join("\n");
const DOC = (body = BODY()) => FM + body;

function ratified(doc = DOC()): string {
  const id = resolveRatifiedIdentity(null, "/nowhere", "slices/pay.md", doc);
  if (!id.ok) throw new Error(id.message);
  const r = applyRatifyFrontmatter(doc, "pay", "Alex", "2026-10-02", false, null, id.identity);
  if (!r.ok) throw new Error(r.message);
  return r.content;
}

const byHeading = (doc: string) => Object.fromEntries(classifySections(doc).map((s) => [s.heading, s]));

describe("authored sections (GH #487)", () => {
  it("splits at ## headings, lifts Consumed by bullets (with continuation) into their own section", () => {
    const secs = authoredSections(BODY());
    expect(secs.map((s) => s.heading)).toEqual([
      "(preamble)",
      "Intent",
      "Trigger & Actor",
      "Command / Input",
      "Read Model / View",
      "Scenarios (Given / When / Then)",
      "Dependencies & Read Models Affected",
      "Open Questions",
      "Consumed by",
    ]);
    expect(secs.find((s) => s.heading === "Consumed by")!.text).toBe("- **Consumed by:** the orders screen\n  wrapped continuation");
    expect(secs.find((s) => s.heading === "Read Model / View")!.text).not.toContain("Consumed by");
  });

  it("ignores ## inside fences and comments; labels repeated headings", () => {
    const secs = authoredSections("## A\n```\n## not\n```\n<!--\n## nor\n-->\n## A\nx\n");
    expect(secs.map((s) => s.heading)).toEqual(["A", "A (2)"]);
  });
});

describe("ratifiedSections storage", () => {
  it("encoding is sorted, deterministic, round-trips headings with special characters", () => {
    const m = new Map([
      ["Trigger & Actor", "aaaaaaaaaaaaaaaa"],
      ["A=b; #c 'd'", "bbbbbbbbbbbbbbbb"],
      ["Intent", "cccccccccccccccc"],
    ]);
    const enc = encodeSectionHashes(m);
    expect(enc).toBe("A%3Db%3B %23c %27d%27=bbbbbbbbbbbbbbbb; Intent=cccccccccccccccc; Trigger & Actor=aaaaaaaaaaaaaaaa");
    expect(decodeSectionHashes(enc)).toEqual(m);
    expect(decodeSectionHashes("garbage")).toBeNull();
    expect(decodeSectionHashes(null)).toBeNull();
  });

  it("ratify writes the line right after ratifiedHash, surgically, and survives the parser", () => {
    const out = ratified();
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.startsWith("ratifiedHash:"));
    expect(lines[i + 1]).toMatch(/^ratifiedSections: \(preamble\)=[0-9a-f]{16}; Command \/ Input=/);
    expect(out.slice(out.indexOf("\n---\n") + 5)).toBe(BODY());
    expect(recordedSectionHashes(out)!.size).toBe(9);
    // ratifiedHash is untouched in meaning and value.
    expect(parseSliceDoc(out).ratifiedHash).toBe(sliceDocBodyHash(DOC()));
  });

  it("re-ratifying replaces the line in place (no duplicate)", () => {
    const once = ratified();
    const stripped = once.replace("status: ready-to-implement", "status: reviewed").replace(/ratifiedBy: .*\nratifiedOn: .*\n/, "");
    const id = resolveRatifiedIdentity(null, "/x", "slices/pay.md", stripped);
    if (!id.ok) throw new Error("x");
    const r = applyRatifyFrontmatter(stripped, "pay", "Alex", "2026-10-03", false, null, id.identity);
    if (!r.ok) throw new Error(r.message);
    expect(r.content.match(/^ratifiedSections:/gm)).toHaveLength(1);
  });

  it("insertLineAfterField keeps CRLF and returns null without the anchor", () => {
    expect(insertLineAfterField("---\r\na: 1\r\nb: 2\r\n---\r\n", "a", "x: y")).toBe("---\r\na: 1\r\nx: y\r\nb: 2\r\n---\r\n");
    expect(insertLineAfterField("---\na: 1\n---\n", "zz", "x: y")).toBeNull();
  });
});

describe("classifySections", () => {
  it("returns changed: null for every section on a doc with no section hashes", () => {
    const r = classifySections(DOC());
    expect(r.length).toBe(9);
    expect(r.every((s) => s.changed === null)).toBe(true);
    expect(r.find((s) => s.heading === "Intent")!.class).toBe("prose");
    expect(r.find((s) => s.heading === "Scenarios (Given / When / Then)")!.class).toBe("behaviour");
  });

  it("a freshly ratified doc has nothing changed; classes follow the defaults", () => {
    const r = classifySections(ratified());
    expect(r.every((s) => s.changed === false)).toBe(true);
    const prose = r.filter((s) => s.class === "prose").map((s) => s.heading).sort();
    expect(prose).toEqual(["Consumed by", "Dependencies & Read Models Affected", "Intent", "Trigger & Actor"]);
    expect(DEFAULT_PROSE_HEADINGS).toContain("Intent");
  });

  it("flags only the edited section: prose edit, behaviour edit, consumed-by edit", () => {
    const base = ratified();
    const body = (b: string) => base.replace(BODY(), b);
    let s = byHeading(body(BODY({ intent: "Take the money." })));
    expect(s["Intent"]).toMatchObject({ class: "prose", changed: true });
    expect(Object.values(s).filter((x) => x.changed).length).toBe(1);
    s = byHeading(body(BODY({ scenario: "### Scenario: Other\n- **Given:**\n  - x\n- **When:**\n  - y\n- **Then:**\n  - z" })));
    expect(s["Scenarios (Given / When / Then)"]).toMatchObject({ class: "behaviour", changed: true });
    expect(Object.values(s).filter((x) => x.changed).length).toBe(1);
    s = byHeading(body(BODY({ consumed: "the dashboard" })));
    expect(s["Consumed by"]).toMatchObject({ class: "prose", changed: true });
    expect(s["Read Model / View"].changed).toBe(false);
  });

  it("an unrecognised heading is behaviour, a new one counts as changed, a removed one is listed changed", () => {
    const base = ratified();
    const added = byHeading(base.replace(BODY(), BODY({ extra: "hi" })));
    expect(added["Mystery Notes"]).toMatchObject({ class: "behaviour", changed: true });
    const removed = classifySections(base.replace("## Dependencies & Read Models Affected\n- upstream: none\n", ""));
    expect(removed.at(-1)).toEqual({ heading: "Dependencies & Read Models Affected", class: "prose", changed: true });
  });

  it("takes the prose list as a parameter", () => {
    const base = ratified();
    const edited = base.replace("Charge the customer.", "Other.");
    expect(classifySections(edited, ["Scenarios (Given / When / Then)"]).find((s) => s.heading === "Intent")).toMatchObject({ class: "behaviour", changed: true });
    expect(classifySections(edited, ["intent"]).find((s) => s.heading === "Intent")!.class).toBe("prose");
  });

  it("generated-region text and deferred Open Questions items are excluded, like ratifiedHash", () => {
    const base = ratified();
    const regen = base.replace("| total | decimal |", "| total | decimal |\n| tax | decimal |");
    expect(classifySections(regen).every((s) => s.changed === false)).toBe(true);
    const d = applyDeferOrAppend(base, "retry policy?", { until: "v2", decision: "fail fast", on: "2026-10-12", currentVersion: 1 });
    if (!d.ok) throw new Error(d.message);
    expect(d.content).not.toBe(base);
    expect(classifySections(d.content).every((s) => s.changed === false)).toBe(true);
    // a real edit to the answered history still counts
    expect(byHeading(base.replace("answered — yes", "answered — no"))["Open Questions"].changed).toBe(true);
  });

  it("deferring onto a doc with no Open Questions section adds no section", () => {
    const noOq = DOC(BODY().replace("## Open Questions\n- [x] answered — yes\n", ""));
    const base = ratified(noOq);
    const d = applyDeferOrAppend(base, "q?", { until: "v2", decision: "later", on: "2026-10-12", currentVersion: 1 });
    if (!d.ok) throw new Error(d.message);
    expect(d.content).toContain("## Open Questions");
    expect(classifySections(d.content).every((s) => s.changed === false)).toBe(true);
  });

  it("sync (keepSignature) leaves the section hashes alone", () => {
    const base = ratified();
    const next = base.replace("| total | decimal |", "| total | money |");
    const r = keepSignature(base, next);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(recordedSectionHashes(r.content)).toEqual(recordedSectionHashes(base));
      expect(classifySections(r.content).every((s) => s.changed === false)).toBe(true);
    }
  });

  it("revise clears the section hashes with the rest of the sign-off", () => {
    const r = applyReviseFrontmatter(ratified(), { withdraw: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).not.toContain("ratifiedSections");
      expect(classifySections(r.content).every((s) => s.changed === null)).toBe(true);
    }
  });

  it("ratifiedSectionsValue is stable for the same text", () => {
    expect(ratifiedSectionsValue(DOC())).toBe(ratifiedSectionsValue(DOC()));
  });
});

describe("shipped example docs", () => {
  it("parse into sections without throwing", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, "..", "examples", "order-fulfillment", "slices", "capture-payment.md"), "utf8");
    const r = classifySections(text);
    expect(r.length).toBeGreaterThan(3);
    expect(r.every((s) => s.changed === null)).toBe(true);
  });
});
