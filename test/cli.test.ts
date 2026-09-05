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

// `em export --slice`/`em validate --slice-ready` scoping fixture (MIL-128): one genuinely
// complete slice ("Good") and a second, unrelated slice ("Bad") with its own real error — the
// case where scoping to one slice must not be blocked by breakage elsewhere in the model.
const SCOPED_ERROR = `slice "Good" {
  ui Screen @Customer
  command Do Thing
  event Thing Done
}
slice "Bad" {
  view Broken View from "No Such Event"
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
  writeFileSync(join(dir, "scoped-error.em"), SCOPED_ERROR);
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
    expect(doc.schemaVersion).toBe("1.9");
  });

  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["export", "warn.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.schemaVersion).toBe("1.9");
    expect(r.stderr).toContain("produces no event");
  });

  it("refuses on errors with a non-zero exit", () => {
    const r = em(["export", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not exporting");
  });
});

describe("em export --slice <key> (CLI, MIL-128)", () => {
  it("exports just the named slice's object — same pattern/fields/doc shape as the full export's slice entry", () => {
    const r = em(["export", "clean.em", "--slice", "place"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.schemaVersion).toBe("1.9");
    expect(doc.sliceKey).toBe("place");
    expect(doc.slice.key).toBe("place");
    expect(doc.slice.name).toBe("Place");
    expect(doc.slice.pattern).toBe("state-change");
    expect(doc.slice.elements.map((e: { kind: string }) => e.kind)).toEqual(["ui", "command", "event"]);
    expect(doc.slice.doc).toEqual({
      found: false,
      path: "slices/place.md",
      reason: "no-doc-bound",
      status: null,
      version: null,
      implementedIn: null,
      splitFrom: null,
      mergedFrom: [],
      supersededBy: [],
      driftSignal: null,
      ratifiedBy: null,
      ratifiedOn: null,
      owner: null,
      tracking: null,
    });
    // Only the one slice's object — never the whole model's slices array.
    expect(doc.model).toBeUndefined();
  });

  it("errors with a clear message for an unknown export key", () => {
    const r = em(["export", "clean.em", "--slice", "no-such-slice"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no slice with export key "no-such-slice"');
  });

  it("refuses when the named slice itself has an error", () => {
    const r = em(["export", "error.em", "--slice", "read"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "read" has errors');
  });

  it("still exports the named slice despite a genuine error in an unrelated slice (the whole point of scoping)", () => {
    const r = em(["export", "scoped-error.em", "--slice", "good"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.sliceKey).toBe("good");
    expect(doc.slice.name).toBe("Good");
    // The unrelated slice's own error is real and still printed to stderr (visible, just not
    // blocking) — same "surfaced but not gating" shape as `--slice-ready`'s own regression test.
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });

  it("refuses that same file scoped to the broken slice itself", () => {
    const r = em(["export", "scoped-error.em", "--slice", "bad"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "bad" has errors');
  });

  it("-o writes just the scoped document to a file", () => {
    const r = em(["export", "clean.em", "--slice", "place", "-o", "slice-out.json"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote slice-out.json");
    const doc = JSON.parse(readFileSync(join(dir, "slice-out.json"), "utf8"));
    expect(doc.sliceKey).toBe("place");
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

describe("em validate --json (CLI, MIL-128)", () => {
  it("prints a clean, parseable diagnostics document on a fully clean model", () => {
    const r = em(["validate", "clean.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.validateSchemaVersion).toBe("1.0");
    expect(doc.file).toBe("clean.em");
    expect(doc.ok).toBe(true);
    expect(doc.summary).toEqual({ errors: 0, warnings: 0, total: 0 });
    expect(doc.diagnostics).toEqual([]);
  });

  it("carries usageCategory (sourced from RULES) alongside code/refs/line on a warning-only model", () => {
    const r = em(["validate", "warn.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.summary.errors).toBe(0);
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "both-ends-of-a-flow/command-no-event",
          usageCategory: "command produces no event",
        }),
      ]),
    );
    // Every diagnostic in the array carries usageCategory, not just the one asserted above.
    for (const d of doc.diagnostics) expect(typeof d.usageCategory).toBe("string");
  });

  it("works on a model WITH errors — the whole point of MIL-128 (em export refuses; this doesn't)", () => {
    const r = em(["validate", "error.em", "--json"], dir);
    expect(r.status).toBe(1); // same exit code as text mode
    const doc = JSON.parse(r.stdout); // stdout stays clean JSON even though the run "fails"
    expect(doc.ok).toBe(false);
    expect(doc.summary.errors).toBe(1);
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "view-from-unresolved",
          usageCategory: "view references unknown event",
        }),
      ]),
    );
    // Warnings/errors are still printed to stderr too, same convention as em export/em diff --json.
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });

  it("exits identically to text mode (errors gate, warnings don't)", () => {
    expect(em(["validate", "clean.em", "--json"], dir).status).toBe(0);
    expect(em(["validate", "warn.em", "--json"], dir).status).toBe(0);
    expect(em(["validate", "error.em", "--json"], dir).status).toBe(1);
  });
});

describe("em validate --list-issues/--list-divergences/--list-public --json (CLI, MIL-128)", () => {
  it("--list-issues --json emits a structured marker instead of the eyeball line", () => {
    const r = em(["validate", "--list-issues", "issue.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.validateListSchemaVersion).toBe("1.0");
    expect(doc.markers).toEqual([
      {
        markerKind: "issue",
        sliceKey: "place",
        sliceName: "Place",
        elementRef: "place/command.place-order",
        elementKind: "command",
        elementName: "Place Order",
        text: "who validates the discount code?",
        line: 2,
      },
    ]);
  });

  it("--list-divergences --json", () => {
    const r = em(["validate", "--list-divergences", "divergence.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.markers).toEqual([
      expect.objectContaining({
        markerKind: "divergence",
        sliceKey: "retire",
        elementKind: "view",
        elementName: "Retired Orders",
        text: "tracking token covers idempotency",
        line: 6,
      }),
    ]);
  });

  it("--list-public --json — only the public elements, with elementRef", () => {
    const r = em(["validate", "--list-public", "public.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.markers).toHaveLength(2);
    expect(doc.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ markerKind: "public", elementKind: "event", elementName: "Order Placed", text: null }),
        expect.objectContaining({ markerKind: "public", elementKind: "view", elementName: "Open Orders", text: null }),
      ]),
    );
    expect(doc.markers.some((m: { elementName: string }) => m.elementName === "Internal Retry")).toBe(false);
  });

  it("an empty list reports an empty markers array, not an error", () => {
    const r = em(["validate", "--list-issues", "clean.em", "--json"], dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).markers).toEqual([]);
  });

  it("still reports errors (JSON diagnostics + non-zero exit) alongside the list", () => {
    const r = em(["validate", "--list-issues", "error.em", "--json"], dir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.markers).toEqual([]);
    expect(doc.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "view-from-unresolved" })]);
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
    // MIL-148: an otherwise fully-ready slice (same complete ui -> command -> event -> view ->
    // ui flow as `ready.em`, so no both-ends-of-a-flow warnings) whose event carries a field
    // the command never supplies — the system-assigned-field pattern (server-minted ID,
    // decision-time timestamp). `withoutMarker` reproduces the bug (fields-completeness blocks
    // a slice with nothing else wrong); `withMarker` is the same slice with `assigned` added,
    // demonstrating the fix.
    writeFileSync(
      join(readyDir, "assigned-without-marker.em"),
      `slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md" { customerId }\n  event Thing Done { customerId, thingId }\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n`,
    );
    writeFileSync(
      join(readyDir, "assigned-with-marker.em"),
      `slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md" { customerId }\n  event Thing Done { customerId, thingId assigned }\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n`,
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

  it("blocks (exit 1) on a system-assigned event field with no `assigned` marker (MIL-148)", () => {
    const r = em(["validate", "assigned-without-marker.em", "--slice-ready", "ready-slice"], readyDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('slice "ready-slice" is NOT ready-to-implement');
    expect(r.stderr).toContain('event "Thing Done" field "thingId" not provided by command "Do Thing"');
  });

  it("stays ready (exit 0) once the system-assigned field is marked `assigned` (MIL-148)", () => {
    const r = em(["validate", "assigned-with-marker.em", "--slice-ready", "ready-slice"], readyDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('slice "ready-slice" is ready-to-implement');
  });

  it("--json: all 4 gates pass and the verdict is ready, for a bound/ready/fully-checked doc (MIL-128)", () => {
    const r = em(["validate", "ready.em", "--slice-ready", "ready-slice", "--json"], readyDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.validateSliceReadySchemaVersion).toBe("1.0");
    expect(doc.sliceKey).toBe("ready-slice");
    expect(doc.gates).toEqual({
      docBound: true,
      frontmatterUsable: true,
      statusReady: true,
      noUncheckedOpenQuestions: true,
    });
    expect(doc.ready).toBe(true);
    expect(doc.diagnostics).toEqual([]);
  });

  it("--json: names each failing gate individually for status: draft with unchecked Open Questions", () => {
    const r = em(["validate", "draft.em", "--slice-ready", "draft-slice", "--json"], readyDir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.gates).toEqual({
      docBound: true,
      frontmatterUsable: true,
      statusReady: false,
      noUncheckedOpenQuestions: false,
    });
    expect(doc.ready).toBe(false);
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "slice-ready-status-not-ready", usageCategory: expect.any(String) }),
        expect.objectContaining({ code: "slice-ready-open-questions-unchecked" }),
      ]),
    );
  });

  it("--json: docBound is false, other gates false, when no note binds a doc", () => {
    const r = em(["validate", "unbound.em", "--slice-ready", "unbound", "--json"], readyDir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.gates).toEqual({
      docBound: false,
      frontmatterUsable: false,
      statusReady: false,
      noUncheckedOpenQuestions: false,
    });
    expect(doc.ready).toBe(false);
  });

  it("--json: gates is null for a key that names no slice", () => {
    const r = em(["validate", "ready.em", "--slice-ready", "no-such-key", "--json"], readyDir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.gates).toBeNull();
    expect(doc.ready).toBe(false);
    expect(doc.diagnostics).toEqual([
      expect.objectContaining({ code: "slice-ready-unknown-slice" }),
    ]);
  });

  it("--json: ready is not simply AND(gates) — all 4 gates pass yet ready is false when a diagnostic is scoped to the slice", () => {
    // "ready-with-own-issue.em" (see beforeAll) binds ready-slice.md (bound, usable,
    // ready-to-implement, fully checked — all 4 gates true) but its own command has no `ui`
    // triggering it, which raises a both-ends-of-a-flow diagnostic scoped to this slice. `ready`
    // is the AND of the 4 gates only when there's nothing ELSE scoped to the slice — this
    // pins that distinction down at the JSON level, not just the gates themselves.
    const r = em(["validate", "ready-with-own-issue.em", "--slice-ready", "ready-slice", "--json"], readyDir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.gates).toEqual({
      docBound: true,
      frontmatterUsable: true,
      statusReady: true,
      noUncheckedOpenQuestions: true,
    });
    expect(doc.ready).toBe(false);
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "both-ends-of-a-flow/command-untriggered" })]),
    );
  });

  it("--json: stays ready despite a genuine error in an unrelated slice (regression, same as text mode)", () => {
    const r = em(["validate", "ready-with-unrelated-error.em", "--slice-ready", "ready-slice", "--json"], readyDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.ready).toBe(true);
    expect(doc.gates).toEqual({
      docBound: true,
      frontmatterUsable: true,
      statusReady: true,
      noUncheckedOpenQuestions: true,
    });
  });
});

describe("em diff --json (CLI)", () => {
  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["diff", "clean.em", "warn.em", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning/report text leaked into stdout
    expect(doc.diffSchemaVersion).toBe("1.7");
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

describe("em coverage (CLI, real fs, MIL-130)", () => {
  let dir: string, tests: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-coverage-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    tests = join(dir, "tests");
    mkdirSync(tests, { recursive: true });

    writeFileSync(
      join(dir, "model.em"),
      `slice "Place" {\n  ui Checkout @Customer\n  command Place Order note "slices/place.md"\n  event Order Placed\n}\n` +
        `slice "Open Orders" {\n  view Open Orders from "Order Placed"\n  ui Order List @Customer\n}\n`,
    );
    writeFileSync(
      join(dir, "slices", "place.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n" +
        "## Invariants / Business Rules\n- **INV-1:** rejects a negative amount\n- **INV-2:** rejects an empty cart\n",
    );
    // "INV-1" is cited; "INV-2" is not.
    writeFileSync(join(tests, "place.test.ts"), `it("rejects a negative amount (INV-1)", () => {});\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("text mode reports cited/uncovered per invariant with citations, plus a summary line", () => {
    const r = em(["coverage", "model.em", "--tests", "tests"], dir);
    expect(r.status).toBe(0); // advisory by default
    expect(r.stdout).toContain('slice "place" (ready-to-implement):');
    expect(r.stdout).toContain("cited     INV-1");
    expect(r.stdout).toContain("place.test.ts:1");
    expect(r.stdout).toContain("uncovered INV-2");
    expect(r.stdout).toContain("2 invariant(s) checked, 1 uncovered");
  });

  it("--json prints a versioned document with per-slice invariant citations", () => {
    const r = em(["coverage", "model.em", "--tests", "tests", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.coverageSchemaVersion).toBe("1.0");
    expect(doc.file).toBe("model.em");
    expect(doc.testsDir).toBe("tests");
    expect(doc.ok).toBe(false);
    expect(doc.summary).toEqual({ totalInvariants: 2, cited: 1, uncovered: 1 });

    const place = doc.slices.find((s: { key: string }) => s.key === "place");
    expect(place.inScope).toBe(true);
    expect(place.status).toBe("ready-to-implement");
    expect(place.docReason).toBeNull();
    expect(place.invariants).toContainEqual({ id: "INV-1", cited: true, citations: [{ file: "place.test.ts", line: 1 }] });
    expect(place.invariants).toContainEqual({ id: "INV-2", cited: false, citations: [] });

    const openOrders = doc.slices.find((s: { key: string }) => s.key === "open-orders");
    expect(openOrders.inScope).toBe(false);
    expect(openOrders.status).toBeNull();
    expect(openOrders.docReason).toBe("no-doc-bound");
    expect(openOrders.invariants).toEqual([]);
  });

  it("advisory mode exits 0 even with uncovered IDs; --strict exits non-zero", () => {
    const advisory = em(["coverage", "model.em", "--tests", "tests"], dir);
    expect(advisory.status).toBe(0);
    const strict = em(["coverage", "model.em", "--tests", "tests", "--strict"], dir);
    expect(strict.status).toBe(1);
  });

  it("--strict exits 0 when nothing is uncovered", () => {
    const fullyCovered = mkdtempSync(join(tmpdir(), "em-cli-coverage-full-"));
    mkdirSync(join(fullyCovered, "slices"), { recursive: true });
    mkdirSync(join(fullyCovered, "tests"), { recursive: true });
    writeFileSync(
      join(fullyCovered, "model.em"),
      `slice "Place" {\n  command Place Order note "slices/place.md"\n  event Order Placed\n}\n` +
        `slice "Reads" {\n  view Order List from "Order Placed"\n  ui Screen @Customer\n}\n`,
    );
    writeFileSync(
      join(fullyCovered, "slices", "place.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: PR#1\n---\n" +
        "- **INV-1:** rejects a negative amount\n",
    );
    writeFileSync(join(fullyCovered, "tests", "place.test.ts"), `it("INV-1 holds", () => {});\n`);

    const r = em(["coverage", "model.em", "--tests", "tests", "--strict"], fullyCovered);
    expect(r.status).toBe(0);
    rmSync(fullyCovered, { recursive: true, force: true });
  });

  it("errors when --tests names a directory that doesn't exist", () => {
    const r = em(["coverage", "model.em", "--tests", "no-such-dir"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em coverage: --tests directory not found: no-such-dir");
  });

  it("requires --tests", () => {
    const r = em(["coverage", "model.em"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("required option '--tests <dir>' not specified");
  });

  it("gives a friendly error when --tests names a file, not a directory", () => {
    const r = em(["coverage", "model.em", "--tests", "model.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em coverage: --tests is not a directory: model.em");
  });

  it("fails with model errors before even looking at --tests", () => {
    const badDir = mkdtempSync(join(tmpdir(), "em-cli-coverage-bad-"));
    writeFileSync(join(badDir, "model.em"), `slice "Broken" {\n  view Bad from "No Such Event"\n}\n`);
    const r = em(["coverage", "model.em", "--tests", "no-such-dir"], badDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em coverage: model has errors — fix them first");
    rmSync(badDir, { recursive: true, force: true });
  });
});

describe("em skill sync / em skill check (CLI, real fs, MIL-93)", () => {
  let target: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), "em-cli-skillsync-"));
  });
  afterAll(() => rmSync(target, { recursive: true, force: true }));

  it("sync materializes the packaged skill bundle into [path]/.claude/skills/", () => {
    const r = em(["skill", "sync", target], ROOT);
    expect(r.status).toBe(0);
    expect(existsSync(join(target, ".claude", "skills", "event-modeling", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "event-modeling-discover", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "event-modeling-shared", "reference", "em-dsl.md"))).toBe(true);
    expect(r.stdout).toContain("added: event-modeling/SKILL.md");
    expect(r.stdout).toContain("added: event-modeling-shared/reference/em-dsl.md");
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
    expect(r.stdout).toContain("[event-modeling]");
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

describe("em contract (CLI, MIL-129)", () => {
  it("prints the packaged event-modeling-implement/reference/implement.md verbatim", () => {
    const r = em(["contract"], ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      readFileSync(join(ROOT, ".claude", "skills", "event-modeling-implement", "reference", "implement.md"), "utf8"),
    );
    expect(r.stdout).toContain("Gate: verify readiness before starting");
    expect(r.stdout).toContain("em validate <model>.em --slice-ready <slice-key> --json");
  });
});

describe("em mcp (CLI, MIL-21)", () => {
  it("starts a stdio MCP server that responds to initialize + tools/list", async () => {
    // Full end-to-end coverage of every tool's behavior lives in test/mcp.test.ts (in-memory
    // transport, direct against createServer()); this is discoverability coverage — `em mcp`
    // really does start the same server over real stdio, the way an MCP client config
    // (`"command": "em"`, `"args": ["mcp"]`) would invoke it.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, CLI, "mcp"],
      cwd: ROOT,
      stderr: "ignore",
    });
    const client = new Client({ name: "em-cli-mcp-smoke-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "em" });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "changelog",
          "conform_scope",
          "contract",
          "coverage",
          "diff",
          "export_model",
          "export_slice",
          "freshness",
          "glossary",
          "list_markers",
          "slice_ready",
          "status",
          "validate",
        ].sort(),
      );
    } finally {
      await client.close();
    }
  });
});

describe("em skill install / em skill sync: AGENTS.md managed section (CLI, real fs, MIL-129)", () => {
  it("skill sync writes the AGENTS.md agent-contract section by default", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-sync-"));
    try {
      const r = em(["skill", "sync", target], ROOT);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("created");
      expect(r.stdout).toContain("AGENTS.md");

      const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("<!-- GENERATED:agent-contract:start -->");
      expect(agentsMd).toContain("em contract");
      expect(agentsMd).toContain("em validate <model>.em --slice-ready <slice-key> --json");
      expect(agentsMd).toContain("em export <model>.em --slice <slice-key>");
      expect(agentsMd).toContain("em-mcp");

      // Idempotent: a second sync with nothing else changed leaves AGENTS.md byte-identical.
      const r2 = em(["skill", "sync", target], ROOT);
      expect(r2.status).toBe(0);
      expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe(agentsMd);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("skill sync --no-agents-md skips AGENTS.md entirely", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-optout-"));
    try {
      const r = em(["skill", "sync", target, "--no-agents-md"], ROOT);
      expect(r.status).toBe(0);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("skill install also writes the AGENTS.md agent-contract section by default", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-install-"));
    try {
      const r = em(["skill", "install"], target);
      expect(r.status).toBe(0);
      const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("em contract");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("skill install already installed without --force still writes/updates AGENTS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-install-noop-"));
    try {
      // First install: creates the vendored skill and AGENTS.md.
      const r1 = em(["skill", "install"], target);
      expect(r1.status).toBe(0);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);

      // Simulate a stale/hand-edited AGENTS.md so we can tell the second
      // (no-op skill copy) install actually re-synced it.
      writeFileSync(join(target, "AGENTS.md"), "# Notes\n\nHand-written project notes.\n");

      const r2 = em(["skill", "install"], target);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain("skill already installed at");
      expect(r2.stdout).toContain("AGENTS.md");

      const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("# Notes");
      expect(agentsMd).toContain("<!-- GENERATED:agent-contract:start -->");
      expect(agentsMd).toContain("em contract");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("skill install --no-agents-md skips AGENTS.md even when already installed", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-install-noop-optout-"));
    try {
      const r1 = em(["skill", "install"], target);
      expect(r1.status).toBe(0);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
      rmSync(join(target, "AGENTS.md"));

      const r2 = em(["skill", "install", "--no-agents-md"], target);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain("skill already installed at");
      expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("preserves user content outside the markers on an existing AGENTS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "em-cli-agentsmd-preserve-"));
    try {
      writeFileSync(join(target, "AGENTS.md"), "# Notes\n\nHand-written project notes.\n");
      const r = em(["skill", "sync", target], ROOT);
      expect(r.status).toBe(0);

      const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("# Notes");
      expect(agentsMd).toContain("Hand-written project notes.");
      expect(agentsMd).toContain("<!-- GENERATED:agent-contract:start -->");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("em scaffold (CLI, real fs, MIL-97 item 2)", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-scaffold-"));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it("creates <slug>/ with all 3 files, correctly titled/slugged", () => {
    const r = em(["scaffold", "Order Fulfillment"], cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("scaffolded order-fulfillment/");

    const dir = join(cwd, "order-fulfillment");
    expect(existsSync(join(dir, "order-fulfillment.em"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".event-modeling.md"))).toBe(true);
    // The retired static file:// viewer (MIL-141) must NOT come back.
    expect(existsSync(join(dir, "live.html"))).toBe(false);

    const em_ = readFileSync(join(dir, "order-fulfillment.em"), "utf8");
    expect(em_.startsWith('model "Order Fulfillment"\n')).toBe(true);

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# Order Fulfillment\n")).toBe(true);
    expect(readme).toContain("em watch order-fulfillment.em -o order-fulfillment.svg --serve");
    expect(readme).toContain(
      "<!-- GENERATED:slices:start -->\n" +
        "| # | Slice | Pattern | Status | Ratified by | Owner | Tracking | Implemented in | Design doc |\n" +
        "|---|-------|---------|--------|-------------|-------|----------|----------------|------------|\n" +
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
    for (const text of [em_, readme, state]) {
      expect(text).not.toMatch(/\{\{[^}]*\}\}/);
    }
  });

  // MIL-147: the starter model once hard-coded the pre-MIL-120 two-slice Automation split
  // (a bare `processor` in the read-model slice, paired with a same-named command slice) —
  // `em validate` rejected it out of the box. Gate on the merged single-slice shape so a
  // regression here is caught the same way a hand-authored model's would be.
  it("scaffolds a starter model that passes `em validate` with zero diagnostics", () => {
    const dir = join(cwd, "order-fulfillment");
    const r = em(["validate", "order-fulfillment.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
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

  // MIL-164: same fixture (place-order's implementedIn: src/checkout matches the changed
  // src/checkout/Handler.kt; ship-order's URL-only implementedIn matches nothing) as the
  // conform-scope suite above, exercised through the standalone `em freshness` surface instead.
  it("em freshness: text line reports commits AND slice-PRs behind HEAD, computed via the same conform-scope machinery", () => {
    const r = em(["freshness", "checkout.em", "--repo", targetRepo], modelDir);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe(`last conformed ${baseRev} — 2 commits and 1 slice-PR behind HEAD`);
  });

  it("em freshness --json: same ConformanceEntry facts em status --json reports for this model", () => {
    const r = em(["freshness", "checkout.em", "--repo", targetRepo, "--json"], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.freshnessSchemaVersion).toBe("1.0");
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: expect.any(String) });
    expect(doc.file).toBe("checkout.em");
    expect(doc.lastConformance).toEqual({ date: expect.any(String), revision: baseRev });
    expect(doc.commitsBehindHead).toBe(2);
    expect(doc.slicePRsBehindHead).toBe(1);
    expect(doc.error).toBeNull();

    const statusR = em(["status", "checkout.em", "--repo", targetRepo, "--json"], modelDir);
    const statusDoc = JSON.parse(statusR.stdout);
    expect(statusDoc.conformance[0].commitsBehindHead).toBe(doc.commitsBehindHead);
    expect(statusDoc.conformance[0].slicePRsBehindHead).toBe(doc.slicePRsBehindHead);
  });

  it("em freshness --repo defaults to the model's own directory when omitted", () => {
    const r = em(["freshness", "checkout.em"], modelDir);
    expect(r.status).toBe(0);
    // modelDir itself isn't a git repo (only targetRepo is, in this suite) — a clean, non-fatal error.
    expect(r.stdout).toContain("conformance unknown");
    expect(r.stdout).toContain("is not a git repository");
  });

  it("em freshness refuses (exit 1) on a model with errors", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-freshness-error-"));
    try {
      writeFileSync(join(cwd, "broken.em"), 'slice "Read" {\n  view Open Orders from "No Such Event"\n}\n');
      const r = em(["freshness", "broken.em"], cwd);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not reporting freshness");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("em conform-supersede (CLI, MIL-164)", () => {
  const REPORT = `# Conformance Report — Checkout — 2026-08-23\n\n- **Model:** \`checkout.em\`\n\n## Summary\n\nClean.\n`;

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-conform-supersede-"));
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, "checkout.em"), 'slice "A" {\n  ui Dashboard @Customer\n}\n');
    writeFileSync(join(dir, "conformance", "2026-08-23-report.md"), REPORT);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stamps the report and prints confirmation", () => {
    const r = em(
      ["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "a1b2c3d", "--findings", "1-3", "--on", "2026-08-27"],
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stamped superseded: conformance/2026-08-23-report.md");
    const onDisk = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    expect(onDisk).toContain("Superseded as of `a1b2c3d`");
    expect(onDisk).toContain("findings 1-3 since ruled (2026-08-27)");
  });

  it("--on defaults to today when omitted", () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = em(["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "e4f5a6b", "--findings", "4"], dir);
    expect(r.status).toBe(0);
    const onDisk = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    expect(onDisk).toContain("Superseded as of `e4f5a6b`");
    expect(onDisk).toContain(`findings 4 since ruled (${today})`);
  });

  it("re-running the identical stamp is a no-op", () => {
    const r = em(
      ["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "a1b2c3d", "--findings", "1-3", "--on", "2026-08-27"],
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already stamped (no-op)");
  });

  it("refuses (exit 1) when the report doesn't exist", () => {
    const r = em(["conform-supersede", "checkout.em", "conformance/no-such-report.md", "--as-of", "a1b2c3d", "--findings", "1-3"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no such report");
  });

  it("refuses (exit 1) on an invalid --on date", () => {
    const r = em(["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "a1b2c3d", "--findings", "1-3", "--on", "not-a-date"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid --on date");
  });

  it("refuses (exit 1) on an unsafe --findings value", () => {
    const r = em(["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "a1b2c3d", "--findings", "1-3; DROP"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be a plain list/range of numbers");
  });

  it("requires --as-of and --findings", () => {
    const r1 = em(["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--findings", "1-3"], dir);
    expect(r1.status).not.toBe(0);
    const r2 = em(["conform-supersede", "checkout.em", "conformance/2026-08-23-report.md", "--as-of", "a1b2c3d"], dir);
    expect(r2.status).not.toBe(0);
  });
});

describe("em status (CLI, real git repo + fs, MIL-163)", () => {
  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  // One implemented slice with a bound doc (2 invariants, 1 uncovered, Open Questions all
  // checked, an open `issue` marker on its command) and one draft slice with a bound doc (no
  // invariants, 1 unchecked Open Question, never implemented) — enough surface to exercise
  // every rollup dimension in one fixture.
  const MODEL = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order note "slices/place-order.md" issue "who validates the discount code?"
  event Order Placed
}
slice "Billing" {
  view Invoice from "Order Placed" note "slices/billing.md"
  ui Invoice Screen @Customer
}
`;

  const PLACE_ORDER_DOC =
    "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: PR#1\n---\n" +
    "## Invariants / Business Rules\n- **INV-CHK-1:** total must be positive\n- **INV-CHK-2:** discount cannot exceed total\n\n" +
    "## Open Questions\n- [x] resolved\n";

  const BILLING_DOC =
    "---\nschemaVersion: 1\npattern: state-view\nswimlane: billing\nstatus: draft\nversion: 1\n---\n" +
    "## Open Questions\n- [ ] still deciding layout\n";

  let modelDir: string;
  let baseRev: string;

  beforeAll(() => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-"));
    const scaffolded = em(["scaffold", "Checkout"], cwd);
    expect(scaffolded.status).toBe(0);
    modelDir = join(cwd, "checkout");
    writeFileSync(join(modelDir, "checkout.em"), MODEL);
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    writeFileSync(join(modelDir, "slices", "place-order.md"), PLACE_ORDER_DOC);
    writeFileSync(join(modelDir, "slices", "billing.md"), BILLING_DOC);
    mkdirSync(join(modelDir, "tests"), { recursive: true });
    writeFileSync(join(modelDir, "tests", "place-order.spec.ts"), "// citing INV-CHK-1 in this test\nit('works', () => {});\n");

    git(["init", "-q", "-b", "main"], modelDir);
    git(["add", "."], modelDir);
    git(["commit", "-qam", "initial"], modelDir);
    baseRev = git(["rev-parse", "HEAD"], modelDir).stdout.trim();

    const setConformance = em(["state", "set-conformance", baseRev, "--report", "conformance/r.md"], modelDir);
    expect(setConformance.status).toBe(0);
    git(["add", "."], modelDir);
    git(["commit", "-qam", "record conformance"], modelDir);
  });
  afterAll(() => rmSync(modelDir, { recursive: true, force: true }));

  it("text report: the acceptance-line summary plus a detail block", () => {
    const r = em(["status", "checkout.em", "--tests", "tests"], modelDir);
    expect(r.status).toBe(0);
    const [summary, ...rest] = r.stdout.trim().split("\n\n");
    // PLACE_ORDER_DOC's implementedIn ("PR#1") matches no changed path in this repo (the "record
    // conformance" commit only touches .event-modeling.md) — 0 slice-PRs behind HEAD.
    expect(summary).toBe(
      `1/2 implemented · 1/2 invariants covered · 1 open issue, 1 unchecked open question · last conformed ${baseRev} — 1 commit and 0 slice-PRs behind HEAD`,
    );
    const detail = rest.join("\n\n");
    expect(detail).toContain(
      "slices: 2 total — 1 implemented, 0 ready-to-implement, 0 reviewed, 1 draft, 0 no doc, 0 frontmatter invalid, 0 unknown status",
    );
    expect(detail).toContain(
      "driftSignal: 1 in-sync, 1 never-implemented, 0 unpropagated-delta, 0 implemented-without-link, 0 n/a (no doc), 0 n/a (frontmatter invalid)",
    );
    expect(detail).toContain("invariants: 1/2 covered (1 uncovered) — tests");
    expect(detail).toContain("issues: 1 open issue, 1/2 open question(s) unchecked");
    expect(detail).toContain(`conformance: last conformed ${baseRev} — 1 commit and 0 slice-PRs behind HEAD`);
  });

  it("--json: schema-versioned document with the same figures as the text report", () => {
    const r = em(["status", "checkout.em", "--tests", "tests", "--json"], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.statusSchemaVersion).toBe("1.2");
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: expect.any(String) });
    expect(doc.files).toEqual(["checkout.em"]);
    expect(doc.slices).toEqual({
      total: 2,
      byStatus: { draft: 1, reviewed: 0, readyToImplement: 0, implemented: 1, noDoc: 0, frontmatterInvalid: 0, unknown: 0 },
    });
    expect(doc.driftSignal).toEqual({
      inSync: 1,
      neverImplemented: 1,
      unpropagatedDelta: 0,
      implementedWithoutLink: 0,
      notApplicable: 0,
      frontmatterInvalid: 0,
    });
    expect(doc.invariants).toEqual({ testsDir: "tests", total: 2, cited: 1, uncovered: 1 });
    expect(doc.issues).toEqual({ openIssues: 1, openQuestionsTotal: 2, openQuestionsUnchecked: 1 });
    expect(doc.conformance).toHaveLength(1);
    expect(doc.conformance[0]).toMatchObject({
      file: "checkout.em",
      hasStateFile: true,
      lastConformance: { date: expect.any(String), revision: baseRev },
      commitsBehindHead: 1,
      slicePRsBehindHead: 0,
      error: null,
    });
  });

  it("--tests omitted: invariants is null, and the summary says so", () => {
    const r = em(["status", "checkout.em"], modelDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("invariants not checked (pass --tests <dir>)");
    const json = em(["status", "checkout.em", "--json"], modelDir);
    expect(JSON.parse(json.stdout).invariants).toBeNull();
  });

  it("--md: a markdown table suited for README embedding", () => {
    const r = em(["status", "checkout.em", "--tests", "tests", "--md"], modelDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("| Metric | Value |");
    expect(r.stdout).toContain("| Slices | 1/2 implemented");
    expect(r.stdout).toContain("| Invariants | 1/2 covered |");
    expect(r.stdout).toContain("| Open issues | 1 |");
    expect(r.stdout).toContain(`| Last conformed | \`${baseRev}\` — 1 commit and 0 slice-PRs behind HEAD |`);
  });

  it("--badge: a well-formed SVG", () => {
    const r = em(["status", "checkout.em", "--tests", "tests", "--badge"], modelDir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().startsWith("<svg")).toBe(true);
    expect(r.stdout).toContain("em status");
  });

  it("-o writes the report to a file instead of stdout", () => {
    const out = join(modelDir, "status.txt");
    const r = em(["status", "checkout.em", "-o", "status.txt"], modelDir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("wrote status.txt");
    expect(readFileSync(out, "utf8")).toContain("implemented ·");
    rmSync(out);
  });

  it("--json and --md together is a usage error", () => {
    const r = em(["status", "checkout.em", "--json", "--md"], modelDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("a --tests directory that doesn't exist is a clear error", () => {
    const r = em(["status", "checkout.em", "--tests", "no-such-dir"], modelDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--tests directory not found");
  });

  it("refuses (exit 1) when a model has errors, printing diagnostics instead of a report", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-error-"));
    try {
      writeFileSync(join(cwd, "broken.em"), 'slice "Read" {\n  view Open Orders from "No Such Event"\n}\n');
      const r = em(["status", "broken.em"], cwd);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not reporting status");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("--repo overrides the default per-model repo used for commits-behind-HEAD", () => {
    const targetRepo = mkdtempSync(join(tmpdir(), "em-cli-status-target-"));
    try {
      git(["init", "-q", "-b", "main"], targetRepo);
      writeFileSync(join(targetRepo, "README.md"), "# demo\n");
      git(["add", "."], targetRepo);
      git(["commit", "-qam", "initial"], targetRepo);
      const targetRev = git(["rev-parse", "HEAD"], targetRepo).stdout.trim();
      writeFileSync(join(targetRepo, "README.md"), "# demo, updated\n");
      git(["add", "."], targetRepo);
      git(["commit", "-qam", "second"], targetRepo);

      const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-repo-flag-"));
      const scaffolded = em(["scaffold", "Checkout"], cwd);
      expect(scaffolded.status).toBe(0);
      const dir = join(cwd, "checkout");
      writeFileSync(join(dir, "checkout.em"), MODEL);
      mkdirSync(join(dir, "slices"), { recursive: true });
      writeFileSync(join(dir, "slices", "place-order.md"), PLACE_ORDER_DOC);
      writeFileSync(join(dir, "slices", "billing.md"), BILLING_DOC);
      em(["state", "set-conformance", targetRev, "--report", "conformance/r.md"], dir);

      const r = em(["status", "checkout.em", "--repo", targetRepo, "--json"], dir);
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.conformance[0].repo).toBe(targetRepo);
      expect(doc.conformance[0].commitsBehindHead).toBe(1);
      expect(doc.conformance[0].slicePRsBehindHead).toBe(0); // PLACE_ORDER_DOC's implementedIn ("PR#1") matches no changed path here either
      rmSync(cwd, { recursive: true, force: true });
    } finally {
      rmSync(targetRepo, { recursive: true, force: true });
    }
  });

  it("aggregates across multiple input models", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-multi-"));
    try {
      writeFileSync(join(cwd, "a.em"), 'slice "A" {\n  ui Dashboard @Customer\n}\n');
      writeFileSync(join(cwd, "b.em"), 'slice "B" {\n  ui Screen @Customer\n}\n');
      const r = em(["status", "a.em", "b.em", "--json"], cwd);
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.files).toEqual(["a.em", "b.em"]);
      expect(doc.slices.total).toBe(2);
      expect(doc.slices.byStatus.noDoc).toBe(2);
      expect(doc.conformance).toHaveLength(2);
      expect(doc.conformance.map((c: { file: string }) => c.file)).toEqual(["a.em", "b.em"]);
      expect(doc.conformance.every((c: { hasStateFile: boolean }) => c.hasStateFile === false)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // PR #116 review findings — end-to-end regressions through the real CLI wiring (the pure
  // aggregation logic itself is covered exhaustively in test/status.test.ts).
  describe("PR #116 review fixes (end-to-end)", () => {
    it("finding 2: a frontmatter-invalid doc buckets distinctly and its join warning reaches both stderr and --json diagnostics", () => {
      const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-invalid-doc-"));
      try {
        writeFileSync(join(cwd, "model.em"), 'slice "Broken" {\n  ui Broken Screen @Customer note "slices/broken.md"\n}\n');
        mkdirSync(join(cwd, "slices"), { recursive: true });
        writeFileSync(join(cwd, "slices", "broken.md"), "# Slice: Broken\nNo frontmatter fence at all.\n");

        const r = em(["status", "model.em", "--json"], cwd);
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("frontmatter"); // the join warning printed to stderr

        const doc = JSON.parse(r.stdout);
        expect(doc.slices.byStatus.frontmatterInvalid).toBe(1);
        expect(doc.slices.byStatus.noDoc).toBe(0);
        expect(doc.slices.byStatus.unknown).toBe(0);
        expect(doc.driftSignal.frontmatterInvalid).toBe(1);
        expect(doc.driftSignal.notApplicable).toBe(0);
        expect(doc.diagnostics).toHaveLength(1);
        expect(doc.diagnostics[0]).toMatchObject({ file: "model.em", code: "frontmatter-invalid" });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("finding 3: a covers:-shared doc's Open Questions count once across both covering slices", () => {
      const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-shared-doc-"));
      try {
        writeFileSync(
          join(cwd, "model.em"),
          'slice "Owner" {\n  command Own Thing note "slices/owner.md"\n  event Thing Owned\n}\n' +
            'slice "Other" {\n  ui Other Screen @Customer note "slices/owner.md"\n}\n',
        );
        mkdirSync(join(cwd, "slices"), { recursive: true });
        writeFileSync(
          join(cwd, "slices", "owner.md"),
          "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\ncovers: other\n---\n" +
            "## Open Questions\n- [ ] shared, unresolved\n",
        );

        const r = em(["status", "model.em", "--json"], cwd);
        expect(r.status).toBe(0);
        const doc = JSON.parse(r.stdout);
        expect(doc.slices.byStatus.reviewed).toBe(2); // both slices genuinely count
        expect(doc.issues.openQuestionsTotal).toBe(1); // the doc's own count, not 2
        expect(doc.issues.openQuestionsUnchecked).toBe(1);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("finding 4: a conform-scope --seed-asis scratch copy doesn't inherit its sibling's conformance record", () => {
      const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-asis-"));
      try {
        const scaffolded = em(["scaffold", "Checkout"], cwd);
        expect(scaffolded.status).toBe(0);
        const modelDir2 = join(cwd, "checkout");
        writeFileSync(join(modelDir2, "checkout.em"), 'slice "A" {\n  ui Dashboard @Customer\n}\n');

        // A real --seed-asis scratch copy, same convention conform-scope itself writes.
        const seeded = em(["conform-scope", "checkout.em", "--repo", modelDir2, "--full", "--seed-asis"], modelDir2);
        expect(seeded.status).toBe(0);
        expect(existsSync(join(modelDir2, "checkout-asis.em"))).toBe(true);

        const setConformance = em(["state", "set-conformance", "deadbeef", "--report", "r.md"], modelDir2);
        expect(setConformance.status).toBe(0);

        // checkout.em: attributed normally (though "deadbeef" isn't a real revision in this
        // directory, which isn't a git repo at all here — resolveConformanceEntry reports that
        // as its own non-fatal error, distinct from the modelPath-mismatch message below).
        const forCheckout = em(["status", "checkout.em", "--json"], modelDir2);
        expect(forCheckout.status).toBe(0);
        const checkoutDoc = JSON.parse(forCheckout.stdout);
        expect(checkoutDoc.conformance[0].lastConformance.revision).toBe("deadbeef");

        // checkout-asis.em: the state file names "checkout.em", not "checkout-asis.em" — must
        // NOT inherit the record.
        const forAsis = em(["status", "checkout-asis.em", "--json"], modelDir2);
        expect(forAsis.status).toBe(0);
        const asisDoc = JSON.parse(forAsis.stdout);
        expect(asisDoc.conformance[0].hasStateFile).toBe(true);
        expect(asisDoc.conformance[0].lastConformance).toBeNull();
        expect(asisDoc.conformance[0].error).toContain('describes "checkout.em"');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("finding 1: an unresolvable --repo makes the badge yellow, never green", () => {
      const cwd = mkdtempSync(join(tmpdir(), "em-cli-status-badge-unverifiable-"));
      const notARepo = mkdtempSync(join(tmpdir(), "em-cli-status-badge-notarepo-"));
      try {
        const scaffolded = em(["scaffold", "Checkout"], cwd);
        expect(scaffolded.status).toBe(0);
        const modelDir3 = join(cwd, "checkout");
        writeFileSync(join(modelDir3, "checkout.em"), 'slice "A" {\n  ui Dashboard @Customer\n}\n');
        const setConformance = em(["state", "set-conformance", "abc123f", "--report", "r.md"], modelDir3);
        expect(setConformance.status).toBe(0);

        const r = em(["status", "checkout.em", "--repo", notARepo, "--badge"], modelDir3);
        expect(r.status).toBe(0);
        expect(r.stdout).not.toContain("#4c1");
        expect(r.stdout).toContain("#dfb317");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(notARepo, { recursive: true, force: true });
      }
    });
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
    expect(readme).toContain("| 1 | Place | State Change | no doc yet | — | — | — | — | [slices/place.md](slices/place.md) |");
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

describe("em slice mark-implemented (CLI, MIL-103)", () => {
  // Pure-transform and note-binding-resolution coverage lives in test/markImplemented.test.ts;
  // this block is exit-code/process-level only, same split as `em slice index`.
  let dir: string;
  const READY_DOC =
    "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n# Slice: Ready Slice\n\nbody\n";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-mark-implemented-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "ready-slice.md"), READY_DOC);
    writeFileSync(
      join(dir, "ready.em"),
      'slice "Ready Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n',
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
    // Genuine error in an UNRELATED slice — regression coverage that marking one slice
    // implemented doesn't gate on breakage elsewhere in a large, still-WIP model (same "scoped
    // to this slice" call `em export --slice`/`em validate --slice-ready` already made).
    writeFileSync(
      join(dir, "slices", "good.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "scoped.em"),
      'slice "Good" {\n  ui Screen @Customer\n  command Do Thing note "slices/good.md"\n  event Thing Done\n}\nslice "Bad" {\n  view Broken View from "No Such Event"\n}\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("flips status/implementedIn and confirms on stdout", () => {
    const r = em(["slice", "mark-implemented", "ready.em", "ready-slice", "https://github.com/org/repo/pull/42"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("marked implemented: slices/ready-slice.md");
    expect(r.stdout).toContain("https://github.com/org/repo/pull/42");
    const content = readFileSync(join(dir, "slices", "ready-slice.md"), "utf8");
    expect(content).toContain("status: implemented");
    expect(content).toContain("implementedIn: https://github.com/org/repo/pull/42");
    expect(content).toContain("version: 1"); // never bumped
  });

  it("is idempotent: re-running with the same URL is a no-op, exit 0", () => {
    const before = readFileSync(join(dir, "slices", "ready-slice.md"), "utf8");
    const r = em(["slice", "mark-implemented", "ready.em", "ready-slice", "https://github.com/org/repo/pull/42"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already implemented (no-op)");
    expect(readFileSync(join(dir, "slices", "ready-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a different URL once implemented, exit non-zero, file untouched", () => {
    const before = readFileSync(join(dir, "slices", "ready-slice.md"), "utf8");
    const r = em(["slice", "mark-implemented", "ready.em", "ready-slice", "https://github.com/org/repo/pull/999"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already marked implemented with a different URL");
    expect(readFileSync(join(dir, "slices", "ready-slice.md"), "utf8")).toBe(before);
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const r = em(["slice", "mark-implemented", "ready.em", "no-such-key", "https://x/1"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no slice with export key "no-such-key" in this model');
  });

  it("errors clearly when no doc is bound via note", () => {
    const r = em(["slice", "mark-implemented", "unbound.em", "unbound", "https://x/1"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("stays scoped to the named slice: a genuine error in an unrelated slice doesn't block it", () => {
    const r = em(["slice", "mark-implemented", "scoped.em", "good", "https://github.com/org/repo/pull/1"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("marked implemented: slices/good.md");
  });

  it("refuses on an error concerning the named slice itself", () => {
    const r = em(["slice", "mark-implemented", "scoped.em", "bad", "https://x/1"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('slice "bad" has errors');
  });
});

describe("em slice ratify (CLI, MIL-165)", () => {
  // Pure-transform and note-binding-resolution coverage lives in test/ratify.test.ts; this
  // block is exit-code/process-level only, same split as `em slice mark-implemented`.
  let dir: string;
  const DRAFT_DOC =
    "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n# Slice: Draft Slice\n\nbody\n";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-ratify-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "draft-slice.md"), DRAFT_DOC);
    writeFileSync(
      join(dir, "draft.em"),
      'slice "Draft Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/draft-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n',
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
    // Genuine error in an UNRELATED slice — same scoping regression coverage mark-implemented's
    // CLI block has.
    writeFileSync(
      join(dir, "slices", "good.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "scoped.em"),
      'slice "Good" {\n  ui Screen @Customer\n  command Do Thing note "slices/good.md"\n  event Thing Done\n}\nslice "Bad" {\n  view Broken View from "No Such Event"\n}\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("flips status and records ratifiedBy/ratifiedOn (default --on today), confirms on stdout", () => {
    const r = em(["slice", "ratify", "draft.em", "draft-slice", "--by", "Alex Rivera"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ratified: slices/draft-slice.md");
    expect(r.stdout).toContain("ratifiedBy: Alex Rivera");
    const content = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    expect(content).toContain("status: ready-to-implement");
    expect(content).toContain("ratifiedBy: Alex Rivera");
    expect(content).toMatch(/ratifiedOn: \d{4}-\d{2}-\d{2}/);
    expect(content).toContain("version: 1"); // never bumped
  });

  it("is idempotent: re-running with the same --by/--on is a no-op, exit 0", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const onMatch = before.match(/ratifiedOn: (\d{4}-\d{2}-\d{2})/);
    expect(onMatch).not.toBeNull();
    const r = em(["slice", "ratify", "draft.em", "draft-slice", "--by", "Alex Rivera", "--on", onMatch![1]], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already ratified (no-op)");
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a different ratifier once ready-to-implement, exit non-zero, file untouched", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const r = em(["slice", "ratify", "draft.em", "draft-slice", "--by", "Jordan Lee", "--on", "2026-08-28"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already ratified by Alex Rivera");
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("accepts an explicit --on date", () => {
    const r = em(["slice", "ratify", "scoped.em", "good", "--by", "Alex Rivera", "--on", "2026-08-28"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ratifiedOn: 2026-08-28");
    const content = readFileSync(join(dir, "slices", "good.md"), "utf8");
    expect(content).toContain("ratifiedOn: 2026-08-28");
  });

  it("rejects a malformed --on date before touching the file", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const r = em(["slice", "ratify", "draft.em", "draft-slice", "--by", "Alex Rivera", "--on", "not-a-date"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('invalid --on date "not-a-date"');
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const r = em(["slice", "ratify", "draft.em", "no-such-key", "--by", "Alex Rivera"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no slice with export key "no-such-key" in this model');
  });

  it("errors clearly when no doc is bound via note", () => {
    const r = em(["slice", "ratify", "unbound.em", "unbound", "--by", "Alex Rivera"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("refuses on an error concerning the named slice itself", () => {
    const r = em(["slice", "ratify", "scoped.em", "bad", "--by", "Alex Rivera"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('slice "bad" has errors');
  });

  it("requires --by", () => {
    const r = em(["slice", "ratify", "draft.em", "draft-slice"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--by");
  });
});

describe("em slice reratify (CLI, MIL-161)", () => {
  // Pure-transform and note-binding-resolution coverage lives in test/reratify.test.ts; this
  // block is exit-code/process-level only, same split as `em slice ratify`.
  let dir: string;
  const IMPLEMENTED_DOC =
    "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\n" +
    "implementedIn: https://github.com/org/repo/pull/1\nratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n---\n" +
    "# Slice: Shipped Slice\n\nbody\n";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-reratify-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "shipped-slice.md"), IMPLEMENTED_DOC);
    writeFileSync(
      join(dir, "shipped.em"),
      'slice "Shipped Slice" {\n  ui Screen @Customer\n  command Do Thing note "slices/shipped-slice.md"\n  event Thing Done\n}\nslice "Read Model" {\n  view Thing List from "Thing Done"\n  ui List Screen @Customer\n}\n',
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
    // Genuine error in an UNRELATED slice — same scoping regression coverage ratify's CLI block has.
    writeFileSync(
      join(dir, "slices", "good.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: https://x/1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "scoped.em"),
      'slice "Good" {\n  ui Screen @Customer\n  command Do Thing note "slices/good.md"\n  event Thing Done\n}\nslice "Bad" {\n  view Broken View from "No Such Event"\n}\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("bumps version, flips status, clears stale ratifiedBy/ratifiedOn, confirms on stdout", () => {
    const r = em(["slice", "reratify", "shipped.em", "shipped-slice"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reratified: slices/shipped-slice.md");
    expect(r.stdout).toContain("version: 2");
    const content = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    expect(content).toContain("status: ready-to-implement");
    expect(content).toContain("version: 2");
    expect(content).toContain("implementedIn: https://github.com/org/repo/pull/1"); // untouched
    expect(content).not.toContain("ratifiedBy:");
    expect(content).not.toContain("ratifiedOn:");
  });

  it("a follow-up em slice ratify --by applies cleanly (no false 'already ratified' refusal)", () => {
    const r = em(["slice", "ratify", "shipped.em", "shipped-slice", "--by", "Jordan Lee", "--on", "2026-08-28"], dir);
    expect(r.status).toBe(0);
    const content = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    expect(content).toContain("ratifiedBy: Jordan Lee");
    expect(content).toContain("status: ready-to-implement");
    expect(content).toContain("version: 2"); // ratify never bumps version
  });

  it("refuses a second reratify run — status is no longer implemented", () => {
    const r = em(["slice", "reratify", "shipped.em", "shipped-slice"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("status: ready-to-implement");
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const r = em(["slice", "reratify", "shipped.em", "no-such-key"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no slice with export key "no-such-key" in this model');
  });

  it("errors clearly when no doc is bound via note", () => {
    const r = em(["slice", "reratify", "unbound.em", "unbound"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("stays scoped to the named slice: a genuine error in an unrelated slice doesn't block it", () => {
    const r = em(["slice", "reratify", "scoped.em", "good"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reratified: slices/good.md");
  });

  it("refuses on an error concerning the named slice itself", () => {
    const r = em(["slice", "reratify", "scoped.em", "bad"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('slice "bad" has errors');
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

describe("em slice new --wire (CLI, MIL-161)", () => {
  // Pure logic (resolvePrimaryElement/insertNoteClause/wireSliceNote) is covered by
  // test/sliceLink.test.ts; this block is exit-code/process-level only, same split as the rest
  // of `em slice new`.
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-slice-new-wire-"));
    writeFileSync(
      join(dir, "model.em"),
      [
        'slice "Checkout" {',
        "  ui Checkout Screen",
        "  command Submit Payment",
        "  event Payment Requested",
        "}",
        'slice "Manager Review" {',
        '  view Pending Payments from "Payment Requested"',
        "  ui Payment Dashboard",
        "}",
        'slice "Already Wired" {',
        '  command Do Thing note "slices/pre-existing.md"',
        "  event Thing Done",
        "}",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the doc AND inserts the note line into the .em file", () => {
    const r = em(
      ["slice", "new", "Checkout", "--pattern", "state-change", "--swimlane", "Customer → Payment", "--wire", "model.em"],
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote slices/checkout.md");
    expect(r.stdout).toContain('wired slices/checkout.md onto Submit Payment in slice "Checkout"');
    expect(existsSync(join(dir, "slices", "checkout.md"))).toBe(true);
    const emContent = readFileSync(join(dir, "model.em"), "utf8");
    expect(emContent).toContain('command Submit Payment note "slices/checkout.md"');
  });

  it("resolves the view for a state-view slice", () => {
    const r = em(
      ["slice", "new", "Manager Review", "--pattern", "state-view", "--swimlane", "Manager → Payment", "--wire", "model.em"],
      dir,
    );
    expect(r.status).toBe(0);
    const emContent = readFileSync(join(dir, "model.em"), "utf8");
    expect(emContent).toContain('view Pending Payments from "Payment Requested" note "slices/manager-review.md"');
  });

  it("fails without writing the doc when the .em has no matching slice", () => {
    const r = em(
      ["slice", "new", "No Such Slice", "--pattern", "state-change", "--swimlane", "A → B", "--wire", "model.em"],
      dir,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no slice with export key "no-such-slice" in this model');
    expect(existsSync(join(dir, "slices", "no-such-slice.md"))).toBe(false);
  });

  it("fails without writing the doc when the element already has a note clause", () => {
    const r = em(
      ["slice", "new", "Already Wired", "--pattern", "state-change", "--swimlane", "A → B", "--wire", "model.em"],
      dir,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already has a `note` clause");
    expect(existsSync(join(dir, "slices", "already-wired.md"))).toBe(false);
    const emContent = readFileSync(join(dir, "model.em"), "utf8");
    expect(emContent).toContain('note "slices/pre-existing.md"'); // untouched
  });

  it("without --wire, falls back to printing the note line (existing behavior)", () => {
    const r = em(["slice", "new", "Yet Another", "--pattern", "automation", "--swimlane", "A → B"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('note "slices/yet-another.md"');
    expect(r.stdout).not.toContain("wired ");
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

// MIL-160: `em status` is a multi-model surface (`<files...>`) — the CLI wiring that calls
// detectSliceDocCollisions() and folds its diagnostics into the JSON `diagnostics` array is
// exercised here, over and above the pure-function coverage in test/modelCollisionValidate.test.ts.
describe("em status — cross-model slice-doc collisions (CLI, real fs, MIL-160)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-status-collision-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const CHECKOUT = `slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order
  event Order Submitted
}
slice "Order Confirmation" {
  view Order Confirmation from "Order Submitted"
  ui Confirmation Screen @Customer
}
`;

  it("warns (non-fatally) when two sibling models share a directory and a slice name", () => {
    const badDir = join(dir, "flat-models");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "a.em"), CHECKOUT);
    writeFileSync(join(badDir, "b.em"), CHECKOUT);

    const r = em(["status", "a.em", "b.em"], badDir);
    expect(r.status).toBe(0); // a collision warning never blocks the report
    expect(r.stderr).toContain(
      'b.em:   warn  "b.em" and "a.em" share a directory and both produce slice key "checkout" — ' +
        'both would read/write "slices/checkout.md"; give each model its own directory ' +
        '(see docs/cli.md, "Multi-model projects")',
    );
    expect(r.stderr).toContain('slice key "order-confirmation"');

    const json = em(["status", "a.em", "b.em", "--json"], badDir);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    const collision = parsed.diagnostics.find((d: { code: string }) => d.code === "cross-model-slice-doc-collision");
    expect(collision).toBeDefined();
    expect(collision.file).toBe("b.em"); // attributed to the second file to use the key
    expect(collision.severity).toBe("warning");
  });

  it("MULTI-MODEL FIXTURE, backward compat: one directory per model reports zero collisions", () => {
    // The documented convention (docs/cli.md, "Multi-model projects"): each model in its OWN
    // directory, so both models can freely use the same slice name without namespacing.
    const root = join(dir, "well-laid-out");
    mkdirSync(join(root, "checkout"), { recursive: true });
    mkdirSync(join(root, "fulfillment"), { recursive: true });
    writeFileSync(join(root, "checkout", "checkout.em"), CHECKOUT);
    // Deliberately reuses the exact same slice name ("Checkout") in a SECOND model — legal
    // and collision-free purely because each model owns its own directory.
    writeFileSync(join(root, "fulfillment", "fulfillment.em"), CHECKOUT);

    const r = em(["status", "checkout/checkout.em", "fulfillment/fulfillment.em", "--json"], root);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.slices.total).toBe(4); // 2 slices per model x 2 models, no cross-model dedup needed
  });

  it("backward compat: an existing single-model project (no directory-per-model layout) is unaffected", () => {
    const single = join(dir, "single-model");
    mkdirSync(single, { recursive: true });
    writeFileSync(join(single, "model.em"), CHECKOUT);

    const r = em(["status", "model.em", "--json"], single);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.diagnostics).toEqual([]);
  });
});

// MIL-183 (the fragility half of GH #128): a `slices/*.md` file a slice rename/removal left
// behind used to just quietly stop applying, with nothing pointing at the orphaned file itself.
// This exercises the actual CLI wiring — `em status`'s per-model `validateOrphanedSliceDocs` call
// folding its warning into the JSON `diagnostics` array, the same way the multi-model collision
// suite above exercises `detectSliceDocCollisions` — over and above the pure-function coverage in
// test/orphanedSliceDocValidate.test.ts.
describe("em status — orphaned slice docs (CLI, real fs, MIL-183)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-status-orphan-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("warns (non-fatally) when a slice doc's key matches no current slice, after a rename", () => {
    const modelDir = join(dir, "renamed");
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    // "checkout.md" was authored for a slice that has since been renamed to "New Checkout" —
    // the doc file was never renamed to follow.
    writeFileSync(
      join(modelDir, "slices", "checkout.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    writeFileSync(join(modelDir, "model.em"), 'slice "New Checkout" {\n  command Submit Order\n  event Order Submitted\n}\n');

    const r = em(["status", "model.em"], modelDir);
    expect(r.status).toBe(0); // an orphaned-slice-doc warning never blocks the report
    expect(r.stderr).toContain('warn  slice doc "slices/checkout.md" matches no current slice\'s key');

    const json = em(["status", "model.em", "--json"], modelDir);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    const orphan = parsed.diagnostics.find((d: { code: string }) => d.code === "orphaned-slice-doc");
    expect(orphan).toBeDefined();
    expect(orphan.file).toBe("model.em");
    expect(orphan.severity).toBe("warning");
  });

  it("no warning when every slices/*.md file still matches a current slice's key", () => {
    const modelDir = join(dir, "matched");
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    writeFileSync(
      join(modelDir, "slices", "checkout.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    // ui/reaction wiring is irrelevant to this check — kept minimal, so the only diagnostic this
    // fixture could produce that matters here is orphaned-slice-doc.
    writeFileSync(
      join(modelDir, "model.em"),
      'slice "Checkout" {\n  ui Checkout Screen @Customer\n  command Submit Order\n  event Order Submitted\n}\n',
    );

    const r = em(["status", "model.em", "--json"], modelDir);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.diagnostics.filter((d: { code: string }) => d.code === "orphaned-slice-doc")).toEqual([]);
  });
});

describe("em scaffold --under (CLI, real fs, MIL-160)", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-scaffold-under-"));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it("scaffolds <under>/<slug>/ instead of ./<slug>/, keeping filenames un-namespaced", () => {
    const r = em(["scaffold", "Checkout", "--under", "models"], cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("scaffolded models/checkout/");

    const dir = join(cwd, "models", "checkout");
    expect(existsSync(join(dir, "checkout.em"))).toBe(true); // slug stem, not "models-checkout"
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".event-modeling.md"))).toBe(true);
    expect(readFileSync(join(dir, "checkout.em"), "utf8").startsWith('model "Checkout"\n')).toBe(true);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("em watch checkout.em -o checkout.svg --serve");
    expect(readFileSync(join(dir, ".event-modeling.md"), "utf8")).toContain("- **Model file:** `checkout.em`");
  });

  it("a second model scaffolded under the same parent gets its own sibling directory", () => {
    const r = em(["scaffold", "Fulfillment", "--under", "models"], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scaffolded models/fulfillment/");
    expect(existsSync(join(cwd, "models", "fulfillment", "fulfillment.em"))).toBe(true);
    // The earlier model is untouched.
    expect(existsSync(join(cwd, "models", "checkout", "checkout.em"))).toBe(true);
  });

  it("refuses to overwrite an existing --under directory without --force", () => {
    const r = em(["scaffold", "Checkout", "--under", "models"], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to overwrite models/checkout/ (use --force)");
  });

  it("without --under, behaves exactly as before (scaffolds ./<slug>/)", () => {
    const r = em(["scaffold", "Standalone"], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scaffolded standalone/");
    expect(existsSync(join(cwd, "standalone", "standalone.em"))).toBe(true);
  });
});

describe("em ci init (CLI, real fs, MIL-166)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-ci-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs both workflow files under .github/workflows/", () => {
    const r = em(["ci", "init", "model.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(join(dir, ".github", "workflows", "em-ci.yml"));
    expect(r.stdout).toContain(join(dir, ".github", "workflows", "em-conform.yml"));

    const ci = readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8");
    expect(ci).toContain("name: em ci");
    // MIL-188: every generated invocation pins the generating em's own exact version —
    // an unpinned line would float to npm's latest on the runner.
    const pkgVersion = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;
    const pinned = `npx @milehimikey/em@${pkgVersion}`;
    expect(ci).toContain(`${pinned} validate "$f"`);
    expect(ci).toContain(`${pinned} slice index "model.em" --check`);
    expect(ci).toContain(`${pinned} coverage "model.em" --tests "test" --strict`);
    expect(ci).toContain(`${pinned} glossary $(git ls-files '*.em') --fail-on-conflicts`);
    expect(ci).not.toContain("npx @milehimikey/em ");

    const conform = readFileSync(join(dir, ".github", "workflows", "em-conform.yml"), "utf8");
    expect(conform).toContain("name: model-conformance");
    expect(conform).toContain('/event-modeling conform"');
  });

  it("--tests changes the coverage/status-badge steps' --tests argument", () => {
    const r = em(["ci", "init", "model.em", "--tests", "spec"], dir);
    expect(r.status).toBe(0);
    const ci = readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8");
    expect(ci).toContain('--tests "spec"');
    expect(ci).not.toContain('--tests "test"');
  });

  it("a second run with the same arguments is idempotent (byte-identical, no error)", () => {
    em(["ci", "init", "model.em"], dir);
    const before = readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8");

    const r = em(["ci", "init", "model.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already up to date");
    expect(readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8")).toBe(before);
  });

  it("--check exits 0 and reports ok when both files match the current preset", () => {
    em(["ci", "init", "model.em"], dir);
    const r = em(["ci", "init", "model.em", "--check"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok — both workflow files match the current preset");
  });

  it("--check exits non-zero without writing when a file is missing", () => {
    const r = em(["ci", "init", "model.em", "--check"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("missing:");
    expect(existsSync(join(dir, ".github", "workflows", "em-ci.yml"))).toBe(false);
  });

  it("--check exits non-zero and reports stale after the args change, without writing", () => {
    em(["ci", "init", "model.em"], dir);
    const before = readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8");

    const r = em(["ci", "init", "model.em", "--tests", "spec", "--check"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("stale:");
    expect(readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8")).toBe(before);
  });

  it("re-running after a repo adds its own job outside the markers preserves that job", () => {
    em(["ci", "init", "model.em"], dir);
    const ciPath = join(dir, ".github", "workflows", "em-ci.yml");
    const withCustomJob = readFileSync(ciPath, "utf8").replace(
      "jobs:\n",
      "jobs:\n  my-custom-job:\n    runs-on: ubuntu-latest\n    steps: []\n\n",
    );
    writeFileSync(ciPath, withCustomJob, "utf8");

    const r = em(["ci", "init", "model.em", "--tests", "spec"], dir);
    expect(r.status).toBe(0);
    const updated = readFileSync(ciPath, "utf8");
    expect(updated).toContain("my-custom-job");
    expect(updated).toContain('--tests "spec"');
  });

  it("a pre-existing file with no GENERATED markers is left alone without --force (exit 0)", () => {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "name: my-hand-written-ci\n");

    const r = em(["ci", "init", "model.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already exists — re-run with --force to overwrite");
    expect(readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8")).toBe("name: my-hand-written-ci\n");
    // The other file (no conflict) still gets installed.
    expect(existsSync(join(dir, ".github", "workflows", "em-conform.yml"))).toBe(true);
  });

  it("--force replaces a pre-existing markerless file wholesale", () => {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "name: my-hand-written-ci\n");

    const r = em(["ci", "init", "model.em", "--force"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("replaced");
    const ci = readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8");
    expect(ci).toContain("name: em ci");
  });

  it("rejects a model path containing a shell-injection-relevant character", () => {
    const r = em(["ci", "init", 'model".em'], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must not contain");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("rejects an unsafe --tests value", () => {
    const r = em(["ci", "init", "model.em", "--tests", "te$st"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must not contain");
  });
});
