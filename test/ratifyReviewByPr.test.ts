// SPDX-License-Identifier: MIT
// GH #494: `review: pull-request` in em-policy.yaml — `em slice ratify` on a draft records the
// review (reviewedBy/reviewedOn) with the sign-off instead of refusing or writing `reviewSkipped:`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { applyRatifyFrontmatter } from "../src/cli/ratify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const doc = (status: string, extra = "", body = "body\n") =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: 1\n${extra}---\n${body}`;

describe("applyRatifyFrontmatter with review by pull request (pure)", () => {
  const run = (raw: string, by = "Alex", on = "2026-11-13", skip = false, pr = true) =>
    applyRatifyFrontmatter(raw, "s", by, on, skip, null, null, pr);

  it("draft: writes reviewedBy/reviewedOn after the sign-off lines, no reviewSkipped", () => {
    const r = run(doc("draft"));
    expect(r.ok && r.content).toBe(
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\n" +
        "ratifiedBy: Alex\nratifiedOn: 2026-11-13\nreviewedBy: Alex\nreviewedOn: 2026-11-13\nversion: 1\n---\nbody\n",
    );
    expect(r.ok && r.skippedReviewFrom).toBeNull();
    expect(r.ok && r.reviewRecorded).toBe(true);
    expect(r.ok && r.content).not.toContain("reviewSkipped");
  });

  it("draft with --skip-review under the policy: review recorded, no marker", () => {
    const r = run(doc("draft"), "Alex", "2026-11-13", true);
    expect(r.ok && r.skippedReviewFrom).toBeNull();
    expect(r.ok && r.content).not.toContain("reviewSkipped");
    expect(r.ok && r.reviewRecorded).toBe(true);
  });

  it("an unchecked Open Questions item refuses and names the missing --allow-open", () => {
    const r = run(doc("draft", "", "## Open Questions\n\n- [ ] Who pays?\n"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('1 unchecked Open Questions item(s) — first: "Who pays?"');
    expect(!r.ok && r.message).toContain("no --allow-open");
  });

  it("an already reviewed doc keeps its review and records nothing new", () => {
    const raw = doc("reviewed", "reviewedBy: Sam\nreviewedOn: 2026-11-01\n");
    const r = run(raw, "Alex");
    expect(r.ok && r.content).toContain("reviewedBy: Sam");
    expect(r.ok && r.content).toContain("reviewedOn: 2026-11-01");
    expect(r.ok && r.content).not.toContain("reviewedBy: Alex");
    expect(r.ok && r.reviewRecorded).toBeUndefined();
  });

  it("policy off: today's refusal and --skip-review marker are unchanged", () => {
    const refused = run(doc("draft"), "Alex", "2026-11-13", false, false);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("the review gate comes first");
    const skipped = run(doc("draft"), "Alex", "2026-11-13", true, false);
    expect(skipped.ok && skipped.content).toContain("reviewSkipped: draft");
    expect(skipped.ok && skipped.content).not.toContain("reviewedBy");
  });

  it("a non-draft, non-reviewed status still takes the review gate under the policy", () => {
    const r = run(doc("ready-to-implement", "ratifiedBy: Sam\nratifiedOn: 2026-11-01\n"), "Alex");
    expect(r.ok).toBe(false);
  });
});

const MODEL =
  'model "Shop"\n\n' +
  'slice "Alpha" {\n  command Do Alpha note "slices/alpha.md"\n  event Alpha Done\n}\n' +
  'slice "Beta" {\n  command Do Beta note "slices/beta.md"\n  event Beta Done\n}\n';

describe("em slice ratify under review: pull-request (CLI)", () => {
  let dir: string;
  const read = (k: string) => readFileSync(join(dir, "slices", `${k}.md`), "utf8");
  const write = (k: string, c: string) => writeFileSync(join(dir, "slices", `${k}.md`), c);
  const policy = (extra = "") => writeFileSync(join(dir, "em-policy.yaml"), `policySchemaVersion: "1.0"\nreview: pull-request\n${extra}`);
  const ratify = (...args: string[]) => em(["slice", "ratify", "m.em", ...args, "--by", "Alex", "--on", "2026-11-13"], dir);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-review-by-pr-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "m.em"), MODEL);
    write("alpha", doc("draft"));
    write("beta", doc("draft"));
  });
  afterEach(() => rmTemp(dir));

  it("policy on + draft: review and sign-off recorded, no marker, one notice", () => {
    policy();
    const r = ratify("alpha");
    expect(r.status).toBe(0);
    const text = read("alpha");
    expect(text).toContain("status: ready-to-implement");
    expect(text).toContain("reviewedBy: Alex\nreviewedOn: 2026-11-13\n");
    expect(text).not.toContain("reviewSkipped");
    const notices = r.stderr.split("\n").filter((l) => l.startsWith("notice:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("em-policy.yaml");
    expect(notices[0]).toContain("review: pull-request");
  });

  it("--skip-review under the policy: policy wins, a second notice says the flag was unnecessary", () => {
    policy();
    const r = ratify("alpha", "--skip-review");
    expect(r.status).toBe(0);
    expect(read("alpha")).not.toContain("reviewSkipped");
    expect(read("alpha")).toContain("reviewedBy: Alex");
    expect(r.stderr).toContain("--skip-review was unnecessary");
  });

  it("policy on + open question: refused, file untouched", () => {
    policy();
    const before = doc("draft", "", "## Open Questions\n\n- [ ] Who pays?\n");
    write("alpha", before);
    const r = ratify("alpha");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unchecked Open Questions");
    expect(r.stderr).toContain("no --allow-open");
    expect(read("alpha")).toBe(before);
  });

  it("policy on + already reviewed: the existing review is kept", () => {
    policy();
    write("alpha", doc("reviewed", "reviewedBy: Sam\nreviewedOn: 2026-11-01\n"));
    const r = ratify("alpha");
    expect(r.status).toBe(0);
    expect(read("alpha")).toContain("reviewedBy: Sam\nreviewedOn: 2026-11-01\n");
    expect(read("alpha")).not.toContain("reviewedBy: Alex");
    expect(r.stderr).not.toContain("review: pull-request");
  });

  it("policy off (no file): today's refusal, and --skip-review still marks the doc", () => {
    const refused = ratify("alpha");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("the review gate comes first");
    const skipped = ratify("alpha", "--skip-review");
    expect(skipped.status).toBe(0);
    expect(read("alpha")).toContain("reviewSkipped: draft");
    expect(read("alpha")).not.toContain("reviewedBy");
  });

  it("review: session behaves as no policy", () => {
    writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\nreview: session\n');
    expect(ratify("alpha").status).toBe(1);
  });

  it("a batch under the policy records every review; a bad slice refuses all, nothing written", () => {
    policy();
    const ok = em(["slice", "ratify", "m.em", "alpha", "beta", "--by", "Alex", "--on", "2026-11-13"], dir);
    expect(ok.status).toBe(0);
    expect(read("alpha")).toContain("reviewedBy: Alex");
    expect(read("beta")).toContain("reviewedBy: Alex");
    expect(read("beta")).not.toContain("reviewSkipped");
    expect(ok.stderr.match(/notice: .*em-policy\.yaml sets review/g)).toHaveLength(2);

    write("alpha", doc("draft"));
    const beta = doc("draft", "", "## Open Questions\n\n- [ ] open\n");
    write("beta", beta);
    const bad = em(["slice", "ratify", "m.em", "alpha", "beta", "--by", "Alex", "--on", "2026-11-13"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("nothing was written");
    expect(read("alpha")).toBe(doc("draft"));
    expect(read("beta")).toBe(beta);
  });

  it("a reviewers roster that excludes --by refuses the ratify (single and batch), nothing written", () => {
    policy("reviewers:\n  - name: Sam\n");
    const single = ratify("alpha");
    expect(single.status).toBe(1);
    expect(single.stderr).toContain("Alex");
    expect(read("alpha")).toBe(doc("draft"));
    const batch = em(["slice", "ratify", "m.em", "alpha", "beta", "--by", "Alex", "--on", "2026-11-13"], dir);
    expect(batch.status).toBe(1);
    expect(read("alpha")).toBe(doc("draft"));
    expect(read("beta")).toBe(doc("draft"));
  });

  it("a reviewers roster that includes --by lets it through", () => {
    policy("reviewers:\n  - name: Alex\n");
    expect(ratify("alpha").status).toBe(0);
    expect(read("alpha")).toContain("reviewedBy: Alex");
  });

  it("a reviewers roster does not block ratifying an already reviewed doc (as today)", () => {
    policy("reviewers:\n  - name: Sam\n");
    write("alpha", doc("reviewed", "reviewedBy: Sam\nreviewedOn: 2026-11-01\n"));
    expect(ratify("alpha").status).toBe(0);
  });
});
