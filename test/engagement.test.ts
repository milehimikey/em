// SPDX-License-Identifier: MIT
// MIL-268 `em engagement new | plan | set | status | close` (goal-spec criterion 22): the pure
// builders in src/cli/engagement.ts against the shared fixtures (test/helpers/engagementFixture.ts),
// then the CLI wiring (exact refusal/warning messages, --force, idempotency, the `em status` line).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { semanticEdges } from "../src/model/edges.js";
import {
  EngagementModelInput,
  Selector,
  applyEngagementClose,
  applyEngagementSet,
  buildNewEngagement,
  buildUnitIndex,
  computePreflight,
  engagementPlanFor,
  engagementStatusFor,
  formatEngagementPlanText,
  resolvePrTitle,
} from "../src/cli/engagement.js";
import { engagementPath, loadEngagement, parseEngagementFile } from "../src/cli/engagementFile.js";
import { LENDING_ENGAGEMENT_KEYS, lendingViewKeys, writeLendingFixture, writeLifecyclesFixture } from "./helpers/engagementFixture.js";

// CLI-spawning file (the `em engagement …` suite below): a cold CI runner takes ~5–6 s per spawn
// and vitest's default is 5 s (briefing §5, MIL-205 pattern).
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function input(file: string): EngagementModelInput {
  const source = readFileSync(file, "utf8");
  const { model, refs, diagnostics } = compile(source);
  return { file, model, refs, baseDir: dirname(file), contract: { file, source, diagnostics }, allDiagnostics: diagnostics };
}

/** `new` through the builder, written to disk; returns the warning (or null). */
function create(file: string, slug: string, selector: Selector, parallel = 3, tracking: string | null = null): string | null {
  const r = buildNewEngagement(input(file), { slug, selector, parallel, createdBy: "Alex Rivera", tracking, created: "2026-10-08" });
  if (!r.ok) throw new Error(r.message);
  mkdirSync(join(dirname(file), "engagements"), { recursive: true });
  writeFileSync(engagementPath(file, slug), r.text);
  return r.warning;
}

function plan(file: string, slug: string) {
  const r = engagementPlanFor(input(file), slug);
  if (!r.ok) throw new Error(r.message);
  return r.plan;
}

function set(file: string, slug: string, key: string, state: string, extra: { branch?: string; base?: string; pr?: string } = {}) {
  const loaded = loadEngagement(file, slug);
  if (!loaded.ok) throw new Error(loaded.message);
  const r = applyEngagementSet(input(file), slug, loaded.text, loaded.file, { key, state, ...extra });
  if (r.ok && r.changed) writeFileSync(loaded.path, r.text);
  return r;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-engagement-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("plan: the lending fixture (remaining-work shape + every hold reason)", () => {
  it("levels over model.edges with loops-to excluded, every base main (MIL-280), every hold present", () => {
    const { file } = writeLendingFixture(dir);
    // The translation's notice event loops back to the to-do view it reads: a real loops-to edge.
    const { model } = compile(readFileSync(file, "utf8"));
    expect(semanticEdges(model).some((e) => e.source === "loops-to")).toBe(true);

    create(file, "loans", { kind: "slices", keys: LENDING_ENGAGEMENT_KEYS });
    const p = plan(file, "loans");
    expect(p.levels.map((l) => [l.level, l.width, l.ceiling])).toEqual([
      [0, 23, 3],
      [1, 2, 3],
      [2, 1, 3],
    ]);
    const by = new Map(p.slices.map((s) => [s.key, s]));
    for (const k of lendingViewKeys) expect(by.get(k)).toMatchObject({ level: 0, base: "main", held: null, ready: true, branch: `impl/${k}` });
    expect(by.get("overdue-loans-to-notify")).toMatchObject({ level: 0, base: "main", held: null, pattern: "state-view" });
    expect(by.get("send-overdue-notice")).toMatchObject({
      level: 1,
      pattern: "translation",
      upstreams: ["overdue-loans-to-notify"],
      base: "main",
      held: null,
    });
    expect(by.get("loan-history")).toMatchObject({ level: 2, base: "main", held: null });
    // MIL-280: two unmerged in-engagement upstreams set the level and nothing else — no hold, base main.
    expect(by.get("reservations")).toMatchObject({
      level: 1,
      upstreams: ["reserve-tool", "cancel-reservation"],
      base: "main",
      planHeld: null,
      held: null,
    });
    expect(p.slices.every((s) => s.base === "main")).toBe(true);
    expect(by.get("damage-reports")).toMatchObject({ level: 0, planHeld: "upstream-outside-engagement-unmerged" });
    const ratings = by.get("tool-ratings")!;
    expect(ratings).toMatchObject({ ready: false, planHeld: "not-ready", docStatus: "draft" });
    expect(ratings.readyDiagnostics.map((d) => d.code)).toEqual(["slice-ready-status-not-ready"]);
    // Slices are listed level by level.
    expect(p.slices.map((s) => s.level)).toEqual([...p.slices.map((s) => s.level)].sort((a, b) => a - b));
    expect(formatEngagementPlanText(p).split("\n")).toEqual(
      expect.arrayContaining([
        "level 0: 23 slices (ceiling 3)",
        "level 1: 2 slices (ceiling 3)",
        "level 2: 1 slice (ceiling 3)",
        "  send-overdue-notice [translation] impl/send-overdue-notice on main · state: planned",
        "  reservations [state-view] impl/reservations on main · state: planned",
        "  damage-reports [state-view] impl/damage-reports on main · state: planned · held: upstream-outside-engagement-unmerged",
      ]),
    );
  });

  it("18 views + one translation on a to-do view: two levels, every base main, nothing held", () => {
    const { file } = writeLendingFixture(dir);
    const warning = create(file, "views", { kind: "slices", keys: [...lendingViewKeys, "overdue-loans-to-notify", "send-overdue-notice"] });
    expect(warning).toBeNull(); // all over the same foundation: one component
    const p = plan(file, "views");
    expect(p.levels.map((l) => l.width)).toEqual([19, 1]);
    expect([...new Set(p.slices.map((s) => s.base))]).toEqual(["main"]);
    expect(p.slices.every((s) => s.held === null)).toBe(true);
  });

  it("in-engagement upstreams never hold a slice or move its base, merged or not (MIL-280)", () => {
    const { file } = writeLendingFixture(dir);
    create(file, "loans", { kind: "slices", keys: LENDING_ENGAGEMENT_KEYS });
    const reservations = () => plan(file, "loans").slices.find((s) => s.key === "reservations");
    expect(reservations()).toMatchObject({ held: null, planHeld: null, base: "main", upstreams: ["reserve-tool", "cancel-reservation"] });
    expect(set(file, "loans", "reserve-tool", "merged", { pr: "https://example.test/pr/1" })).toMatchObject({ ok: true, changed: true });
    expect(reservations()).toMatchObject({ held: null, planHeld: null, base: "main" });
    // `merged` inferred from the doc: cancel-reservation's doc reaches implemented -> still main, still not held.
    const docPath = join(dir, "slices", "cancel-reservation.md");
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("status: ready-to-implement", "status: implemented\nimplementedIn: https://example.test/pr/2"));
    const p = plan(file, "loans");
    expect(p.slices.find((s) => s.key === "cancel-reservation")).toMatchObject({ state: "merged", stateInferred: true, planHeld: null });
    expect(p.slices.find((s) => s.key === "reservations")).toMatchObject({ base: "main", held: null });
  });

  it("an upstream outside the engagement imposes nothing once its doc is implemented", () => {
    const { file } = writeLendingFixture(dir);
    create(file, "loans", { kind: "slices", keys: ["damage-reports"] });
    expect(plan(file, "loans").slices[0].held).toBe("upstream-outside-engagement-unmerged");
    const docPath = join(dir, "slices", "report-damage.md");
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("status: ready-to-implement", "status: implemented\nimplementedIn: https://example.test/pr/3"));
    expect(plan(file, "loans").slices[0]).toMatchObject({ held: null, base: "main" });
  });

  it("a human hold is reported beside the plan's own (never overwriting it)", () => {
    const { file } = writeLendingFixture(dir);
    create(file, "loans", { kind: "slices", keys: ["catalog-view-1", "tool-ratings"] });
    set(file, "loans", "catalog-view-1", "held");
    set(file, "loans", "tool-ratings", "held");
    const by = new Map(plan(file, "loans").slices.map((s) => [s.key, s]));
    expect(by.get("catalog-view-1")).toMatchObject({ state: "held", planHeld: null, held: "human" });
    expect(by.get("tool-ratings")).toMatchObject({ state: "held", planHeld: "not-ready", held: "not-ready" });
  });
});

describe("new: selection", () => {
  it("three unrelated lifecycles: warns naming 3 components; plan puts all at level 0 on main", () => {
    const { file } = writeLifecyclesFixture(dir);
    const warning = create(file, "three", { kind: "slices", keys: ["shipment-list", "account-list", "order-list"] });
    expect(warning).toBe(
      "warn: em engagement new: the selection has 3 unconnected components in the dependency graph — consider 3 engagements:\n" +
        "  1: account-list\n  2: order-list\n  3: shipment-list",
    );
    const p = plan(file, "three");
    expect(p.levels).toEqual([{ level: 0, width: 3, ceiling: 3, slices: ["account-list", "order-list", "shipment-list"] }]);
    expect(p.slices.every((s) => s.base === "main" && s.held === null)).toBe(true);
  });

  it("--context takes every slice with an event in that context", () => {
    const { file } = writeLifecyclesFixture(dir);
    const r = buildNewEngagement(input(file), { slug: "orders", selector: { kind: "context", context: "orders" }, parallel: 3, createdBy: null, created: "2026-10-08" });
    expect(r.ok && r.units).toEqual(["place-order"]);
  });

  // GH #348 (acceptance lines noted per test)
  const storyModel = `model "S"
context Shop

storyline "Alpha Story" {
  slice "A One" {
    command Do A { id: UUID }
    event A Done { id: UUID }
  }
}

storyline "Beta Story" after "Alpha Story" {
  slice "B One" {
    command Do B { id: UUID }
    event B Done { id: UUID }
  }
}

storyline "Alpha Story" {
  slice "A Two" {
    command Do A2 { id: UUID }
    event A2 Done { id: UUID }
  }
}
`;
  const runStory = (name: string) => {
    const file = join(dir, "story.em");
    writeFileSync(file, storyModel);
    return buildNewEngagement(input(file), { slug: "s", selector: { kind: "storyline", name }, parallel: 3, createdBy: null, created: "2026-10-19" });
  };

  it("--storyline: name is case/whitespace-insensitive and a continued storyline (two blocks) is one storyline, model order [#348 resolves via findStoryline; continued = one]", () => {
    const r = runStory("  alpha   STORY ");
    expect(r.ok && r.units).toEqual(["a-one", "a-two"]);
  });

  it("--storyline: a storyline declared `after` selects only its own slices [#348 after]", () => {
    const r = runStory("Beta Story");
    expect(r.ok && r.units).toEqual(["b-one"]);
  });

  it("--storyline: an unknown name is refused listing the declared storylines [#348 unknown name]", () => {
    expect(runStory("Gamma")).toEqual({ ok: false, message: '--storyline: no storyline "Gamma" (declared: "Alpha Story", "Beta Story")' });
    const file = join(dir, "none.em");
    writeFileSync(file, 'model "N"\ncontext Shop\nslice "X" {\n  command Do X { id: UUID }\n  event X Done { id: UUID }\n}\n');
    const r = buildNewEngagement(input(file), { slug: "s", selector: { kind: "storyline", name: "Gamma" }, parallel: 3, createdBy: null, created: "2026-10-19" });
    expect(r).toEqual({ ok: false, message: '--storyline "Gamma": no storylines are declared in this model' });
  });

  it("--storyline (CLI): matches `em query slices --storyline` on examples/storylines.em, and is exclusive with the other selectors [#348 fourth selector, exactly one]", () => {
    const src = join(ROOT, "examples", "storylines.em");
    writeFileSync(join(dir, "storylines.em"), readFileSync(src, "utf8"));
    for (const name of ["Bring a product to market", "retire a product"]) {
      const q = JSON.parse(em(["query", "slices", "storylines.em", "--storyline", name, "--json"], dir).stdout) as { results: { ref: string }[] };
      const made = em(["engagement", "new", "storylines.em", "st", "--storyline", name, "--force"], dir);
      expect(made.status).toBe(0);
      const p = JSON.parse(em(["engagement", "plan", "storylines.em", "st", "--json"], dir).stdout) as { slices: { key: string }[] };
      // The query lists the declared slices; the engagement folds an `again` view slice into the unit
      // of the view's originating slice (as --context does), so those units are the query's refs
      // with each `again` slice replaced by its origin.
      const keys = p.slices.map((x) => x.key).sort();
      const expected = name === "Bring a product to market" ? ["create-product", "list-products", "publish-product"] : ["archive-product", "list-products"];
      expect(keys).toEqual(expected);
      expect(q.results.length).toBeGreaterThan(0);
      for (const r of q.results) if (!r.ref.startsWith("list-")) expect(keys).toContain(r.ref);
    }
    const both = em(["engagement", "new", "storylines.em", "x", "--storyline", "Retire a product", "--context", "Catalog"], dir);
    expect(both.stderr).toBe("em engagement new: pass exactly one of --slices, --context, --storyline, --downstream-of\n");
    const bad = em(["engagement", "new", "storylines.em", "x", "--storyline", "Nope"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--storyline: no storyline "Nope" (declared: "Bring a product to market", "Extend an attribute", "Retire a product")');
  });

  it("--downstream-of follows edges downstream, never back along loops-to", () => {
    const { file } = writeLendingFixture(dir);
    const run = (ref: string) => buildNewEngagement(input(file), { slug: "d", selector: { kind: "downstream-of", ref }, parallel: 3, createdBy: null, created: "2026-10-08" });
    const bySlice = run("overdue-loans-to-notify");
    expect(bySlice.ok && bySlice.units).toEqual(["overdue-loans-to-notify", "send-overdue-notice", "loan-history"]);
    const byRef = run("send-overdue-notice/event.overdue-notice-sent");
    expect(byRef.ok && byRef.units).toEqual(["send-overdue-notice", "loan-history"]);
    expect(run("No Such Thing")).toEqual({ ok: false, message: '--downstream-of: no element matches "No Such Thing"' });
  });

  it("continuations fold into their originating slice; a selection naming both is one unit", () => {
    writeFileSync(
      join(dir, "p.em"),
      `persona Member\nslice "Edit Profile" {\n  ui Profile Form @Member\n  command Edit Profile\n  event Profile Edited\n}\n` +
        `slice "Profile View" {\n  view Profile View from "Profile Edited"\n  ui Profile Screen @Member\n}\n` +
        `slice "Change Avatar" {\n  ui Avatar Form @Member\n  command Change Avatar\n  event Avatar Changed\n}\n` +
        `slice "Profile View Again" {\n  view Profile View again from "Avatar Changed"\n  ui Profile Screen Again @Member\n}\n`,
    );
    const r = buildNewEngagement(input(join(dir, "p.em")), {
      slug: "p",
      selector: { kind: "slices", keys: ["profile-view-again", "profile-view"] },
      parallel: 3,
      createdBy: null,
      created: "2026-10-08",
    });
    expect(r.ok && r.units).toEqual(["profile-view"]);
  });

  it.each([
    [{ kind: "context", context: "Nowhere" } as Selector, "the selection is empty — nothing to engage"],
  ])("refuses %j", (selector, message) => {
    const { file } = writeLifecyclesFixture(dir);
    expect(buildNewEngagement(input(file), { slug: "x", selector, parallel: 3, createdBy: null, created: "2026-10-08" })).toEqual({ ok: false, message });
  });

  it("refuses unknown slice keys, naming each and the valid keys (GH #237)", () => {
    const { file } = writeLifecyclesFixture(dir);
    const r = buildNewEngagement(input(file), { slug: "x", selector: { kind: "slices", keys: ["nope", "also-nope"] }, parallel: 3, createdBy: null, created: "2026-10-08" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('no slice with export key "nope" in this model — valid keys: ');
      expect(r.message).toContain('; no slice with export key "also-nope"');
    }
  });

  it("refuses a bad slug and a bad --parallel", () => {
    const { file } = writeLifecyclesFixture(dir);
    const sel: Selector = { kind: "slices", keys: ["order-list"] };
    expect(buildNewEngagement(input(file), { slug: "Bad Slug", selector: sel, parallel: 3, createdBy: null, created: "2026-10-08" })).toEqual({
      ok: false,
      message: 'invalid slug "Bad Slug" — expected kebab-case (a-z, 0-9, -)',
    });
    expect(buildNewEngagement(input(file), { slug: "ok", selector: sel, parallel: 0, createdBy: null, created: "2026-10-08" })).toEqual({
      ok: false,
      message: "--parallel must be a positive integer",
    });
  });
});

describe("plan: cycles", () => {
  it("refuses, naming the cycle, when one survives the loops-to exclusion", () => {
    writeFileSync(
      join(dir, "c.em"),
      `persona Member\nslice "Edit Profile" {\n  ui Profile Form @Member\n  command Edit Profile\n  event Profile Edited\n}\n` +
        `slice "Profile View" {\n  view Profile View from "Profile Edited"\n  ui Profile Screen @Member\n}\narrow Profile View -> Profile Form\n`,
    );
    const file = join(dir, "c.em");
    create(file, "cyc", { kind: "slices", keys: ["edit-profile", "profile-view"] });
    expect(engagementPlanFor(input(file), "cyc")).toEqual({
      ok: false,
      message: "the engagement's dependency graph has a cycle (loops-to edges already excluded): profile-view -> edit-profile -> profile-view",
    });
  });
});

describe("set / status / close", () => {
  it("set is idempotent, merged is terminal, held records heldBy: human and leaving held drops it", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "three", { kind: "slices", keys: ["account-list", "order-list"] });
    const path = engagementPath(file, "three");
    expect(set(file, "three", "account-list", "building", { branch: "impl/account-list", base: "main" })).toMatchObject({ ok: true, changed: true });
    const once = readFileSync(path, "utf8");
    expect(once).toContain("  - {key: account-list, state: building, branch: \"impl/account-list\", base: \"main\", pr: null}");
    expect(once).toContain("| `account-list` | state-view | ready-to-implement | building | impl/account-list | main | — |");
    expect(set(file, "three", "account-list", "building")).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(path, "utf8")).toBe(once);

    set(file, "three", "order-list", "held");
    expect(readFileSync(path, "utf8")).toContain("  - {key: order-list, state: held, branch: null, base: null, pr: null, heldBy: human}");
    expect(readFileSync(path, "utf8")).toContain("| held (human) |");
    set(file, "three", "order-list", "building");
    expect(readFileSync(path, "utf8")).toContain("  - {key: order-list, state: building, branch: null, base: null, pr: null}");

    set(file, "three", "account-list", "merged", { pr: "https://example.test/pr/9" });
    expect(set(file, "three", "account-list", "merged")).toMatchObject({ ok: true, changed: false });
    expect(set(file, "three", "account-list", "gap")).toEqual({ ok: false, message: 'slice "account-list" is merged — merged is terminal' });
    expect(set(file, "three", "nope", "gap")).toEqual({ ok: false, message: 'slice "nope" is not in engagement "three"' });
    expect(set(file, "three", "order-list", "done")).toEqual({
      ok: false,
      message: 'invalid --state "done" — expected one of: planned, building, validating, review, awaiting-merge, merged, held, gap',
    });
  });

  it("status joins the Ledger with doc status; close refuses until every slice is merged or gap, then closes once", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "three", { kind: "slices", keys: ["account-list", "order-list", "shipment-list"] });
    const status = () => {
      const r = engagementStatusFor(input(file), "three");
      if (!r.ok) throw new Error(r.message);
      return r.status;
    };
    const close = () => {
      const loaded = loadEngagement(file, "three");
      if (!loaded.ok) throw new Error(loaded.message);
      const r = applyEngagementClose("three", loaded.text, status());
      if (r.ok && r.changed) writeFileSync(loaded.path, r.text);
      return r;
    };
    set(file, "three", "account-list", "merged");
    set(file, "three", "order-list", "gap");
    expect(status()).toMatchObject({ closable: false, counts: { merged: 1, gap: 1, planned: 1 } });
    expect(close()).toEqual({
      ok: false,
      message: 'engagement "three" is not closable — every slice must be merged or gap; still open: shipment-list (planned)',
    });
    // merged inferred from the doc counts toward closable.
    const docPath = join(dir, "slices", "shipment-list.md");
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("status: ready-to-implement", "status: implemented\nimplementedIn: https://example.test/pr/4"));
    expect(status().slices[2]).toMatchObject({ key: "shipment-list", state: "merged", stateInferred: true, docStatus: "implemented" });
    expect(close()).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(engagementPath(file, "three"), "utf8")).toContain("\nstatus: closed\n");
    expect(close()).toMatchObject({ ok: true, changed: false });
    const loaded = loadEngagement(file, "three");
    expect(loaded.ok && applyEngagementSet(input(file), "three", loaded.text, loaded.file, { key: "order-list", state: "planned" })).toEqual({
      ok: false,
      message: 'engagement "three" is closed',
    });
  });

  it("a set on a CRLF engagement file keeps CRLF throughout", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "crlf", { kind: "slices", keys: ["account-list"] });
    const path = engagementPath(file, "crlf");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n/g, "\r\n"));
    set(file, "crlf", "account-list", "review", { pr: "https://example.test/pr/5" });
    const text = readFileSync(path, "utf8");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain("| review |");
  });
});

describe("em engagement (CLI)", () => {
  it("new writes the file, warns on stderr, refuses an existing slug without --force; set/plan/status/close refusals are exact", () => {
    const { file } = writeLifecyclesFixture(dir);
    const rel = "lifecycles.em";
    const first = em(["engagement", "new", rel, "three", "--slices", "account-list,order-list,shipment-list", "--by", "Alex Rivera"], dir);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("warn: em engagement new: the selection has 3 unconnected components");
    expect(first.stdout).toBe("wrote engagements/three.md (3 slices: account-list, order-list, shipment-list)\n");
    expect(readFileSync(engagementPath(file, "three"), "utf8")).toContain('createdBy: "Alex Rivera"');
    expect(readFileSync(engagementPath(file, "three"), "utf8")).toContain('\nmodel: "../lifecycles.em"\n');

    const again = em(["engagement", "new", rel, "three", "--slices", "order-list"], dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toBe('em engagement new: engagement "three" already exists (engagements/three.md) — pass --force to overwrite\n');
    const forced = em(["engagement", "new", rel, "three", "--slices", "order-list", "--force"], dir);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toBe("wrote engagements/three.md (1 slice: order-list)\n");

    expect(em(["engagement", "new", rel, "x", "--slices", "a", "--context", "b"], dir).stderr).toBe(
      "em engagement new: pass exactly one of --slices, --context, --storyline, --downstream-of\n",
    );

    const setOk = em(["engagement", "set", rel, "three", "order-list", "--state", "building", "--branch", "impl/order-list"], dir);
    expect(setOk.stdout).toBe("set order-list: building (engagements/three.md)\n");
    const setSame = em(["engagement", "set", rel, "three", "order-list", "--state", "building"], dir);
    expect(setSame.stdout).toBe("no change: order-list is already building (engagements/three.md)\n");
    const setBad = em(["engagement", "set", rel, "three", "nope", "--state", "gap"], dir);
    expect(setBad.status).toBe(1);
    expect(setBad.stderr).toBe('em engagement set: slice "nope" is not in engagement "three"\n');

    const missing = em(["engagement", "plan", rel, "ghost"], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('em engagement plan: no engagement "ghost" (expected engagements/ghost.md)\n');

    const planText = em(["engagement", "plan", rel, "three"], dir);
    expect(planText.stdout).toBe(
      'engagement "three" (open) — 1 slice(s) in 1 level(s), parallel 3\nlevel 0: 1 slice (ceiling 3)\n  order-list [state-view] impl/order-list on main · state: building\n',
    );

    const closeBad = em(["engagement", "close", rel, "three"], dir);
    expect(closeBad.status).toBe(1);
    expect(closeBad.stderr).toBe('em engagement close: engagement "three" is not closable — every slice must be merged or gap; still open: order-list (building)\n');

    const statusText = em(["engagement", "status", rel, "three"], dir);
    expect(statusText.stdout).toContain("  order-list [state-view] doc: ready-to-implement · state: building · branch impl/order-list\nclosable: no — 1 slice(s) not merged or gap\n");

    // The engagement belongs to its model: any other .em is refused by every verb but `new`.
    writeFileSync(join(dir, "other.em"), readFileSync(file, "utf8"));
    for (const verb of ["plan", "status", "close"]) {
      const wrong = em(["engagement", verb, "other.em", "three"], dir);
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toBe(`em engagement ${verb}: engagements/three.md belongs to ../lifecycles.em, not other.em\n`);
    }
    expect(em(["engagement", "set", "other.em", "three", "order-list", "--state", "gap"], dir).stderr).toBe(
      "em engagement set: engagements/three.md belongs to ../lifecycles.em, not other.em\n",
    );
    expect(em(["status", "other.em"], dir).stdout).toContain("\nopen engagements: 0\n");

    const overall = em(["status", rel], dir);
    expect(overall.stdout).toContain("\nopen engagements: 1 (three)\n");
    expect(existsSync(join(dir, "engagements", "three.md"))).toBe(true);
  }, 90_000); // ~8 CLI spawns in one case: 32 s on a cold CI runner (main red at 4956d19); per-test ceiling
});

// GH #241: the engagement-level `tracking:` key, and the slice doc's own `tracking:` winning over it.
describe("engagement tracking key (GH #241)", () => {
  const status = (file: string, slug: string) => {
    const r = engagementStatusFor(input(file), slug);
    if (!r.ok) throw new Error(r.message);
    return r.status;
  };

  it("new writes the key when given and no tracking line when absent; plan and status carry it", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "plain", { kind: "slices", keys: ["order-list"] });
    expect(readFileSync(engagementPath(file, "plain"), "utf8")).not.toContain("tracking:");
    expect(plan(file, "plain")).toMatchObject({ tracking: null, slices: [{ tracking: null }] });

    create(file, "tracked", { kind: "slices", keys: ["order-list"] }, 3, "PROJ-123");
    const text = readFileSync(engagementPath(file, "tracked"), "utf8");
    expect(text).toContain('\ntracking: "PROJ-123"\n');
    expect(text).toContain('engagementSchemaVersion: "1.1"');
    expect(plan(file, "tracked")).toMatchObject({ tracking: "PROJ-123", slices: [{ key: "order-list", tracking: "PROJ-123" }] });
    expect(status(file, "tracked")).toMatchObject({ tracking: "PROJ-123", slices: [{ key: "order-list", tracking: "PROJ-123" }] });
  });

  it("a 1.0 engagement file (no tracking) still reads", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "old", { kind: "slices", keys: ["order-list"] });
    const path = engagementPath(file, "old");
    writeFileSync(path, readFileSync(path, "utf8").replace('engagementSchemaVersion: "1.1"', 'engagementSchemaVersion: "1.0"'));
    expect(plan(file, "old").tracking).toBeNull();
  });

  it("a slice doc's own tracking: wins over the engagement's for that slice only", () => {
    const { file } = writeLifecyclesFixture(dir);
    const doc = join(dir, "slices", "order-list.md");
    writeFileSync(doc, readFileSync(doc, "utf8").replace("status: ready-to-implement", "status: ready-to-implement\ntracking: https://tracker.test/ORD-9"));
    create(file, "mixed", { kind: "slices", keys: ["order-list", "account-list"] }, 3, "PROJ-123");
    const bySlice = (rows: { key: string; tracking: string | null }[]) => Object.fromEntries(rows.map((r) => [r.key, r.tracking]));
    expect(bySlice(plan(file, "mixed").slices)).toEqual({ "order-list": "https://tracker.test/ORD-9", "account-list": "PROJ-123" });
    expect(bySlice(status(file, "mixed").slices)).toEqual({ "order-list": "https://tracker.test/ORD-9", "account-list": "PROJ-123" });
  });

  it("rejects an empty or multi-line key", () => {
    const { file } = writeLifecyclesFixture(dir);
    for (const bad of ["", "   ", "A\nB"]) {
      const r = buildNewEngagement(input(file), { slug: "bad", selector: { kind: "slices", keys: ["order-list"] }, parallel: 3, createdBy: null, tracking: bad, created: "2026-10-08" });
      expect(r).toEqual({ ok: false, message: "--tracking must be a non-empty single line (a ticket key or URL)" });
    }
  });

  it("the CLI flag writes the key and --json carries it", () => {
    const { file } = writeLifecyclesFixture(dir);
    expect(em(["engagement", "new", "lifecycles.em", "cli", "--slices", "order-list", "--tracking", "PROJ-7"], dir).status).toBe(0);
    expect(readFileSync(engagementPath(file, "cli"), "utf8")).toContain('tracking: "PROJ-7"');
    const p = JSON.parse(em(["engagement", "plan", "lifecycles.em", "cli", "--json"], dir).stdout);
    expect(p).toMatchObject({ engagementPlanSchemaVersion: "1.4", tracking: "PROJ-7", slices: [{ tracking: "PROJ-7" }] });
    const s = JSON.parse(em(["engagement", "status", "lifecycles.em", "cli", "--json"], dir).stdout);
    expect(s).toMatchObject({ engagementStatusSchemaVersion: "1.1", tracking: "PROJ-7", slices: [{ tracking: "PROJ-7" }] });
  }, 60_000);
});

// GH #334: the PR title template on the engagement, resolved per slice in the plan.
describe("engagement prTitle template (GH #334)", () => {
  it("resolvePrTitle: default with key, default without key, template with key, {key} template without key, no placeholders", () => {
    expect(resolvePrTitle(null, "PROJ-1", "Order List")).toBe("PROJ-1: Order List");
    expect(resolvePrTitle(null, null, "Order List")).toBe("Order List");
    expect(resolvePrTitle("feat({slice}): add it [{key}]", "PROJ-1", "Order List")).toBe("feat(Order List): add it [PROJ-1]");
    expect(resolvePrTitle("feat: {slice} ({key})", null, "Order List")).toBe("Order List");
    expect(resolvePrTitle("feat: {slice}", null, "Order List")).toBe("feat: Order List");
    expect(resolvePrTitle("chore: fixed title", "PROJ-1", "Order List")).toBe("chore: fixed title");
  });

  it("round-trips through the file; absent key is null and the plan carries the default", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "plain", { kind: "slices", keys: ["order-list"] });
    expect(readFileSync(engagementPath(file, "plain"), "utf8")).not.toContain("prTitle:");
    const p0 = plan(file, "plain");
    expect(p0.prTitle).toBeNull();
    expect(p0.slices[0].prTitle).not.toContain("{");

    const r = buildNewEngagement(input(file), { slug: "titled", selector: { kind: "slices", keys: ["order-list"] }, parallel: 3, createdBy: null, tracking: "PROJ-9", prTitle: "feat({slice}): add [{key}]", created: "2026-10-08" });
    if (!r.ok) throw new Error(r.message);
    const path = engagementPath(file, "titled");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, r.text);
    expect(r.text).toContain('\nprTitle: "feat({slice}): add [{key}]"\n');
    const parsed = parseEngagementFile(r.text);
    expect(parsed.ok && parsed.file.prTitle).toBe("feat({slice}): add [{key}]");
    const p = plan(file, "titled");
    expect(p.prTitle).toBe("feat({slice}): add [{key}]");
    expect(p.slices[0].prTitle).toMatch(/^feat\(.+\): add \[PROJ-9\]$/);
  });

  it("writes 1.1 without --pr-title and 1.2 with it; a literal 1.1 file reads prTitle null", () => {
    const { file } = writeLifecyclesFixture(dir);
    const sel: Selector = { kind: "slices", keys: ["order-list"] };
    const base = { slug: "v", selector: sel, parallel: 3, createdBy: null, created: "2026-10-08" };
    const without = buildNewEngagement(input(file), base);
    const withT = buildNewEngagement(input(file), { ...base, prTitle: "feat: {sliceKey}" });
    if (!without.ok || !withT.ok) throw new Error("new failed");
    expect(without.text).toContain('engagementSchemaVersion: "1.1"');
    expect(withT.text).toContain('engagementSchemaVersion: "1.2"');
    const parsed = parseEngagementFile(without.text);
    expect(parsed.ok && parsed.file.prTitle).toBeNull();
  });

  it("{sliceKey} is the slice key; a {key} template on a keyless slice falls back and the plan warns in preflight", () => {
    expect(resolvePrTitle("feat: {sliceKey} ({slice})", null, "Order List", "order-list")).toBe("feat: order-list (Order List)");
    expect(resolvePrTitle("feat: {sliceKey} [{key}]", "P-1", "Order List", "order-list")).toBe("feat: order-list [P-1]");
    const { file } = writeLifecyclesFixture(dir);
    const r = buildNewEngagement(input(file), { slug: "fb", selector: { kind: "slices", keys: ["order-list"] }, parallel: 3, createdBy: null, prTitle: "feat: {sliceKey} [{key}]", created: "2026-10-08" });
    if (!r.ok) throw new Error(r.message);
    const path = engagementPath(file, "fb");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, r.text);
    const p = plan(file, "fb");
    expect(p.slices[0].prTitle).not.toContain("{");
    expect(p.preflight.filter((f) => f.kind === "pr-title-fallback")).toMatchObject([{ subject: "order-list", slices: ["order-list"] }]);
    expect(formatEngagementPlanText(p)).toContain("pr-title-fallback:");
  });

  it("the CLI warns on stderr when --pr-title uses {key}", () => {
    writeLifecyclesFixture(dir);
    const r = em(["engagement", "new", "lifecycles.em", "warn", "--slices", "order-list", "--pr-title", "feat: {slice} [{key}]"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("slices without a tracking key fall back");
    const keyed = em(["engagement", "new", "lifecycles.em", "nowarn", "--slices", "order-list", "--tracking", "PROJ-12", "--pr-title", "feat({key}): {sliceKey}"], dir);
    expect(keyed.status).toBe(0);
    expect(keyed.stderr).not.toContain("fall back");
  }, 60_000);

  it("the default with a tracking key is `<key>: <slice name>`", () => {
    const { file } = writeLifecyclesFixture(dir);
    create(file, "tracked-default", { kind: "slices", keys: ["order-list"] }, 3, "PROJ-5");
    expect(plan(file, "tracked-default").slices[0].prTitle).toMatch(/^PROJ-5: .+/);
  });

  it("rejects an empty or multi-line template", () => {
    const { file } = writeLifecyclesFixture(dir);
    for (const bad of ["", "  ", "a\nb"]) {
      const r = buildNewEngagement(input(file), { slug: "bad", selector: { kind: "slices", keys: ["order-list"] }, parallel: 3, createdBy: null, prTitle: bad, created: "2026-10-08" });
      expect(r).toEqual({ ok: false, message: "--pr-title must be a non-empty single line (a template using {key} and {slice})" });
    }
  });

  it("the CLI flag writes the template and plan --json carries the resolved title per slice", () => {
    const { file } = writeLifecyclesFixture(dir);
    expect(em(["engagement", "new", "lifecycles.em", "titled-cli", "--slices", "order-list", "--tracking", "PROJ-7", "--pr-title", "feat: {slice} [{key}]"], dir).status).toBe(0);
    expect(readFileSync(engagementPath(file, "titled-cli"), "utf8")).toContain('prTitle: "feat: {slice} [{key}]"');
    const p = JSON.parse(em(["engagement", "plan", "lifecycles.em", "titled-cli", "--json"], dir).stdout);
    expect(p.engagementPlanSchemaVersion).toBe("1.4");
    expect(p.prTitle).toBe("feat: {slice} [{key}]");
    expect(p.slices[0].prTitle).toMatch(/^feat: .+ \[PROJ-7\]$/);
  }, 60_000);
});

// MIL-283: the Ledger's inferred `merged` and the outside-upstream hold read the shipped record.
describe("engagement reads the shipped record, not the working status (MIL-283)", () => {
  it("a slice whose next version is an open draft over a shipped one is inferred merged; an outside upstream in that state imposes no hold", () => {
    const { file } = writeLendingFixture(dir);
    create(file, "loans", { kind: "slices", keys: ["damage-reports"] });
    expect(plan(file, "loans").slices[0].held).toBe("upstream-outside-engagement-unmerged");
    // The outside upstream ships, then its next version opens as a draft (what `mark-implemented` /
    // `revise` produce): still shipped → no hold.
    const upstream = join(dir, "slices", "report-damage.md");
    writeFileSync(upstream, readFileSync(upstream, "utf8").replace("status: ready-to-implement\nversion: 1", "status: draft\nversion: 2\nimplementedIn: https://example.test/pr/3\nshippedVersion: 1"));
    expect(plan(file, "loans").slices[0]).toMatchObject({ held: null, base: "main" });
    // The engagement's own slice in the same shape is inferred merged.
    const own = join(dir, "slices", "damage-reports.md");
    writeFileSync(own, readFileSync(own, "utf8").replace("status: ready-to-implement\nversion: 1", "status: draft\nversion: 2\nimplementedIn: https://example.test/pr/4\nshippedVersion: 1"));
    expect(plan(file, "loans").slices[0]).toMatchObject({ state: "merged", stateInferred: true, docStatus: "draft" });
  });
});

// GH #239: the plan's pre-flight — the model-wide gaps every parallel implementer would otherwise
// rediscover on its own, put to the human in one round before fan-out. Advisory: never a hold.
describe("plan pre-flight (GH #239)", () => {
  const READY = "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n---\n# Slice\n\n## Intent\n\nbody\n";
  const MODEL = [
    'slice "Place Order" {',
    "  ui Checkout Screen @Customer",
    '  command Place Order note "slices/place-order.md"',
    '  invariant INV-ORD-1 "An order has at least one line"',
    "  event Order Placed @Orders { orderId }", // no tag at all → event-without-tag
    "}",
    'slice "Cancel Order" {',
    "  ui Checkout Screen @Customer", // same screen as Place Order → shared-trigger
    '  command Cancel Order note "slices/cancel-order.md"',
    "  event Order Cancelled @Orders { orderId tag }", // tagged: fine
    "}",
    'slice "Ship Order" {',
    "  ui Warehouse Screen @Clerk",
    '  command Ship Order note "slices/ship-order.md"',
    '  invariant INV-SHP-1 "Only a placed order ships"',
    "  event Order Shipped @Orders { orderId tag }",
    "}",
    'slice "Order List" {',
    '  view Orders from "Order Placed", "Order Cancelled", "Order Shipped" note "slices/order-list.md"',
    "  ui Orders Screen @Customer",
    "}",
    "",
  ].join("\n");
  function write(): string {
    mkdirSync(join(dir, "slices"), { recursive: true });
    for (const k of ["place-order", "cancel-order", "ship-order", "order-list"]) writeFileSync(join(dir, "slices", `${k}.md`), READY);
    // cancel-order's doc CITES place-order's invariant (the day-job shape: two docs, one rule, no owner) → repeated-invariant
    // (the template's bullet form: only a structural line under `## Invariants` OWNS an id — a table row or prose merely mentions one)
    writeFileSync(join(dir, "slices", "cancel-order.md"), READY + "\n## Invariants\n\n- INV-ORD-1 — An order has at least one line\n");
    const file = join(dir, "orders.em");
    writeFileSync(file, MODEL);
    return file;
  }

  it("names the repeated invariant, the untagged event and the shared ui — scoped to the engagement's slices, model order, no hold", () => {
    const file = write();
    create(file, "all", { kind: "slices", keys: ["place-order", "cancel-order", "ship-order", "order-list"] });
    const p = plan(file, "all");
    expect(p.preflight.map((f) => [f.kind, f.subject, f.slices])).toEqual([
      ["repeated-invariant", "INV-ORD-1", ["place-order", "cancel-order"]],
      ["event-without-tag", "Order Placed", ["place-order"]],
      ["shared-trigger", "Checkout Screen", ["place-order", "cancel-order"]],
    ]);
    expect(p.preflight[0].message).toContain("appears in 2 of the engagement's slices (place-order, cancel-order) — declared in the model or cited in the slice docs; decide once");
    expect(p.preflight[1].message).toContain('event "Order Placed" (place-order) carries no tag');
    expect(p.preflight[2].message).toContain('ui "Checkout Screen" triggers commands in 2 slices');
    expect(p.slices.every((s) => s.planHeld === null)).toBe(true);
    const text = formatEngagementPlanText(p);
    expect(text).toContain("pre-flight: 3 model-wide gap(s) the engagement's slices share — answer once, before dispatch");
    expect(text).toContain("  shared-trigger: ui \"Checkout Screen\"");
  });

  it("only counts what the engagement covers: an engagement of one slice sees the untagged event and nothing shared; a clean engagement has an empty list", () => {
    const file = write();
    create(file, "one", { kind: "slices", keys: ["place-order"] });
    expect(plan(file, "one").preflight.map((f) => f.kind)).toEqual(["event-without-tag"]);
    create(file, "clean", { kind: "slices", keys: ["ship-order", "order-list"] });
    expect(plan(file, "clean").preflight).toEqual([]);
    expect(formatEngagementPlanText(plan(file, "clean"))).not.toContain("pre-flight");
  });

  it("rolls a slice's doc↔model findings into one doc-model-mismatch per slice, from the caller's diagnostics", () => {
    const file = write();
    const inp = input(file);
    const idx = buildUnitIndex(inp.model, inp.refs, inp.baseDir);
    const withDiags = {
      ...inp,
      allDiagnostics: [
        ...inp.allDiagnostics,
        { severity: "warning" as const, code: "doc-model-field-mismatch", message: 'slice "ship-order": doc lists field "carrier" on event "Order Shipped" the model does not declare', refs: ["ship-order"] },
        { severity: "warning" as const, code: "doc-model-element-not-in-model", message: 'slice "ship-order": doc names event "Label Printed" the model does not have', refs: ["ship-order/event.label-printed"] },
        { severity: "warning" as const, code: "doc-model-field-mismatch", message: "unrelated slice", refs: ["order-list"] },
      ],
    } as EngagementModelInput;
    const findings = computePreflight(withDiags, ["ship-order"], idx);
    expect(findings).toEqual([
      {
        kind: "doc-model-mismatch",
        subject: "ship-order",
        slices: ["ship-order"],
        message: expect.stringContaining('slice "ship-order": its doc and the model disagree (2 doc↔model finding(s)) — slice "ship-order": doc lists field "carrier"'),
      },
    ]);
  });

  it("GH #294: rolls doc-names-unfed-event into doc-model-mismatch but not the milder doc-omits-fed-event", () => {
    const file = write();
    const inp = input(file);
    const idx = buildUnitIndex(inp.model, inp.refs, inp.baseDir);
    const withDiags = {
      ...inp,
      allDiagnostics: [
        ...inp.allDiagnostics,
        { severity: "warning" as const, code: "doc-names-unfed-event", message: "doc names an unfed event", refs: ["ship-order", "ship-order/view.x"] },
        { severity: "warning" as const, code: "doc-omits-fed-event", message: "doc omits a fed event", refs: ["ship-order"] },
      ],
    } as EngagementModelInput;
    const findings = computePreflight(withDiags, ["ship-order"], idx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("doc names an unfed event");
    expect(findings[0].message).not.toContain("doc omits a fed event");
  });

  it("--json carries preflight under plan schema 1.4 and the MCP-shared builder prints it", () => {
    const file = write();
    create(file, "cli", { kind: "slices", keys: ["place-order", "cancel-order"] });
    const p = JSON.parse(em(["engagement", "plan", "orders.em", "cli", "--json"], dir).stdout);
    expect(p.engagementPlanSchemaVersion).toBe("1.4");
    expect(p.preflight.map((f: { kind: string }) => f.kind)).toEqual(["repeated-invariant", "event-without-tag", "shared-trigger"]);
    expect(em(["engagement", "plan", "orders.em", "cli"], dir).stdout).toContain("pre-flight: 3 model-wide gap(s)");
  }, 60_000);
});
