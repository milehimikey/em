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

const CLEAN = `slice "Place" {
  command Place Order
  event Order Placed
}
`;

// One warning (command with no event), no errors.
const WARNING_ONLY = `slice "Place" {
  command Place Order
}
`;

const WITH_ISSUE = `slice "Place" {
  command Place Order issue "who validates the discount code?"
  event Order Placed
}
`;

// Error: view sourced from an event that doesn't exist.
const WITH_ERROR = `slice "Read" {
  view Open Orders from "No Such Event"
}
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-cli-"));
  writeFileSync(join(dir, "clean.em"), CLEAN);
  writeFileSync(join(dir, "warn.em"), WARNING_ONLY);
  writeFileSync(join(dir, "issue.em"), WITH_ISSUE);
  writeFileSync(join(dir, "error.em"), WITH_ERROR);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("em export (CLI)", () => {
  it("-o writes the file and confirms on stdout", () => {
    const r = em(["export", "clean.em", "-o", "out.json"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote out.json");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(doc.schemaVersion).toBe("1.0");
  });

  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["export", "warn.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.schemaVersion).toBe("1.0");
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

describe("em diff --json (CLI)", () => {
  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["diff", "clean.em", "warn.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning/report text leaked into stdout
    expect(doc.diffSchemaVersion).toBe("1.0");
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
