// SPDX-License-Identifier: MIT
// CLI-level coverage for `em export` / `em validate --list-issues` /
// `--fail-on-issues`: spawns the real CLI (via tsx) so the commander wiring,
// exit codes, and stdout/stderr split are exercised, not just the underlying
// functions (which test/export.test.ts and test/validate.test.ts cover).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Genuinely clean: the command is triggered and the event is read, so neither end-of-flow
// warning fires either.
const CLEAN = `slice "Place" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

// One warning (command with no event), no errors.
const WARNING_ONLY = `slice "Place" {
  command Place Order
}
`;

// The open issue is the only diagnostic. The `ui` sits after the command so the issue stays
// on line 2, which the --list-issues assertion pins.
const WITH_ISSUE = `slice "Place" {
  command Place Order issue "who validates the discount code?"
  ui Checkout @Customer
  event Order Placed
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

// Error: view sourced from an event that doesn't exist.
const WITH_ERROR = `slice "Read" {
  view Open Orders from "No Such Event"
}
`;

// The accepted divergence is the only annotation. Line 6 (the view, in its own slice so it
// doesn't collide with the command in the api/view lane) is pinned by the --list-divergences
// assertion, same convention as WITH_ISSUE above.
const WITH_DIVERGENCE = `slice "Place" {
  command Place Order
  event Order Placed
}
slice "Retire" {
  view Retired Orders from "Order Placed" divergence "tracking token covers idempotency"
}
`;

// One event marked public, one not — the only diagnostic-free way to check --list-public
// prints just the public one.
const WITH_PUBLIC = `slice "Place" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order public
}
slice "Retry" {
  event Internal Retry @Order
}
slice "Open Orders" {
  view Open Orders from "Order Placed", "Internal Retry"
  ui Order List @Customer
}
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-cli-"));
  writeFileSync(join(dir, "clean.em"), CLEAN);
  writeFileSync(join(dir, "warn.em"), WARNING_ONLY);
  writeFileSync(join(dir, "issue.em"), WITH_ISSUE);
  writeFileSync(join(dir, "error.em"), WITH_ERROR);
  writeFileSync(join(dir, "divergence.em"), WITH_DIVERGENCE);
  writeFileSync(join(dir, "public.em"), WITH_PUBLIC);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("em export (CLI)", () => {
  it("-o writes the file and confirms on stdout", () => {
    const r = em(["export", "clean.em", "-o", "out.json"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote out.json");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(doc.schemaVersion).toBe("1.2");
  });

  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["export", "warn.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.schemaVersion).toBe("1.2");
    expect(r.stderr).toContain("produces no event");
  });

  it("refuses on errors with a non-zero exit", () => {
    const r = em(["export", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not exporting");
  });
});

describe("em validate --list-issues / --fail-on-issues (CLI)", () => {
  it("--list-issues prints slice, element, line, and text per open issue", () => {
    const r = em(["validate", "--list-issues", "issue.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /issue :2 slice "Place" command "Place Order": who validates the discount code\?/,
    );
  });

  it("--list-issues reports when there are none", () => {
    const r = em(["validate", "--list-issues", "clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no open issues");
  });

  it("--fail-on-issues exits 1 while issues remain, 0 once clear", () => {
    expect(em(["validate", "--fail-on-issues", "issue.em"], dir).status).toBe(1);
    expect(em(["validate", "--fail-on-issues", "clean.em"], dir).status).toBe(0);
  });

  it("--list-issues on a model with errors still prints the errors before exiting 1", () => {
    const r = em(["validate", "--list-issues", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });
});

describe("em validate --list-divergences (CLI)", () => {
  it("prints slice, element, line, and text per accepted divergence", () => {
    const r = em(["validate", "--list-divergences", "divergence.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /divergence :6 slice "Retire" view "Retired Orders": tracking token covers idempotency/,
    );
  });

  it("reports when there are none", () => {
    const r = em(["validate", "--list-divergences", "clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no accepted divergences");
  });

  it("never fails the build, unlike --fail-on-issues — there is no --fail-on-divergences", () => {
    expect(em(["validate", "--list-divergences", "divergence.em"], dir).status).toBe(0);
  });

  it("on a model with errors still prints the errors before exiting 1", () => {
    const r = em(["validate", "--list-divergences", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });
});

describe("em validate --list-public (CLI)", () => {
  it("--list-public prints slice, name, and line per public event, excluding non-public ones", () => {
    const r = em(["validate", "--list-public", "public.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/public :4 slice "Place" event "Order Placed"/);
    expect(r.stdout).not.toContain("Internal Retry");
  });

  it("--list-public reports when there are none", () => {
    const r = em(["validate", "--list-public", "clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no public events");
  });

  it("--list-public never affects the exit code", () => {
    expect(em(["validate", "--list-public", "public.em"], dir).status).toBe(0);
    expect(em(["validate", "--list-public", "clean.em"], dir).status).toBe(0);
  });
});

describe("em diff --json (CLI)", () => {
  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["diff", "clean.em", "warn.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning/report text leaked into stdout
    expect(doc.diffSchemaVersion).toBe("1.2");
    expect(doc.identical).toBe(false);
    expect(r.stderr).toContain("produces no event");
  });

  it("--json --exit-code still exits 1 when the models differ, 0 when identical", () => {
    const differing = em(["diff", "clean.em", "warn.em", "--json", "--exit-code"], dir);
    expect(differing.status).toBe(1);
    expect(JSON.parse(differing.stdout).identical).toBe(false);

    const identical = em(["diff", "clean.em", "clean.em", "--json", "--exit-code"], dir);
    expect(identical.status).toBe(0);
    expect(JSON.parse(identical.stdout).identical).toBe(true);
  });

  it("refuses on errors with a non-zero exit, same as the text form", () => {
    const r = em(["diff", "clean.em", "error.em", "--json"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not diffing");
    expect(r.stdout).toBe("");
  });

  it("carries both sides' warnings in the document, side-tagged", () => {
    const doc = JSON.parse(em(["diff", "clean.em", "warn.em", "--json"], dir).stdout);
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ side: "new", severity: "warning", message: expect.stringContaining("produces no event") }),
    );
    expect(doc.diagnostics.filter((d: { side: string }) => d.side === "old")).toEqual([]);
  });

  it("does not truncate a large document piped through --exit-code", () => {
    // stdout to a pipe is async on POSIX: process.exit() here would cut the
    // JSON off mid-document. Big enough to overrun the ~64KB pipe buffer.
    const big = (n: number, extra: string) =>
      Array.from({ length: n }, (_, i) => `slice "S${i}" {\n  command Do ${i}${extra}\n  event Did ${i}\n}`).join("\n");
    writeFileSync(join(dir, "big-old.em"), big(400, ""));
    writeFileSync(join(dir, "big-new.em"), big(400, ` issue "q${"x".repeat(40)}"`));

    const r = em(["diff", "big-old.em", "big-new.em", "--json", "--exit-code"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(64 * 1024);
    const doc = JSON.parse(r.stdout); // throws if the document was cut short
    expect(doc.changes).toHaveLength(400);
  });
});

describe("em diff --json with --from/--to (CLI, real git repo)", () => {
  let repo: string;

  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-git-"));
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "model.em"), CLEAN);
    git(["add", "model.em"], repo);
    git(["commit", "-qm", "first"], repo);
    // Second revision adds a slice; the working tree adds one more on top, so
    // HEAD~1 -> HEAD and HEAD -> working tree are both non-empty diffs.
    const READ = `slice "Read" {\n  view Open Orders from "Order Placed"\n}\n`;
    writeFileSync(join(repo, "model.em"), CLEAN + READ);
    git(["commit", "-qam", "second"], repo);
    writeFileSync(join(repo, "model.em"), CLEAN + READ + `slice "Ship" {\n  command Ship It\n}\n`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("--from labels the old side path@rev and the new side as the working tree", () => {
    const r = em(["diff", "model.em", "--from", "HEAD", "--json"], repo);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.oldModel.label).toBe("model.em@HEAD");
    expect(doc.newModel.label).toBe("model.em");
    expect(doc.oldModel.sha256).not.toBe(doc.newModel.sha256);
    expect(doc.identical).toBe(false);
    expect(doc.changes).toContainEqual(expect.objectContaining({ type: "slice-added", name: "Ship" }));
  });

  it("--from/--to labels both sides path@rev and composes with --exit-code", () => {
    const r = em(["diff", "model.em", "--from", "HEAD~1", "--to", "HEAD", "--json", "--exit-code"], repo);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.oldModel.label).toBe("model.em@HEAD~1");
    expect(doc.newModel.label).toBe("model.em@HEAD");
    expect(doc.changes).toContainEqual(expect.objectContaining({ type: "slice-added", name: "Read" }));
  });

  it("exits 0 with identical: true when the two revisions match", () => {
    const r = em(["diff", "model.em", "--from", "HEAD", "--to", "HEAD", "--json", "--exit-code"], repo);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).identical).toBe(true);
  });
});

describe("em changelog (CLI, real git repo)", () => {
  let repo: string;

  const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env });

  // Commits at fixed author dates (rather than "whenever the test happens to
  // run") so decision-date matching is deterministic and never flaky across
  // a midnight boundary.
  const commitAt = (cwd: string, date: string, message: string) =>
    git(["commit", "-qam", message], cwd, {
      ...process.env,
      GIT_AUTHOR_DATE: `${date}T10:00:00`,
      GIT_COMMITTER_DATE: `${date}T10:00:00`,
    });

  const INTRO = `slice "Place" {\n  command Place Order\n  event Order Placed\n}\n`;
  const WITH_FIELDS = INTRO + `slice "Ship" {\n  command Ship Order total: Money\n  event Order Shipped\n}\n`;
  // Comment + blank lines only — stripComment() means this parses to the
  // exact same structural model as WITH_FIELDS.
  const REFORMAT_ONLY = WITH_FIELDS.replace(
    'command Ship Order total: Money',
    'command Ship Order total: Money  # reformatted for clarity',
  ) + "\n\n";
  const WITH_ISSUE =
    INTRO +
    `slice "Ship" {\n  command Ship Order total: Money\n  event Order Shipped issue "who confirms delivery?"\n}\n`;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-changelog-"));
    git(["init", "-q", "-b", "main"], repo);

    writeFileSync(join(repo, "model.em"), INTRO);
    git(["add", "model.em"], repo);
    commitAt(repo, "2026-01-01", "introduce order placement");

    writeFileSync(join(repo, "model.em"), WITH_FIELDS);
    git(["add", "model.em"], repo);
    commitAt(repo, "2026-01-02", "add shipping slice with a field");

    writeFileSync(join(repo, "model.em"), REFORMAT_ONLY);
    git(["add", "model.em"], repo);
    commitAt(repo, "2026-01-03", "reformat only");

    writeFileSync(join(repo, "model.em"), WITH_ISSUE);
    writeFileSync(
      join(repo, ".event-modeling.md"),
      "# Event Modeling Progress — Orders\n\n## Decisions log\n- 2026-01-04: opened the delivery-confirmation question for follow-up\n",
    );
    git(["add", "model.em", ".event-modeling.md"], repo);
    commitAt(repo, "2026-01-04", "open delivery confirmation issue");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("walks history newest-first, omits the comment-only commit, and weaves in the matching decision", () => {
    const r = em(["changelog", "model.em"], repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");

    const headings = [...r.stdout.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual([
      expect.stringContaining("open delivery confirmation issue"),
      expect.stringContaining("add shipping slice with a field"),
      expect.stringContaining("introduce order placement"),
    ]);
    expect(r.stdout).not.toContain("reformat only");
    expect(r.stdout).toContain("Decisions:\n- opened the delivery-confirmation question for follow-up");
    expect(r.stdout).toContain('issue opened: event "Order Shipped"');
    expect(r.stdout.startsWith("# Model changelog — model.em")).toBe(true);
    expect(r.stdout).toContain("Model introduced: 1 slice, 2 elements.");
  });

  it("--from bounds the walk: the boundary commit becomes the introduction, earlier commits drop out", () => {
    const r = em(["changelog", "model.em", "--from", "HEAD~1"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("introduce order placement");
    expect(r.stdout).not.toContain("add shipping slice with a field");
    expect(r.stdout).toContain("open delivery confirmation issue");
    // HEAD~1 ("reformat only") has no predecessor inside the bounded walk,
    // so it renders as the introduction instead of being diffed/omitted.
    expect(r.stdout).toContain("reformat only");
    expect(r.stdout).toContain("Model introduced:");
  });

  it("-o writes the file and confirms on stdout", () => {
    const r = em(["changelog", "model.em", "-o", "changelog.md"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote changelog.md");
    const text = readFileSync(join(repo, "changelog.md"), "utf8");
    expect(text.startsWith("# Model changelog — model.em")).toBe(true);
  });

  it("fails with a clear, non-zero exit outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-cli-changelog-nogit-"));
    writeFileSync(join(outside, "model.em"), INTRO);
    const r = em(["changelog", "model.em"], outside);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not inside a git repository");
    expect(r.stdout).toBe("");
    rmSync(outside, { recursive: true, force: true });
  });

  it("fails with a clear, non-zero exit on an unknown --from revision", () => {
    const r = em(["changelog", "model.em", "--from", "not-a-real-rev"], repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown revision "not-a-real-rev"');
  });
});

describe("em changelog follows renames (CLI, real git repo)", () => {
  let repo: string;

  const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env });

  const commitAt = (cwd: string, date: string, message: string) =>
    git(["commit", "-qam", message], cwd, {
      ...process.env,
      GIT_AUTHOR_DATE: `${date}T10:00:00`,
      GIT_COMMITTER_DATE: `${date}T10:00:00`,
    });

  const INTRO = `slice "Place" {\n  command Place Order\n  event Order Placed\n}\n`;
  const WITH_SHIP = INTRO + `slice "Ship" {\n  command Ship Order\n  event Order Shipped\n}\n`;
  const WITH_CANCEL = WITH_SHIP + `slice "Cancel" {\n  command Cancel Order\n  event Order Cancelled\n}\n`;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-changelog-rename-"));
    git(["init", "-q", "-b", "main"], repo);

    writeFileSync(join(repo, "old-name.em"), INTRO);
    git(["add", "old-name.em"], repo);
    commitAt(repo, "2026-01-01", "introduce model");

    writeFileSync(join(repo, "old-name.em"), WITH_SHIP);
    git(["add", "old-name.em"], repo);
    commitAt(repo, "2026-01-02", "add shipping");

    git(["mv", "old-name.em", "new-name.em"], repo);
    commitAt(repo, "2026-01-03", "rename model file");

    writeFileSync(join(repo, "new-name.em"), WITH_CANCEL);
    git(["add", "new-name.em"], repo);
    commitAt(repo, "2026-01-04", "add cancellation");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reads pre-rename revisions at their historical path — no error sections", () => {
    const r = em(["changelog", "new-name.em"], repo);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).not.toContain("could not compile");

    // Pre-rename history renders as real content: the introduction compiles,
    // and the pre-rename diff (01-01 -> 01-02) is a structural section.
    expect(r.stdout).toContain("Model introduced: 1 slice, 2 elements.");
    expect(r.stdout).toContain('+ slice "Ship"');
    // The post-rename diff computes against the pre-rename side too.
    expect(r.stdout).toContain('+ slice "Cancel"');
    // A pure rename changes nothing structurally — its section is omitted.
    expect(r.stdout).not.toContain("rename model file");
  });
});
