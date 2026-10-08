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
  engagementPlanFor,
  engagementStatusFor,
  formatEngagementPlanText,
} from "../src/cli/engagement.js";
import { engagementPath, loadEngagement } from "../src/cli/engagementFile.js";
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
function create(file: string, slug: string, selector: Selector, parallel = 3): string | null {
  const r = buildNewEngagement(input(file), { slug, selector, parallel, createdBy: "Alex Rivera", created: "2026-10-08" });
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
  it("levels over model.edges with loops-to excluded, one impl/<to-do view> base, every hold present", () => {
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
      base: "impl/overdue-loans-to-notify",
      held: null,
    });
    expect(by.get("loan-history")).toMatchObject({ level: 2, base: "impl/send-overdue-notice", held: null });
    expect(by.get("reservations")).toMatchObject({
      level: 1,
      upstreams: ["reserve-tool", "cancel-reservation"],
      base: null,
      planHeld: "multiple-unmerged-upstreams",
      held: "multiple-unmerged-upstreams",
    });
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
        "  send-overdue-notice [translation] impl/send-overdue-notice on impl/overdue-loans-to-notify · state: planned",
        "  reservations [state-view] impl/reservations on (none) · state: planned · held: multiple-unmerged-upstreams",
      ]),
    );
  });

  it("18 views + one translation on a to-do view: two levels, the only non-main base is impl/<to-do view>", () => {
    const { file } = writeLendingFixture(dir);
    const warning = create(file, "views", { kind: "slices", keys: [...lendingViewKeys, "overdue-loans-to-notify", "send-overdue-notice"] });
    expect(warning).toBeNull(); // all over the same foundation: one component
    const p = plan(file, "views");
    expect(p.levels.map((l) => l.width)).toEqual([19, 1]);
    const bases = [...new Set(p.slices.map((s) => s.base))];
    expect(bases).toEqual(["main", "impl/overdue-loans-to-notify"]);
    expect(p.slices.every((s) => s.held === null)).toBe(true);
  });

  it("two unmerged upstreams hold the slice; after set --state merged on one it plans on the other's branch", () => {
    const { file } = writeLendingFixture(dir);
    create(file, "loans", { kind: "slices", keys: LENDING_ENGAGEMENT_KEYS });
    expect(plan(file, "loans").slices.find((s) => s.key === "reservations")).toMatchObject({ held: "multiple-unmerged-upstreams", base: null });
    expect(set(file, "loans", "reserve-tool", "merged", { pr: "https://example.test/pr/1" })).toMatchObject({ ok: true, changed: true });
    expect(plan(file, "loans").slices.find((s) => s.key === "reservations")).toMatchObject({ held: null, planHeld: null, base: "impl/cancel-reservation" });
    // `merged` inferred from the doc: cancel-reservation's doc reaches implemented -> base main.
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
    [{ kind: "slices", keys: ["nope", "also-nope"] } as Selector, "unknown slice key(s): nope, also-nope"],
    [{ kind: "context", context: "Nowhere" } as Selector, "the selection is empty — nothing to engage"],
  ])("refuses %j", (selector, message) => {
    const { file } = writeLifecyclesFixture(dir);
    expect(buildNewEngagement(input(file), { slug: "x", selector, parallel: 3, createdBy: null, created: "2026-10-08" })).toEqual({ ok: false, message });
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
      "em engagement new: pass exactly one of --slices, --context, --downstream-of\n",
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
