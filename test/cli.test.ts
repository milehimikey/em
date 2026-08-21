// SPDX-License-Identifier: MIT
// CLI-level coverage for `em export` / `em validate --list-issues` /
// `--fail-on-issues`: spawns the real CLI (via tsx) so the commander wiring,
// exit codes, and stdout/stderr split are exercised, not just the underlying
// functions (which test/export.test.ts and test/validate.test.ts cover).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  // Explicit maxBuffer, well above any realistic export/diff document: relying on
  // spawnSync's implicit default silently truncates large stdout under vitest's worker
  // environment well before Node's own default limit — the exact failure mode the
  // "does not truncate a large document" test below exists to catch (MIL-91 grew
  // diagnostics with code/refs, pushing a previously-fine fixture over that edge).
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
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

// Unclassified pattern (ui only, no command/view) so its slice diagram's API lane is
// genuinely empty by default — the case --keep-empty-lanes exists to override.
const UI_ONLY = `persona Customer
slice "Just A Screen" {
  ui Dashboard @Customer
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

// One event and one view marked public, one event not — the only diagnostic-free way to check --list-public
// prints just the public ones (both event and view).
const WITH_PUBLIC = `slice "Place" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order public
}
slice "Retry" {
  event Internal Retry @Order
}
slice "Open Orders" {
  view Open Orders public from "Order Placed", "Internal Retry"
  ui Order List @Customer
}
`;

// `em catalog` fixture: two slices sharing a name, to exercise computeRefs's ref-collision
// warning surfacing through the catalog command (see test/catalog.e2e.test.ts for the
// build-level coverage of the same scenario).
const CATALOG_DUPLICATE_SLICE_NAMES = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
slice "Place Order" {
  ui Retry Checkout @Customer
  command Retry Order
  event Order Retried
}
`;

// `em glossary` fixtures: "Order Confirmed" as an event with an untriaged `total: Money`
// field. Deliberately has one incidental warning (no view reads this event) so tests can
// confirm it's routed to stderr, prefixed with the file, while stdout stays clean.
const GLOSSARY_A = `slice "Submit" {
  event Order Confirmed { total: Money }
}
`;

// Same term, same kind, same field type as GLOSSARY_A — pairs with it to exercise the
// "no conflicts" text/JSON/--list-conflicts/--fail-on-conflicts paths.
const GLOSSARY_B_CLEAN = `slice "Confirm" {
  event Order Confirmed { total: Money }
}
`;

// Same term as GLOSSARY_A, but a different kind (view, not event) and a different field
// type (number, not Money) — pairs with it to exercise both conflict rules.
const GLOSSARY_B_CONFLICT = `slice "Confirm" {
  event Invoice Issued
  view Order Confirmed from "Invoice Issued" { total: number }
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
  writeFileSync(join(dir, "glossary-a.em"), GLOSSARY_A);
  writeFileSync(join(dir, "glossary-b-clean.em"), GLOSSARY_B_CLEAN);
  writeFileSync(join(dir, "glossary-b-conflict.em"), GLOSSARY_B_CONFLICT);
  writeFileSync(join(dir, "catalog-duplicate.em"), CATALOG_DUPLICATE_SLICE_NAMES);
  writeFileSync(join(dir, "ui-only.em"), UI_ONLY);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("em export (CLI)", () => {
  it("-o writes the file and confirms on stdout", () => {
    const r = em(["export", "clean.em", "-o", "out.json"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote out.json");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(doc.schemaVersion).toBe("1.5");
  });

  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["export", "warn.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.schemaVersion).toBe("1.5");
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
  it("--list-public prints slice, kind, name, and line per public element, excluding non-public ones", () => {
    const r = em(["validate", "--list-public", "public.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/public :4 slice "Place" event "Order Placed"/);
    expect(r.stdout).toMatch(/public :10 slice "Open Orders" view "Open Orders"/);
    expect(r.stdout).not.toContain("Internal Retry");
  });

  it("--list-public reports when there are none", () => {
    const r = em(["validate", "--list-public", "clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no public elements");
  });

  it("--list-public never affects the exit code", () => {
    expect(em(["validate", "--list-public", "public.em"], dir).status).toBe(0);
    expect(em(["validate", "--list-public", "clean.em"], dir).status).toBe(0);
  });
});

describe("em validate rejects excess positional file arguments (CLI, MIL-123)", () => {
  it("still validates a single file", () => {
    const r = em(["validate", "clean.em"], dir);
    expect(r.status).toBe(0);
  });

  it("fails loudly instead of silently validating only the first file", () => {
    const r = em(["validate", "clean.em", "issue.em", "error.em"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/too many arguments/);
    // Confirms it never got as far as actually validating anything.
    expect(r.stdout).not.toContain("ok — no issues");
  });
});

describe("em validate lineage checks (CLI, MIL-84)", () => {
  let lineageDir: string;

  beforeAll(() => {
    lineageDir = mkdtempSync(join(tmpdir(), "em-cli-lineage-validate-"));
    mkdirSync(join(lineageDir, "slices"), { recursive: true });
    // slice "Place" -> kebab key "place", shared by every .em fixture below (baseDir is this
    // same dir for all of them).
    writeFileSync(
      join(lineageDir, "slices", "place.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 5\n---\nbody\n",
    );
  });
  afterAll(() => rmSync(lineageDir, { recursive: true, force: true }));

  it("errors with lineage-version-impossible when a ref names a future version", () => {
    writeFileSync(
      join(lineageDir, "slices", "impossible.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nsplit-from: place@v9\n---\nbody\n",
    );
    writeFileSync(join(lineageDir, "impossible.em"), `slice "Place" {\n  command Place Order\n}\nslice "Impossible" {\n  command Do Thing\n}\n`);
    const r = em(["validate", "impossible.em"], lineageDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "impossible"\'s split-from names "place"@v9, but "place" is only at v5');
  });

  it("produces zero lineage diagnostics for a backward ref naming a legitimately absent predecessor", () => {
    writeFileSync(
      join(lineageDir, "slices", "steady.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nmerged-from: retired-cart@v3\n---\nbody\n",
    );
    writeFileSync(join(lineageDir, "steady.em"), `slice "Place" {\n  command Place Order\n}\nslice "Steady" {\n  command Do Thing\n}\n`);
    const r = em(["validate", "steady.em"], lineageDir);
    // Both commands are trigger/event-less (same shape as "impossible.em" above), so this
    // still warns — but never on lineage, and never a non-zero exit (warnings don't gate).
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("lineage");
  });
});

describe("em validate frontmatter coherence checks (CLI, MIL-85)", () => {
  let coherenceDir: string;

  beforeAll(() => {
    coherenceDir = mkdtempSync(join(tmpdir(), "em-cli-frontmatter-coherence-validate-"));
    mkdirSync(join(coherenceDir, "slices"), { recursive: true });
  });
  afterAll(() => rmSync(coherenceDir, { recursive: true, force: true }));

  it("warns with frontmatter-coherence-implemented-without-link when implemented has no link", () => {
    writeFileSync(
      join(coherenceDir, "slices", "no-link.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\n---\nbody\n",
    );
    writeFileSync(
      join(coherenceDir, "no-link.em"),
      `slice "No Link" {\n  command Do Thing\n}\n`,
    );
    const r = em(["validate", "no-link.em"], coherenceDir);
    expect(r.status).toBe(0); // a warning, never gates
    expect(r.stderr).toContain('slice "no-link" has status: implemented but no implementedIn link');
  });

  it("stays silent for a re-ratified slice whose implementedIn still names prior work", () => {
    writeFileSync(
      join(coherenceDir, "slices", "re-ratified.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\nimplementedIn: https://github.com/example/pr/1\n---\nbody\n",
    );
    writeFileSync(
      join(coherenceDir, "re-ratified.em"),
      `slice "Re Ratified" {\n  command Do Thing\n}\n`,
    );
    const r = em(["validate", "re-ratified.em"], coherenceDir);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("implementedIn link");
  });
});

describe("em validate --slice-ready (CLI, MIL-87)", () => {
  let readyDir: string;

  beforeAll(() => {
    readyDir = mkdtempSync(join(tmpdir(), "em-cli-slice-ready-"));
    mkdirSync(join(readyDir, "slices"), { recursive: true });
    writeFileSync(
      join(readyDir, "slices", "ready-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n## Open Questions\n- [x] resolved\n",
    );
    // Genuinely complete (ui -> command -> event -> view -> ui), so this slice's own
    // both-ends-of-a-flow diagnostics stay silent — the only way to isolate "ready" to
    // meaning what these tests need it to mean.
    writeFileSync(
      join(readyDir, "ready.em"),
      `slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n`,
    );
    writeFileSync(
      join(readyDir, "slices", "draft-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n## Open Questions\n- [ ] still unresolved\n",
    );
    writeFileSync(
      join(readyDir, "draft.em"),
      `slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n  event Thing Done\n}\n`,
    );
    writeFileSync(join(readyDir, "unbound.em"), `slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n`);
    // MIL-87 review fix: an otherwise-fully-ready slice, plus a second slice with a genuine
    // model error unrelated to it — regression coverage for the bug where `--slice-ready` used
    // to gate on errors anywhere in the whole model, silently failing (zero diagnostics printed)
    // on breakage that had nothing to do with the named slice.
    writeFileSync(
      join(readyDir, "ready-with-unrelated-error.em"),
      `slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\nslice "Unrelated Broken" {\n  view Broken View from "No Such Event"\n}\n`,
    );
    // The mirror case: an issue INSIDE the named slice itself (element-level, not slice-level)
    // must still block readiness — confirms the fix scopes to "this slice" (bare key or
    // `<key>/...` element refs), not just the handful of slice-level codes.
    writeFileSync(
      join(readyDir, "ready-with-own-issue.em"),
      `slice "Ready Slice" {\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\n`,
    );
  });
  afterAll(() => rmSync(readyDir, { recursive: true, force: true }));

  it("exits 0 and reports ready-to-implement for a bound, ready, fully-checked doc", () => {
    const r = em(["validate", "ready.em", "--slice-ready", "ready-slice"], readyDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('slice "ready-slice" is ready-to-implement');
  });

  it("exits 1 and reports not-ready for status: draft with unchecked Open Questions", () => {
    const r = em(["validate", "draft.em", "--slice-ready", "draft-slice"], readyDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('slice "draft-slice" is NOT ready-to-implement');
    expect(r.stderr).toContain('slice "draft-slice" is status: draft, not ready-to-implement');
    expect(r.stderr).toContain('slice "draft-slice" has 1 of 1 Open Question(s) unchecked');
  });

  it("exits 1 with slice-ready-no-doc-bound when no note binds a doc", () => {
    const r = em(["validate", "unbound.em", "--slice-ready", "unbound"], readyDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "unbound" has no doc bound via `note "slices/unbound.md"`');
  });

  it("exits 1 with slice-ready-unknown-slice for a key that names no slice", () => {
    const r = em(["validate", "ready.em", "--slice-ready", "no-such-key"], readyDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no slice with export key "no-such-key" in this model');
  });

  it("stays ready (exit 0) despite a genuine error in an unrelated slice (regression)", () => {
    const r = em(["validate", "ready-with-unrelated-error.em", "--slice-ready", "ready-slice"], readyDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('slice "ready-slice" is ready-to-implement');
    // The unrelated slice's own error is real and stays unreported by this narrow flag — a
    // plain `em validate` (no --slice-ready) is how you'd see it.
  });

  it("still blocks (exit 1) on a genuine issue inside the named slice itself, not just slice-level codes", () => {
    const r = em(["validate", "ready-with-own-issue.em", "--slice-ready", "ready-slice"], readyDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('slice "ready-slice" is NOT ready-to-implement');
    expect(r.stderr).toContain("nothing that triggers it");
  });
});

describe("em diff --json (CLI)", () => {
  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["diff", "clean.em", "warn.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning/report text leaked into stdout
    expect(doc.diffSchemaVersion).toBe("1.6");
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
    // HEAD~1 -> HEAD and HEAD -> working tree are both non-empty diffs. It also carries a
    // slice doc declaring split-from (MIL-84), committed in the same commit as the slice add —
    // the same-commit lineage convention (docs/slice-doc-schema.md) — so `--from HEAD~1 --to
    // HEAD` can resolve it via `git show` at HEAD, not the working tree.
    const READ = `slice "Read" {\n  view Open Orders from "Order Placed"\n}\n`;
    writeFileSync(join(repo, "model.em"), CLEAN + READ);
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(
      join(repo, "slices", "read.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: implemented\nversion: 1\nsplit-from: place@v1\n---\nbody\n",
    );
    git(["add", "slices/read.md"], repo);
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

  it("resolves the new side's slice doc lineage via git show at the revision (MIL-84)", () => {
    const r = em(["diff", "model.em", "--from", "HEAD~1", "--to", "HEAD", "--json"], repo);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.changes).toContainEqual(
      expect.objectContaining({
        type: "slice-added",
        name: "Read",
        splitFrom: { raw: "place@v1", sliceKey: "place", version: 1 },
      }),
    );
  });

  it("exits 0 with identical: true when the two revisions match", () => {
    const r = em(["diff", "model.em", "--from", "HEAD", "--to", "HEAD", "--json", "--exit-code"], repo);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).identical).toBe(true);
  });
});

describe("em diff lineage: removed-slice doc resolves via git show even after deletion (MIL-84)", () => {
  // Regression test for a real PR-review-confirmed bug: resolveDocAtRevision used to look the
  // path up via `git ls-files` (the *current* index), so a doc that had already been deleted
  // by the time you're diffing — the routine case for a superseded-by-carrying doc, removed in
  // the same commit that retires the slice it describes — silently failed to resolve, even
  // though `git show <rev>:<path>` could read it fine. Fixed by resolving existence at `<rev>`
  // itself (`git ls-tree`), not the current tree.
  let repo: string;

  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-git-removed-doc-"));
    git(["init", "-q", "-b", "main"], repo);
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(join(repo, "model.em"), `slice "Old Checkout" {\n  command Do Old Checkout\n  event Old Checkout Done\n}\n`);
    writeFileSync(
      join(repo, "slices", "old-checkout.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nsuperseded-by: new-checkout@v1\n---\nbody\n",
    );
    git(["add", "-A"], repo);
    git(["commit", "-qm", "first"], repo);
    // Same-commit convention: the slice AND its doc are both removed here, in the one commit
    // that performs the retirement — so by the time `em diff` runs, slices/old-checkout.md no
    // longer exists anywhere in the current working tree or index.
    writeFileSync(join(repo, "model.em"), `slice "New Checkout" {\n  command Do New Checkout\n  event New Checkout Done\n}\n`);
    git(["rm", "-q", "slices/old-checkout.md"], repo);
    git(["add", "model.em"], repo);
    git(["commit", "-qm", "second"], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("resolves the removed slice's superseded-by even though its doc is gone from the current tree", () => {
    const r = em(["diff", "model.em", "--from", "HEAD~1", "--to", "HEAD", "--json"], repo);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.removals).toContainEqual(
      expect.objectContaining({
        type: "slice-removed",
        name: "Old Checkout",
        supersededBy: [{ raw: "new-checkout@v1", sliceKey: "new-checkout", version: 1 }],
      }),
    );
    expect(doc.counts.slicesSuperseded).toBe(1);
  });
});

describe("em diff lineage annotations (MIL-84, CLI)", () => {
  // Files form: each side's slice docs live relative to *that file's own* directory, so two
  // sibling dirs, each with their own `slices/` folder — matching src/cli.ts's per-side baseDir.
  let oldDir: string;
  let newDir: string;

  beforeAll(() => {
    oldDir = mkdtempSync(join(tmpdir(), "em-cli-lineage-old-"));
    newDir = mkdtempSync(join(tmpdir(), "em-cli-lineage-new-"));
    writeFileSync(join(oldDir, "model.em"), CLEAN);
    writeFileSync(
      join(newDir, "model.em"),
      CLEAN + `slice "Discount Rules" {\n  command Apply Discount\n  event Discount Applied\n}\n`,
    );
    mkdirSync(join(newDir, "slices"), { recursive: true });
    writeFileSync(
      join(newDir, "slices", "discount-rules.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nsplit-from: place@v1\n---\nbody\n",
    );
  });
  afterAll(() => {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it("resolves the new-side doc's split-from and shows it in --json", () => {
    const r = em(["diff", join(oldDir, "model.em"), join(newDir, "model.em"), "--json"], newDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.changes).toContainEqual(
      expect.objectContaining({
        type: "slice-added",
        name: "Discount Rules",
        splitFrom: { raw: "place@v1", sliceKey: "place", version: 1 },
      }),
    );
    expect(doc.counts.slicesSplit).toBe(1);
  });

  it("renders the split-from annotation in the text report", () => {
    const r = em(["diff", join(oldDir, "model.em"), join(newDir, "model.em")], newDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('+ slice "Discount Rules" (split from "place"@v1)');
  });
});

/** A well-formed slice doc with every required frontmatter key present, for `em ledger` tests
 *  below (MIL-89). */
function ledgerDoc(version: number, status: string, implementedIn: string, body: string): string {
  return `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: ${version}\nimplementedIn: ${implementedIn}\n---\n${body}\n`;
}

describe("em ledger (CLI, real git repo, MIL-89)", () => {
  let repo: string;

  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-ledger-"));
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "model.em"), CLEAN);
    mkdirSync(join(repo, "slices"), { recursive: true });
    // "checkout": version bump + real body change together — the clean case.
    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(1, "implemented", "PR#1", "Original checkout body."));
    // "stale": body will change with no version bump.
    writeFileSync(join(repo, "slices", "stale.md"), ledgerDoc(1, "implemented", "PR#10", "Stale body unchanged."));
    // "bumped": version will bump with no content change.
    writeFileSync(join(repo, "slices", "bumped.md"), ledgerDoc(1, "implemented", "PR#20", "Bumped body unchanged."));
    // "regress": version will go backwards.
    writeFileSync(join(repo, "slices", "regress.md"), ledgerDoc(5, "implemented", "PR#30", "Regress body unchanged."));
    // "bad": missing the required `version:` key at every revision — frontmatter-invalid, both sides.
    writeFileSync(
      join(repo, "slices", "bad.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nimplementedIn: PR#99\n---\nBad doc body.\n",
    );
    // "removed": present at HEAD~1, retired (git rm) in the same commit that would otherwise
    // touch it — the same-commit convention MIL-84's deleted-doc regression test also uses.
    writeFileSync(join(repo, "slices", "removed.md"), ledgerDoc(1, "implemented", "PR#40", "Removed body."));
    // "status-only": only `status` changes (re-ratification) — must never be flagged.
    writeFileSync(join(repo, "slices", "status-only.md"), ledgerDoc(2, "implemented", "PR#50", "Status-only body unchanged."));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "first"], repo);

    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(2, "implemented", "PR#1", "Updated checkout body."));
    writeFileSync(join(repo, "slices", "stale.md"), ledgerDoc(1, "implemented", "PR#10", "Stale body CHANGED."));
    writeFileSync(join(repo, "slices", "bumped.md"), ledgerDoc(2, "implemented", "PR#20", "Bumped body unchanged."));
    writeFileSync(join(repo, "slices", "regress.md"), ledgerDoc(4, "implemented", "PR#30", "Regress body unchanged."));
    // "bad.md" untouched — still missing `version:` at HEAD.
    git(["rm", "-q", "slices/removed.md"], repo);
    writeFileSync(join(repo, "slices", "status-only.md"), ledgerDoc(2, "ready-to-implement", "PR#50", "Status-only body unchanged."));
    // "new-slice": doesn't exist at HEAD~1 at all — no-prior-revision.
    writeFileSync(join(repo, "slices", "new-slice.md"), ledgerDoc(1, "draft", "", "Brand new slice doc."));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "second"], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("--json reports every mismatch and skip between two commits", () => {
    const r = em(["ledger", "model.em", "--from", "HEAD~1", "--to", "HEAD", "--json"], repo);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ledgerSchemaVersion).toBe("1.0");
    expect(doc.from).toBe("HEAD~1");
    expect(doc.to).toBe("HEAD");
    expect(doc.ok).toBe(false);

    expect(doc.findings).toContainEqual(
      expect.objectContaining({ sliceKey: "stale", code: "ledger-content-without-version-bump", oldVersion: 1, newVersion: 1 }),
    );
    expect(doc.findings).toContainEqual(
      expect.objectContaining({ sliceKey: "bumped", code: "ledger-version-without-content-change", oldVersion: 1, newVersion: 2 }),
    );
    expect(doc.findings).toContainEqual(
      expect.objectContaining({ sliceKey: "regress", code: "ledger-version-regression", oldVersion: 5, newVersion: 4 }),
    );

    const findingKeys = doc.findings.map((f: { sliceKey: string }) => f.sliceKey);
    expect(findingKeys).not.toContain("checkout"); // clean: bump + real content change together
    expect(findingKeys).not.toContain("status-only"); // re-ratification convention: never flagged

    expect(doc.skipped).toContainEqual({ sliceKey: "bad", reason: "frontmatter-invalid" });
    expect(doc.skipped).toContainEqual({ sliceKey: "new-slice", reason: "no-prior-revision" });
    expect(doc.skipped).toContainEqual({ sliceKey: "removed", reason: "deleted" });
  });
});

describe("em ledger: text report, working tree, and argument validation (CLI, real git repo, MIL-89)", () => {
  let repo: string;

  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-cli-ledger-simple-"));
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "model.em"), CLEAN);
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(1, "implemented", "PR#1", "Original body."));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "first"], repo);
    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(2, "implemented", "PR#1", "Updated body."));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "second"], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("exits 0 and prints an ok summary in the text report when everything agrees", () => {
    const r = em(["ledger", "model.em", "--from", "HEAD~1", "--to", "HEAD"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok — ledger agrees (1 slice doc(s) checked)");
  });

  it("prints one line per finding and a mismatch count in the text report", () => {
    // A third commit isolates this finding from the clean HEAD~1..HEAD pair above.
    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(3, "implemented", "PR#1", "Updated body."));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "third"], repo);
    const r = em(["ledger", "model.em", "--from", "HEAD~1", "--to", "HEAD"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('slice "checkout": version: bumped (v2 -> v3) but doc content is unchanged');
    expect(r.stdout).toContain("1 ledger mismatch(es)");
  });

  it("--to omitted compares against the current working tree", () => {
    writeFileSync(join(repo, "slices", "checkout.md"), ledgerDoc(4, "implemented", "PR#1", "Working tree body."));
    const r = em(["ledger", "model.em", "--from", "HEAD", "--json"], repo);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.to).toBeNull();
    expect(doc.findings).toEqual([]);
  });

  it("requires --from", () => {
    const r = em(["ledger", "model.em"], repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em ledger: --from <rev> is required");
  });
});

describe("em skill sync / em skill check (CLI, real fs, MIL-93)", () => {
  let target: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), "em-cli-skillsync-"));
  });
  afterAll(() => rmSync(target, { recursive: true, force: true }));

  it("sync materializes the packaged skill into [path]/.claude/skills/event-modeling/", () => {
    const r = em(["skill", "sync", target], ROOT);
    expect(r.status).toBe(0);
    expect(existsSync(join(target, ".claude", "skills", "event-modeling", "SKILL.md"))).toBe(true);
    expect(r.stdout).toContain("added: SKILL.md");
  });

  it("re-running sync reports up to date and makes no changes", () => {
    const r = em(["skill", "sync", target], ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("check reports ok for a freshly synced copy", () => {
    const r = em(["skill", "check", target], ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ok — vendored skill matches em /);
  });

  it("check exits non-zero and reports drift after a hand edit", () => {
    writeFileSync(join(target, ".claude", "skills", "event-modeling", "SKILL.md"), "hand-edited, no frontmatter");
    const r = em(["skill", "check", target], ROOT);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("has no em-version: stamp");
    expect(r.stdout).toContain("differs from the packaged skill");
  });

  it("check --json prints the documented envelope", () => {
    const r = em(["skill", "check", target, "--json"], ROOT);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.skillCheckSchemaVersion).toBe("1.0");
    expect(doc.ok).toBe(false);
    expect(doc.findings.map((f: { code: string }) => f.code).sort()).toEqual([
      "skill-check-content-drift",
      "skill-check-stamp-missing",
    ]);
  });
});

describe("em scaffold (CLI, real fs, MIL-97 item 2)", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-scaffold-"));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it("creates <slug>/ with all 4 files, correctly titled/slugged", () => {
    const r = em(["scaffold", "Order Fulfillment"], cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("scaffolded order-fulfillment/");

    const dir = join(cwd, "order-fulfillment");
    expect(existsSync(join(dir, "order-fulfillment.em"))).toBe(true);
    expect(existsSync(join(dir, "live.html"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".event-modeling.md"))).toBe(true);

    const em_ = readFileSync(join(dir, "order-fulfillment.em"), "utf8");
    expect(em_.startsWith('model "Order Fulfillment"\n')).toBe(true);

    const live = readFileSync(join(dir, "live.html"), "utf8");
    expect(live).toBe(readFileSync(join(ROOT, ".claude", "skills", "event-modeling", "templates", "live.html"), "utf8"));

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# Order Fulfillment\n")).toBe(true);
    expect(readme).toContain("em watch order-fulfillment.em -o order-fulfillment.svg --serve");
    expect(readme).toContain(
      "<!-- GENERATED:slices:start -->\n" +
        "| # | Slice | Pattern | Status | Implemented in | Design doc |\n" +
        "|---|-------|---------|--------|----------------|------------|\n" +
        "<!-- GENERATED:slices:end -->",
    );

    const state = readFileSync(join(dir, ".event-modeling.md"), "utf8");
    expect(state).toContain("# Event Modeling Progress — Order Fulfillment");
    expect(state).toContain("- **Model file:** `order-fulfillment.em`");
    expect(state).toContain("- **Current phase:** discover");
    expect(state).toContain("- **Current step:** 1");
    expect(state).toMatch(/- \*\*Last updated:\*\* \d{4}-\d{2}-\d{2}/);
    expect(state).toContain("- **Last conformance:** never");
    expect(state).toContain("- **Last stakeholder review:** never");

    // Never leave a template placeholder in any written file.
    for (const text of [em_, live, readme, state]) {
      expect(text).not.toMatch(/\{\{[^}]*\}\}/);
    }
  });

  it("refuses to overwrite an existing directory without --force", () => {
    const r = em(["scaffold", "Order Fulfillment"], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to overwrite order-fulfillment/ (use --force)");
  });

  it("--force overwrites the existing directory's contents", () => {
    const dir = join(cwd, "order-fulfillment");
    writeFileSync(join(dir, "README.md"), "hand-edited, should be clobbered");
    const r = em(["scaffold", "Order Fulfillment", "--force"], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scaffolded order-fulfillment/");
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# Order Fulfillment\n")).toBe(true);
  });

  it("kebab-slugs an already-slug-shaped name to itself, and a messy name into a clean slug", () => {
    const r1 = em(["scaffold", "widget-returns"], cwd);
    expect(r1.status).toBe(0);
    expect(existsSync(join(cwd, "widget-returns", "widget-returns.em"))).toBe(true);

    const r2 = em(["scaffold", "Weird!! Name_2"], cwd);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("scaffolded weird-name-2/");
    expect(existsSync(join(cwd, "weird-name-2", "weird-name-2.em"))).toBe(true);
    const readme = readFileSync(join(cwd, "weird-name-2", "README.md"), "utf8");
    // Display name (untouched) is used for titles/prose; slug is used for filenames.
    expect(readme.startsWith("# Weird!! Name_2\n")).toBe(true);
  });

  it('rejects a name containing " with a clear error, writing nothing', () => {
    const r = em(["scaffold", 'Bob"s Orders'], cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('"');
    expect(existsSync(join(cwd, "bob-s-orders"))).toBe(false);
  });

  it("rejects a name containing {{ with a clear error, writing nothing", () => {
    const r = em(["scaffold", "x{{y"], cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("{{");
    expect(existsSync(join(cwd, "x-y"))).toBe(false);
  });

  it("a name containing regex-replacement patterns ($&, $$) scaffolds with the literal name intact", () => {
    const r = em(["scaffold", "Foo $& Bar $$ Baz"], cwd);
    expect(r.status).toBe(0);
    const dir = join(cwd, "foo-bar-baz");
    const em_ = readFileSync(join(dir, "foo-bar-baz.em"), "utf8");
    expect(em_.startsWith('model "Foo $& Bar $$ Baz"\n')).toBe(true);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# Foo $& Bar $$ Baz\n")).toBe(true);
    const state = readFileSync(join(dir, ".event-modeling.md"), "utf8");
    expect(state).toContain("Foo $& Bar $$ Baz");
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

describe("em conform-scope (CLI, real git repo)", () => {
  const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env });

  // Genuinely clean, same shape as the top-of-file CLEAN fixture (ui+command+event, then a
  // view+ui slice reading it) doubled up — so this model triggers no diagnostics on stderr and
  // "diff-scoped..." below can assert stderr stays empty.
  const MODEL =
    `slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order note "slices/place-order.md"\n  event Order Placed\n}\n` +
    `slice "Open Orders" {\n  view Open Orders from "Order Placed"\n  ui Order List @Customer\n}\n` +
    `slice "Ship Order" {\n  ui Shipping @Customer\n  command Ship Order note "slices/ship-order.md"\n  event Order Shipped\n}\n` +
    `slice "Shipped Orders" {\n  view Shipped Orders from "Order Shipped"\n  ui Shipment List @Customer\n}\n`;

  const docWithImplementedIn = (implementedIn: string) =>
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: ${implementedIn}\n---\n## Intent\n`;

  let modelDir: string;
  let targetRepo: string;
  let baseRev: string;

  beforeAll(() => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-conform-scope-"));
    const scaffolded = em(["scaffold", "Checkout"], cwd);
    expect(scaffolded.status).toBe(0);
    modelDir = join(cwd, "checkout");
    writeFileSync(join(modelDir, "checkout.em"), MODEL);
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    writeFileSync(join(modelDir, "slices", "place-order.md"), docWithImplementedIn("src/checkout"));
    writeFileSync(join(modelDir, "slices", "ship-order.md"), docWithImplementedIn("https://github.com/example/repo/pull/42"));

    targetRepo = mkdtempSync(join(tmpdir(), "em-cli-conform-scope-target-"));
    git(["init", "-q", "-b", "main"], targetRepo);
    mkdirSync(join(targetRepo, "src", "checkout"), { recursive: true });
    writeFileSync(join(targetRepo, "src", "checkout", "Handler.kt"), "class Handler\n");
    writeFileSync(join(targetRepo, "README.md"), "# demo\n");
    git(["add", "."], targetRepo);
    git(["commit", "-qam", "initial"], targetRepo);
    baseRev = git(["rev-parse", "HEAD"], targetRepo).stdout.trim();

    const setConformance = em(
      ["state", "set-conformance", baseRev, "--report", "conformance/2026-08-01-report.md"],
      modelDir,
    );
    expect(setConformance.status).toBe(0);

    writeFileSync(join(targetRepo, "src", "checkout", "Handler.kt"), "class Handler2\n");
    git(["add", "."], targetRepo);
    git(["commit", "-qam", "tweak checkout handler"], targetRepo);

    writeFileSync(join(targetRepo, "README.md"), "# demo, updated\n");
    git(["add", "."], targetRepo);
    git(["commit", "-qam", "unrelated readme edit"], targetRepo);
  });
  afterAll(() => {
    rmSync(modelDir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  });

  it("diff-scoped: maps a changed path to its slice via implementedIn, a URL-only slice matches nothing, unmatched paths come back unmapped", () => {
    const r = em(["conform-scope", "checkout.em", "--repo", targetRepo], modelDir);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const doc = JSON.parse(r.stdout);
    expect(doc.lastConformance).toEqual({ date: expect.any(String), revision: baseRev });
    expect(doc.changedPaths.sort()).toEqual(["README.md", "src/checkout/Handler.kt"]);
    expect(doc.candidateSlices).toEqual([
      { key: "place-order", matchedBy: "implementedIn", paths: ["src/checkout/Handler.kt"] },
    ]);
    expect(doc.unmappedPaths).toEqual(["README.md"]);
  });

  it("--full scopes every implemented slice regardless of Last conformance, changedPaths/unmappedPaths empty", () => {
    const r = em(["conform-scope", "checkout.em", "--repo", targetRepo, "--full"], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.lastConformance).toEqual({ date: expect.any(String), revision: baseRev });
    expect(doc.changedPaths).toEqual([]);
    expect(doc.unmappedPaths).toEqual([]);
    expect(doc.candidateSlices.map((c: { key: string }) => c.key).sort()).toEqual(["place-order", "ship-order"]);
    expect(doc.candidateSlices.every((c: { matchedBy: string; paths: string[] }) => c.matchedBy === "full" && c.paths.length === 0)).toBe(true);
  });

  it("first run (Last conformance: never) behaves like --full without needing the flag, and never shells out to --repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-conform-scope-firstrun-"));
    try {
      const scaffolded = em(["scaffold", "Checkout"], cwd);
      expect(scaffolded.status).toBe(0);
      const freshDir = join(cwd, "checkout");
      writeFileSync(join(freshDir, "checkout.em"), MODEL);
      mkdirSync(join(freshDir, "slices"), { recursive: true });
      writeFileSync(join(freshDir, "slices", "place-order.md"), docWithImplementedIn("src/checkout"));
      writeFileSync(join(freshDir, "slices", "ship-order.md"), docWithImplementedIn("https://github.com/example/repo/pull/42"));

      // A --repo path that isn't even a git repository — proves first-run scoping never touches it.
      const r = em(["conform-scope", "checkout.em", "--repo", cwd], freshDir);
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.lastConformance).toBeNull();
      expect(doc.changedPaths).toEqual([]);
      expect(doc.candidateSlices.map((c: { key: string }) => c.key).sort()).toEqual(["place-order", "ship-order"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("--seed-asis writes a byte copy of the model and gitignores *-asis.em idempotently", () => {
    const r1 = em(["conform-scope", "checkout.em", "--repo", targetRepo, "--seed-asis"], modelDir);
    expect(r1.status).toBe(0);
    const doc1 = JSON.parse(r1.stdout);
    expect(doc1.seeded.asisPath).toBe("checkout-asis.em");
    expect(doc1.seeded.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(modelDir, "checkout-asis.em"), "utf8")).toBe(readFileSync(join(modelDir, "checkout.em"), "utf8"));
    const gitignore = readFileSync(join(modelDir, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/).filter((l) => l === "*-asis.em")).toHaveLength(1);

    const r2 = em(["conform-scope", "checkout.em", "--repo", targetRepo, "--seed-asis"], modelDir);
    expect(r2.status).toBe(0);
    const doc2 = JSON.parse(r2.stdout);
    expect(doc2.seeded.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(modelDir, ".gitignore"), "utf8").split(/\r?\n/).filter((l) => l === "*-asis.em")).toHaveLength(1);
  });

  it("no --seed-asis: no scratch model/gitignore side effects, no `seeded` key", () => {
    const r = em(["conform-scope", "checkout.em", "--repo", targetRepo], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.seeded).toBeUndefined();
  });

  it("surfaces a clear, non-zero error when --repo isn't a git repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "em-cli-conform-scope-norepo-"));
    try {
      const r = em(["conform-scope", "checkout.em", "--repo", notARepo], modelDir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is not a git repository");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("surfaces a clear, non-zero error on an unknown revision recorded in Last conformance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-conform-scope-badrev-"));
    try {
      const scaffolded = em(["scaffold", "Checkout"], cwd);
      expect(scaffolded.status).toBe(0);
      const badRevDir = join(cwd, "checkout");
      writeFileSync(join(badRevDir, "checkout.em"), MODEL);
      mkdirSync(join(badRevDir, "slices"), { recursive: true });
      writeFileSync(join(badRevDir, "slices", "place-order.md"), docWithImplementedIn("src/checkout"));
      writeFileSync(join(badRevDir, "slices", "ship-order.md"), docWithImplementedIn("https://github.com/example/repo/pull/42"));
      const setConformance = em(
        ["state", "set-conformance", "not-a-real-rev", "--report", "conformance/2026-08-01-report.md"],
        badRevDir,
      );
      expect(setConformance.status).toBe(0);

      const r = em(["conform-scope", "checkout.em", "--repo", targetRepo], badRevDir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("git diff failed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("em glossary (CLI)", () => {
  it("reports scale and 'no conflicts' in the default text report when models agree", () => {
    const r = em(["glossary", "glossary-a.em", "glossary-b-clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^2 models, \d+ terms?, 0 conflicts/);
    expect(r.stdout).toContain("no conflicts");
  });

  it("reports kind and field-type conflicts in the default text report", () => {
    const r = em(["glossary", "glossary-a.em", "glossary-b-conflict.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /kind-conflict "Order Confirmed": event in .*glossary-a\.em:2 \(slice "Submit"\), view in .*glossary-b-conflict\.em:3 \(slice "Confirm"\)/,
    );
    expect(r.stdout).toMatch(
      /field-type-conflict "total": Money on event "Order Confirmed" in .*glossary-a\.em:2, number on view "Order Confirmed" in .*glossary-b-conflict\.em:3/,
    );
  });

  it("--list-conflicts prints only the conflict lines, no scale summary", () => {
    const r = em(["glossary", "glossary-a.em", "glossary-b-conflict.em", "--list-conflicts"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/models?,.*terms?,.*conflicts?/);
    expect(r.stdout).toContain("kind-conflict");
    expect(r.stdout).toContain("field-type-conflict");
  });

  it("--list-conflicts reports when there are none", () => {
    const r = em(["glossary", "glossary-a.em", "glossary-b-clean.em", "--list-conflicts"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no conflicts");
  });

  it("--json prints a schema-versioned document; stdout stays clean JSON despite warnings on stderr", () => {
    const r = em(["glossary", "glossary-a.em", "glossary-b-conflict.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.glossarySchemaVersion).toBe("1.0");
    expect(doc.conflicts).toHaveLength(2);
    expect(r.stderr).toContain("not read by any read model");
  });

  it("-o without --json is a usage error", () => {
    const r = em(["glossary", "glossary-a.em", "-o", "out.json"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-o requires --json");
  });

  it("-o with --json writes the file and confirms on stdout", () => {
    const r = em(
      ["glossary", "glossary-a.em", "glossary-b-conflict.em", "--json", "-o", "glossary-out.json"],
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote glossary-out.json");
    const doc = JSON.parse(readFileSync(join(dir, "glossary-out.json"), "utf8"));
    expect(doc.glossarySchemaVersion).toBe("1.0");
  });

  it("--fail-on-conflicts exits 1 only when conflicts exist", () => {
    expect(
      em(["glossary", "glossary-a.em", "glossary-b-conflict.em", "--fail-on-conflicts"], dir).status,
    ).toBe(1);
    expect(
      em(["glossary", "glossary-a.em", "glossary-b-clean.em", "--fail-on-conflicts"], dir).status,
    ).toBe(0);
  });

  it("refuses on errors with a non-zero exit, prefixed with the offending file", () => {
    const r = em(["glossary", "glossary-a.em", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not building glossary");
    expect(r.stderr).toContain("error.em:");
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });
});

describe("em render --slice (CLI)", () => {
  it("defaults to slices/<kebab-slug>.svg next to the .em file", () => {
    const r = em(["render", "clean.em", "--slice", "Place"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`rendered ${join("slices", "place.svg")}`);
    expect(existsSync(join(dir, "slices", "place.svg"))).toBe(true);
  });

  it("-o overrides the default output path", () => {
    const r = em(["render", "clean.em", "--slice", "Open Orders", "-o", "open-orders-diagram.svg"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("rendered open-orders-diagram.svg");
    expect(existsSync(join(dir, "open-orders-diagram.svg"))).toBe(true);
  });

  it("-T png renders the slice diagram as a valid PNG", () => {
    const r = em(["render", "clean.em", "--slice", "Place", "-o", "place-slice.png"], dir);
    expect(r.status).toBe(0);
    const png = readFileSync(join(dir, "place-slice.png"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("exits 1 on an unknown slice name, listing every valid slice", () => {
    const r = em(["render", "clean.em", "--slice", "Nope"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no slice named "Nope"');
    expect(r.stderr).toContain('"Place"');
    expect(r.stderr).toContain('"Open Orders"');
  });

  it("--keep-empty-lanes is threaded through, not silently dropped", () => {
    const collapsed = em(["render", "ui-only.em", "--slice", "Just A Screen", "-o", "no-lanes.svg"], dir);
    expect(collapsed.status).toBe(0);
    expect(readFileSync(join(dir, "no-lanes.svg"), "utf8")).not.toContain(">API<");

    const kept = em(
      ["render", "ui-only.em", "--slice", "Just A Screen", "--keep-empty-lanes", "-o", "with-lanes.svg"],
      dir,
    );
    expect(kept.status).toBe(0);
    expect(readFileSync(join(dir, "with-lanes.svg"), "utf8")).toContain(">API<");
  });

  it("rejects --slice combined with --emit-dot", () => {
    const r = em(["render", "clean.em", "--slice", "Place", "--emit-dot"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--slice cannot be combined with --emit-dot");
  });
});

describe("em catalog (CLI)", () => {
  it("writes an index + per-model diagram + slice pages, and reports counts on stdout", () => {
    const r = em(["catalog", "clean.em", "-o", "catalog-out"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote catalog-out/ (1 model, 2 slices)");
    expect(existsSync(join(dir, "catalog-out", "index.html"))).toBe(true);
    expect(existsSync(join(dir, "catalog-out", "clean", "diagram.svg"))).toBe(true);
    // per-slice diagrams, built fresh since clean.em has no slices/*.svg siblings
    expect(existsSync(join(dir, "catalog-out", "clean", "slices", "place.svg"))).toBe(true);
    expect(existsSync(join(dir, "catalog-out", "clean", "slices", "open-orders.svg"))).toBe(true);
  });

  it("accepts multiple files, one output directory per model, plural counts on stdout", () => {
    const r = em(["catalog", "clean.em", "glossary-a.em", "-o", "catalog-multi"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^wrote catalog-multi\/ \(2 models, \d+ slices\)/);
    expect(existsSync(join(dir, "catalog-multi", "clean", "diagram.svg"))).toBe(true);
    expect(existsSync(join(dir, "catalog-multi", "glossary-a", "diagram.svg"))).toBe(true);
  });

  it("refuses on a missing file with a clear, non-zero-exit error", () => {
    const r = em(["catalog", "does-not-exist.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read does-not-exist.em");
  });

  it("refuses on validation errors with a non-zero exit", () => {
    const r = em(["catalog", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not building catalog");
  });

  it("rejects an unsupported --format before touching any file", () => {
    const r = em(["catalog", "clean.em", "-T", "pdf"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unsupported --format 'pdf'");
  });

  it("surfaces ref-collision warnings (duplicate slice names) on stderr, prefixed with the file", () => {
    const r = em(["catalog", "catalog-duplicate.em", "-o", "catalog-dup"], dir);
    expect(r.status).toBe(0); // a collision is a warning, not an error — the build still succeeds
    expect(r.stderr).toContain("catalog-duplicate.em:");
    expect(r.stderr).toContain('duplicate slice name "Place Order"');
  });
});

describe("em slice index (CLI, MIL-98)", () => {
  // Table-building/marker-rewrite coverage lives in test/sliceIndex.test.ts (pure functions);
  // this block is exit-code/process-level only, own dir since it needs a README.md sibling
  // none of the other fixtures above carry.
  let sliceIndexDir: string;
  beforeAll(() => {
    sliceIndexDir = mkdtempSync(join(tmpdir(), "em-cli-slice-index-"));
    writeFileSync(join(sliceIndexDir, "clean.em"), CLEAN);
    writeFileSync(join(sliceIndexDir, "error.em"), WITH_ERROR);
    writeFileSync(
      join(sliceIndexDir, "README.md"),
      "# Demo\n\n## Slices\n<!-- GENERATED:slices:start -->\n<!-- GENERATED:slices:end -->\n\n## Status\n",
    );
  });
  afterAll(() => rmSync(sliceIndexDir, { recursive: true, force: true }));

  it("writes the sibling README.md's Slices table and confirms on stdout", () => {
    const r = em(["slice", "index", "clean.em"], sliceIndexDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote README.md");
    const readme = readFileSync(join(sliceIndexDir, "README.md"), "utf8");
    expect(readme).toContain("| 1 | Place | State Change | no doc yet | — | [slices/place.md](slices/place.md) |");
    expect(readme).toContain("Open Orders");
  });

  it("--check exits 0 and reports up to date once the table matches", () => {
    const r = em(["slice", "index", "clean.em", "--check"], sliceIndexDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("--check exits non-zero and never writes when the table is stale", () => {
    // Regenerate against a rename of the same file, since editing a plain .em model doesn't
    // change the generated table without changing the model itself — instead corrupt the
    // README's own generated block directly to simulate drift (a hand-edit or a stale commit).
    const staleDir = mkdtempSync(join(tmpdir(), "em-cli-slice-index-stale-"));
    try {
      writeFileSync(join(staleDir, "clean.em"), CLEAN);
      writeFileSync(
        join(staleDir, "README.md"),
        "# Demo\n\n## Slices\n<!-- GENERATED:slices:start -->\nstale content\n<!-- GENERATED:slices:end -->\n",
      );
      const before = readFileSync(join(staleDir, "README.md"), "utf8");
      const r = em(["slice", "index", "clean.em", "--check"], staleDir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("stale");
      expect(readFileSync(join(staleDir, "README.md"), "utf8")).toBe(before); // never written
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }
  });

  it("refuses with a clear error, naming the expected path, when README.md is missing", () => {
    const noReadmeDir = mkdtempSync(join(tmpdir(), "em-cli-slice-index-no-readme-"));
    try {
      writeFileSync(join(noReadmeDir, "clean.em"), CLEAN);
      const r = em(["slice", "index", "clean.em"], noReadmeDir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("expected a README.md");
      expect(r.stderr).toContain("README.md");
      expect(existsSync(join(noReadmeDir, "README.md"))).toBe(false);
    } finally {
      rmSync(noReadmeDir, { recursive: true, force: true });
    }
  });

  it("refuses with a clear error, pointing at the template, when the markers are missing", () => {
    const noMarkersDir = mkdtempSync(join(tmpdir(), "em-cli-slice-index-no-markers-"));
    try {
      writeFileSync(join(noMarkersDir, "clean.em"), CLEAN);
      writeFileSync(join(noMarkersDir, "README.md"), "# Demo\n\n## Slices\nhand-written\n");
      const before = readFileSync(join(noMarkersDir, "README.md"), "utf8");
      const r = em(["slice", "index", "clean.em"], noMarkersDir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("markers");
      expect(r.stderr).toContain("model-readme.md");
      expect(readFileSync(join(noMarkersDir, "README.md"), "utf8")).toBe(before); // never written
    } finally {
      rmSync(noMarkersDir, { recursive: true, force: true });
    }
  });

  it("refuses on validation errors before touching the README", () => {
    const r = em(["slice", "index", "error.em"], sliceIndexDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not indexing");
  });
});

describe("em slice new (CLI, MIL-97 item 3)", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-slice-new-"));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it("writes slices/<key>.md with the 5-key frontmatter and body stub, creating slices/", () => {
    expect(existsSync(join(cwd, "slices"))).toBe(false);
    const r = em(
      ["slice", "new", "Request Payment", "--pattern", "automation", "--swimlane", "System → Payment"],
      cwd,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("wrote slices/request-payment.md");
    expect(existsSync(join(cwd, "slices"))).toBe(true);

    const content = readFileSync(join(cwd, "slices", "request-payment.md"), "utf8");
    expect(content).toBe(
      "---\n" +
        "schemaVersion: 1\n" +
        "pattern: automation\n" +
        "swimlane: System → Payment\n" +
        "status: draft\n" +
        "version: 1\n" +
        "---\n" +
        "# Slice: Request Payment\n" +
        "\n" +
        "![Diagram](./request-payment.svg)\n",
    );
  });

  it("prints the note line the user must add to the .em file", () => {
    const r = em(
      ["slice", "new", "Some Other Slice", "--pattern", "state-view", "--swimlane", "Customer → Orders"],
      cwd,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('note "slices/some-other-slice.md"');
  });

  it("kebab-slugs the display name for the filename, keeping the display name in the heading", () => {
    const r = em(
      ["slice", "new", "Weird!! Name_2", "--pattern", "translation", "--swimlane", "A → B"],
      cwd,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote slices/weird-name-2.md");
    const content = readFileSync(join(cwd, "slices", "weird-name-2.md"), "utf8");
    expect(content).toContain("# Slice: Weird!! Name_2");
  });

  it("fails clearly when --pattern is omitted", () => {
    const r = em(["slice", "new", "No Pattern", "--swimlane", "A → B"], cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--pattern");
    expect(existsSync(join(cwd, "slices", "no-pattern.md"))).toBe(false);
  });

  it("fails clearly when --swimlane is omitted", () => {
    const r = em(["slice", "new", "No Swimlane", "--pattern", "automation"], cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--swimlane");
    expect(existsSync(join(cwd, "slices", "no-swimlane.md"))).toBe(false);
  });

  it("rejects an invalid --pattern, listing the 4 valid values", () => {
    const r = em(
      ["slice", "new", "Bad Pattern", "--pattern", "bogus", "--swimlane", "A → B"],
      cwd,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bogus");
    expect(r.stderr).toContain("state-change");
    expect(r.stderr).toContain("state-view");
    expect(r.stderr).toContain("automation");
    expect(r.stderr).toContain("translation");
    expect(existsSync(join(cwd, "slices", "bad-pattern.md"))).toBe(false);
  });

  it("refuses to overwrite an existing doc without --force", () => {
    const r = em(
      ["slice", "new", "Request Payment", "--pattern", "automation", "--swimlane", "System → Payment"],
      cwd,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to overwrite slices/request-payment.md (use --force)");
  });

  it("--force overwrites an existing doc", () => {
    writeFileSync(join(cwd, "slices", "request-payment.md"), "hand-edited, should be clobbered\n");
    const r = em(
      [
        "slice",
        "new",
        "Request Payment",
        "--pattern",
        "state-change",
        "--swimlane",
        "System → Payment v2",
        "--force",
      ],
      cwd,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote slices/request-payment.md");
    const content = readFileSync(join(cwd, "slices", "request-payment.md"), "utf8");
    expect(content).toContain("pattern: state-change\n");
    expect(content).toContain("swimlane: System → Payment v2\n");
  });
});

// `em migrate` (MIL-125): CLI-level coverage — dry-run-by-default, `--write`, exit codes, and
// that a real file on disk really is (or isn't) touched. Detection/rewrite-text coverage itself
// lives in test/migrateReactionShape.test.ts; this only exercises the cli.ts wiring around it.
describe("em migrate (CLI, real fs, MIL-125)", () => {
  let dir: string;

  const OLD_SHAPE = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;

  const MIGRATED_SHAPE = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}

slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dry run (default, no --write) reports the plan and writes nothing", () => {
    writeFileSync(join(dir, "model.em"), OLD_SHAPE);
    const r = em(["migrate", "model.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('migrated slice "Payments To Process" / "Capture Payment"');
    expect(r.stdout).toContain("1 site(s) would migrate (dry run — re-run with --write to apply)");
    expect(readFileSync(join(dir, "model.em"), "utf8")).toBe(OLD_SHAPE); // untouched
  });

  it("--write applies the rewrite to the file on disk", () => {
    writeFileSync(join(dir, "model.em"), OLD_SHAPE);
    const r = em(["migrate", "model.em", "--write"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote model.em — 1 site(s) migrated");
    expect(readFileSync(join(dir, "model.em"), "utf8")).toBe(MIGRATED_SHAPE);
  });

  it("a second --write run is idempotent: reports nothing to migrate, changes nothing", () => {
    writeFileSync(join(dir, "model.em"), OLD_SHAPE);
    em(["migrate", "model.em", "--write"], dir);
    const r = em(["migrate", "model.em", "--write"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to migrate");
    expect(readFileSync(join(dir, "model.em"), "utf8")).toBe(MIGRATED_SHAPE);
  });

  it("nothing to migrate on a file with no Automation/Translation slices", () => {
    writeFileSync(
      join(dir, "model.em"),
      'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n',
    );
    const r = em(["migrate", "model.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to migrate");
  });

  it("exits non-zero and writes nothing when a site is refused, even under --write", () => {
    const ambiguous = `slice "Leading" {
  view Read Model from "Some Event"
  processor First
  automation Second
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;
    writeFileSync(join(dir, "model.em"), ambiguous);
    const r = em(["migrate", "model.em", "--write"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("refused");
    expect(r.stdout).toContain("more than one reaction");
    expect(readFileSync(join(dir, "model.em"), "utf8")).toBe(ambiguous); // untouched — no clean sites either
  });

  it("still migrates unambiguous sites under --write while reporting a refusal elsewhere (exit 1)", () => {
    const mixed =
      `slice "Leading" {
  view Read Model from "Some Event"
  processor First
  automation Second
}

slice "Following" {
  command Do Thing
  event Thing Done
}

` + OLD_SHAPE;
    writeFileSync(join(dir, "model.em"), mixed);
    const r = em(["migrate", "model.em", "--write"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("refused");
    expect(r.stdout).toContain("migrated");
    const written = readFileSync(join(dir, "model.em"), "utf8");
    expect(written).toContain('processor Payment Gateway from "Payments To Process"');
    expect(written).toContain("automation Second"); // the refused pair is untouched
  });

  it("refuses on a missing file with a clear, non-zero-exit error", () => {
    const r = em(["migrate", "does-not-exist.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read does-not-exist.em");
  });

  it("reports a parse error and exits non-zero without writing", () => {
    writeFileSync(join(dir, "model.em"), 'slice "Broken" {\n  command Foo\n');
    const r = em(["migrate", "model.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("parse error in model.em");
  });
});
