// SPDX-License-Identifier: MIT
// MIL-268: the engagement file's pure read/splice layer (src/cli/engagementFile.ts) — render,
// strict parse, one-line entry splice, status splice, Ledger-region regeneration, and that every
// splice keeps the file's own line ending and every other byte.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngagementFile,
  buildLedgerLines,
  formatSliceEntryLine,
  parseEngagementFile,
  readOpenEngagements,
  renderEngagementFile,
  spliceContextList,
  spliceLedger,
  spliceSliceEntry,
  spliceStatus,
  validateContextPaths,
} from "../src/cli/engagementFile.js";
import { ENGAGEMENT_SCHEMA_VERSION } from "../src/emit/engagementJson.js";

const FM: EngagementFile = {
  engagementSchemaVersion: ENGAGEMENT_SCHEMA_VERSION,
  slug: "loans",
  model: "../a.em",
  created: "2026-10-08",
  createdBy: "Alex Rivera",
  tracking: null,
  prTitle: null,
  context: [],
  parallel: 3,
  status: "open",
  slices: [
    { key: "a-view", state: "planned", branch: null, base: null, pr: null },
    { key: "b-view", state: "planned", branch: null, base: null, pr: null },
  ],
};
const FACTS = new Map([
  ["a-view", { pattern: "state-view", docStatus: "ready-to-implement" }],
  ["b-view", { pattern: "translation", docStatus: null }],
]);

const render = () => renderEngagementFile(FM, buildLedgerLines(FM.slices, FACTS));

describe("renderEngagementFile", () => {
  it("writes the exact frontmatter, title and Ledger region", () => {
    expect(render()).toBe(
      [
        "---",
        'engagementSchemaVersion: "1.3"',
        "slug: loans",
        'model: "../a.em"',
        "created: 2026-10-08",
        'createdBy: "Alex Rivera"',
        "parallel: 3",
        "status: open",
        "slices:",
        "  - {key: a-view, state: planned, branch: null, base: null, pr: null}",
        "  - {key: b-view, state: planned, branch: null, base: null, pr: null}",
        "---",
        "# Engagement: loans",
        "",
        "Written by `em engagement new` and updated only by `em engagement set` / `em engagement close` —",
        "never hand-edit the frontmatter `slices:` entries or the Ledger table (see docs/engagement-schema.md).",
        "",
        "## Ledger",
        "",
        "<!-- GENERATED:em-engagement-ledger:start -->",
        "| Slice | Pattern | Doc status | State | Branch | Base | PR |",
        "|---|---|---|---|---|---|---|",
        "| `a-view` | state-view | ready-to-implement | planned | — | — | — |",
        "| `b-view` | translation | — | planned | — | — | — |",
        "<!-- GENERATED:em-engagement-ledger:end -->",
        "",
      ].join("\n"),
    );
  });

  it("round-trips through the strict parser", () => {
    const parsed = parseEngagementFile(render());
    expect(parsed).toEqual({ ok: true, file: FM });
  });
});

describe("parseEngagementFile refusals", () => {
  it.each([
    ["no fence", "# nothing\n", "no frontmatter (expected a leading --- fence)"],
    ["no model", '---\nengagementSchemaVersion: "1.0"\nstatus: open\n---\n', "model must name the model file (path relative to the engagement file)"],
    ["wrong version", '---\nengagementSchemaVersion: "9.9"\n---\n', 'unsupported engagementSchemaVersion "9.9" (this em reads "1.0", "1.1", "1.2" or "1.3")'],
    ["bad status", '---\nengagementSchemaVersion: "1.0"\nmodel: "../a.em"\nstatus: done\n---\n', 'status must be open or closed, got "done"'],
    ["bad state", '---\nengagementSchemaVersion: "1.0"\nmodel: "../a.em"\nstatus: open\nparallel: 2\nslices:\n  - {key: a, state: nope}\n---\n', 'slice "a" has an unknown state "nope"'],
    [
      "context not a list",
      '---\nengagementSchemaVersion: "1.3"\nmodel: "../a.em"\nstatus: open\nparallel: 2\ncontext: "a.md"\nslices: []\n---\n',
      "context must be a list of repo-relative paths",
    ],
    [
      "context has an empty entry",
      '---\nengagementSchemaVersion: "1.3"\nmodel: "../a.em"\nstatus: open\nparallel: 2\ncontext: ["a.md", "  "]\nslices: []\n---\n',
      "every context entry must be a non-empty string (a repo-relative path)",
    ],
  ])("%s", (_name, text, message) => {
    expect(parseEngagementFile(text)).toEqual({ ok: false, message });
  });
});

// GH #455: `context:` — present, absent, and a hand-edited version bump (the same legality
// `prTitle` established at 1.2).
describe("context: (GH #455)", () => {
  it("parses a present list and defaults to [] when absent", () => {
    const text = '---\nengagementSchemaVersion: "1.3"\nmodel: "../a.em"\nstatus: open\nparallel: 2\ncontext: ["docs/constitution.md", "docs/nfr/latency.md"]\nslices: []\n---\n';
    const parsed = parseEngagementFile(text);
    expect(parsed.ok && parsed.file.context).toEqual(["docs/constitution.md", "docs/nfr/latency.md"]);
    const without = parseEngagementFile(text.replace('context: ["docs/constitution.md", "docs/nfr/latency.md"]\n', ""));
    expect(without.ok && without.file.context).toEqual([]);
  });

  it('a 1.1 file with a hand-added context: line and a hand-bumped engagementSchemaVersion: "1.3" reads (no --force rewrite needed, mirrors prTitle\'s 1.2 precedent)', () => {
    const v11 = '---\nengagementSchemaVersion: "1.1"\nslug: loans\nmodel: "../a.em"\ncreated: 2026-10-08\ncreatedBy: null\nparallel: 3\nstatus: open\nslices: []\n---\n';
    const bumped = v11.replace('engagementSchemaVersion: "1.1"', 'engagementSchemaVersion: "1.3"').replace("parallel: 3", 'context: ["docs/constitution.md"]\nparallel: 3');
    const parsed = parseEngagementFile(bumped);
    expect(parsed.ok && parsed.file.context).toEqual(["docs/constitution.md"]);
    expect(parsed.ok && parsed.file.engagementSchemaVersion).toBe("1.3");
  });
});

describe("validateContextPaths", () => {
  it("accepts non-empty single-line paths and rejects blank or multi-line ones", () => {
    expect(validateContextPaths(["a.md", "docs/b.md"])).toBeNull();
    expect(validateContextPaths([])).toBeNull();
    expect(validateContextPaths(["a.md", ""])).toBe("--context-doc must be a non-empty path");
    expect(validateContextPaths(["a.md", "   "])).toBe("--context-doc must be a non-empty path");
    expect(validateContextPaths(["a\nb.md"])).toBe("--context-doc must be a single line (no newlines)");
  });
});

describe("spliceContextList", () => {
  it("inserts a new context: line right before parallel: when none exists (FM has no context by default)", () => {
    const base = render();
    expect(base).not.toContain("context:");
    const next = spliceContextList(base, ["docs/constitution.md", "docs/nfr/latency.md"])!;
    expect(next).toContain('context: ["docs/constitution.md", "docs/nfr/latency.md"]\nparallel: 3');
    const parsed = parseEngagementFile(next);
    expect(parsed.ok && parsed.file.context).toEqual(["docs/constitution.md", "docs/nfr/latency.md"]);
    // every other byte is unchanged
    expect(next.replace('context: ["docs/constitution.md", "docs/nfr/latency.md"]\n', "")).toBe(base);
  });

  it("replaces an existing context: line's value only", () => {
    const withCtx = spliceContextList(render(), ["a.md"])!;
    const next = spliceContextList(withCtx, ["b.md", "c.md"])!;
    expect(next).toContain('context: ["b.md", "c.md"]');
    expect(next.replace('context: ["b.md", "c.md"]', 'context: ["a.md"]')).toBe(withCtx);
  });

  it("is a no-op when context is empty and no context: line exists", () => {
    const text = render();
    expect(spliceContextList(text, [])).toBe(text);
  });

  it("preserves a CRLF file's line endings when inserting", () => {
    const crlf = render().replace(/\n/g, "\r\n");
    const next = spliceContextList(crlf, ["a.md"])!;
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("splices", () => {
  it("spliceSliceEntry replaces only that slice's line; JSON-quoted strings survive URLs and colons", () => {
    const text = render();
    const entry = { key: "b-view", state: "held" as const, branch: "impl/b-view", base: "impl/a-view", pr: "https://example.test/pr/7?x=a:b", heldBy: "human" as const };
    const next = spliceSliceEntry(text, entry)!;
    expect(next.replace(formatSliceEntryLine(entry), formatSliceEntryLine(FM.slices[1]))).toBe(text);
    const parsed = parseEngagementFile(next);
    expect(parsed.ok && parsed.file.slices[1]).toEqual(entry);
  });

  it("spliceSliceEntry returns null for an unknown key", () => {
    expect(spliceSliceEntry(render(), { key: "zzz", state: "planned", branch: null, base: null, pr: null })).toBeNull();
  });

  it("spliceStatus flips only the status line", () => {
    const text = render();
    expect(spliceStatus(text, "closed")).toBe(text.replace("status: open", "status: closed"));
  });

  it("spliceLedger regenerates the region and leaves the rest byte-identical", () => {
    const text = render();
    const next = spliceLedger(text, ["| x |"])!;
    expect(next).toContain("<!-- GENERATED:em-engagement-ledger:start -->\n| x |\n<!-- GENERATED:em-engagement-ledger:end -->");
    expect(next.split("<!-- GENERATED")[0]).toBe(text.split("<!-- GENERATED")[0]);
    expect(spliceLedger("no markers", ["x"])).toBeNull();
  });

  it("every splice preserves a CRLF file's line endings", () => {
    const crlf = render().replace(/\n/g, "\r\n");
    const entry = { key: "a-view", state: "building" as const, branch: "impl/a-view", base: "main", pr: null };
    let next = spliceSliceEntry(crlf, entry)!;
    next = spliceLedger(next, buildLedgerLines([entry, FM.slices[1]], FACTS))!;
    next = spliceStatus(next, "closed")!;
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
    expect(next.split("\r\n").length).toBe(crlf.split("\r\n").length);
    const parsed = parseEngagementFile(next);
    expect(parsed.ok && parsed.file.slices[0]).toEqual(entry);
    expect(parsed.ok && parsed.file.status).toBe("closed");
  });
});

describe("readOpenEngagements", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-engagement-file-"));
    mkdirSync(join(dir, "engagements"));
    writeFileSync(join(dir, "engagements", "zeta.md"), render().replace("slug: loans", "slug: zeta"));
    writeFileSync(join(dir, "engagements", "alpha.md"), render());
    writeFileSync(join(dir, "engagements", "done.md"), render().replace("status: open", "status: closed"));
    writeFileSync(join(dir, "engagements", "broken.md"), "not an engagement\n");
    writeFileSync(join(dir, "engagements", "other-model.md"), render().replace('model: "../a.em"', 'model: "../other.em"'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("counts open engagements beside the model, sorted, skipping closed and unparseable files; one scan per directory; only the input models' own", () => {
    expect(readOpenEngagements([join(dir, "a.em"), join(dir, "b.em")])).toEqual({ open: 2, slugs: ["alpha", "zeta"] });
    expect(readOpenEngagements([join(dir, "nowhere", "x.em")])).toEqual({ open: 0, slugs: [] });
  });
});
