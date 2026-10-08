// SPDX-License-Identifier: MIT
// MIL-270 (goal-spec criterion 24): the `event-modeling-engagement` skill.
//   (a) grep gates over the skill text, the router row, the amended implement contract (§8 rule 2
//       and rule 2a, R27) and the em-implementer definition (no orchestration text leaks in);
//   (b) a scripted scenario, no agents run: on a git copy of the MIL-268 lending fixture, follow
//       the skill's commands by hand (`em engagement new` + `plan`, step 3's `git worktree add`
//       from the plan's base + `em engagement set --state building`, the step 4-6 Ledger walk, a
//       simulated merge) and assert the worktree/branch/base layout and the Ledger states match
//       the plan, and that a merge releases the held dependent onto `impl/<upstream>`.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLendingFixture } from "./helpers/engagementFixture.js";
import { EM_ALL_SKILL_BUNDLE_DIRS, EM_SHARED_DIR_NAMES, EM_SKILL_DIR_NAMES } from "../src/cli/skillDirs.js";
import { checkSkillSyncBundle } from "../src/cli/skillCheck.js";
import { applySkillSyncBundle, planSkillSyncBundle } from "../src/cli/skillSync.js";

// CLI-spawning file: a cold CI runner takes ~5–6 s per spawn and vitest's default is 5 s
// (briefing §5, MIL-205 pattern). Each scenario step below keeps to a few spawns.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, ".claude", "skills");
const SKILL_MD = join(SKILLS, "event-modeling-engagement", "SKILL.md");
const REFERENCE_MD = join(SKILLS, "event-modeling-engagement", "reference", "engagement.md");
const ROUTER_MD = join(SKILLS, "event-modeling", "SKILL.md");
const IMPLEMENT_MD = join(SKILLS, "event-modeling-implement", "reference", "implement.md");
const PLUGIN_IMPLEMENT_MD = join(ROOT, "plugin", "skills", "implement", "reference", "implement.md");
const IMPLEMENTER_AGENT = join(ROOT, ".claude", "agents", "em-implementer.md");

const read = (p: string) => readFileSync(p, "utf8");
/** Collapse line wrapping so phrase checks don't depend on where a paragraph breaks. */
const flat = (p: string) => read(p).replace(/\s+/g, " ");

// --- (a) grep gates ---------------------------------------------------------------------------

describe("event-modeling-engagement skill text (MIL-270)", () => {
  const skill = read(SKILL_MD);
  const skillFlat = flat(SKILL_MD);

  it("has the skill frontmatter and copies the bundle's current em-version stamp", () => {
    expect(skill).toMatch(/^---\nname: event-modeling-engagement\nem-version: \d+\.\d+\.\d+\ndescription: >-\n/);
    const stamp = (p: string) => /^em-version: (.+)$/m.exec(read(p))![1];
    expect(stamp(SKILL_MD)).toBe(stamp(ROUTER_MD));
    expect(existsSync(REFERENCE_MD)).toBe(true);
  });

  it("names every `em engagement` subcommand", () => {
    for (const sub of ["new", "plan", "set", "status", "close"]) {
      expect(skill, sub).toContain(`em engagement ${sub} <model>.em <slug>`);
    }
  });

  it("walks the Ledger states in the rhythm's order, and names held and gap", () => {
    const order = ["building", "validating", "review", "awaiting-merge", "merged"].map((s) =>
      skill.indexOf(`--state ${s}`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(skill).toContain("--state gap");
    const ref = read(REFERENCE_MD);
    for (const s of ["planned", "building", "validating", "review", "awaiting-merge", "merged", "held", "gap"]) {
      expect(ref, s).toContain(`| \`${s}\` |`);
    }
  });

  it("cuts worktrees from the plan's base and dispatches with the key and path only", () => {
    expect(skill).toContain("git worktree add .claude/worktrees/<key> -b impl/<key> <base>");
    expect(skill).toContain("--state building --branch impl/<key> --base <base>");
    expect(skillFlat).toContain("**Never the current HEAD**");
    expect(skillFlat).toContain("Its prompt is ONLY the slice key and the absolute worktree path");
    for (const agent of ["em-implementer", "em-validator", "em-reviewer", "em-critic"]) {
      expect(skill, agent).toContain(`\`em:${agent}\``);
    }
  });

  it("states the preconditions, the one ceiling question, the retarget check and the end", () => {
    expect(skill).toContain("`- **Merge strategy:** merge-commits-when-stacked`");
    expect(skillFlat).toContain("implementer=sonnet, validator=sonnet, reviewer=sonnet, critic=opus");
    expect(skill).toContain('"Ceiling N from the plan; proceed?"');
    expect(skillFlat).toContain('**Never ask "which slice first"**');
    expect(skill).toContain("gh pr edit <n> --base main");
    expect(skill).toContain("em slice mark-implemented <model>.em <key> <pr-url>");
    expect(skill).toContain("em slice index <model>.em");
    expect(skill).toContain("em state log-usage <model>.em --phases engagement");
    expect(skillFlat).toContain("**Never show the critic the reviewer's findings.**");
    expect(read(REFERENCE_MD)).toContain("When the constitution names `critic=codex`, see MIL-271");
  });

  it("carries the Never-do rows", () => {
    for (const row of [
      "| Never hand-edit `engagements/<slug>.md` |",
      "| Never restack or rebase a slice branch |",
      "| Never squash a PR with an open dependent |",
      "| Never run the implementer's work yourself |",
      "| Never dispatch beyond the ceiling |",
    ]) {
      expect(skill, row).toContain(row);
    }
  });

  it("the router routes `engagement` to the new skill", () => {
    const router = read(ROUTER_MD);
    expect(router).toContain(
      "| `engagement` | `event-modeling-engagement` — build a planned set of ready slices through scoped sub-agents to a stack of PRs |",
    );
    expect(router).toContain("`conform`, `validate`, `watch`, `review`, `engagement`): look it up");
    expect(flat(ROUTER_MD)).toContain("to a stack of PRs (an `em engagement`), event-modeling-engagement.");
  });

  it("implement.md §8 rule 2 names the engagement base and rule 2a the merge-commit rule (R27), in the plugin copy too", () => {
    for (const p of [IMPLEMENT_MD, PLUGIN_IMPLEMENT_MD]) {
      const text = flat(p);
      expect(text, p).toContain(
        "cut the slice branch from the base the engagement plan names (`em engagement plan`); outside an engagement, from `main`",
      );
      expect(text, p).toContain(
        "2a. **While a dependent PR is open, the lower PR merges with a merge commit; squash is forbidden in that state (it strands the dependent's history).**",
      );
    }
  });

  it("no orchestration text leaks into the em-implementer definition", () => {
    const agent = read(IMPLEMENTER_AGENT);
    for (const s of ["worktree add", "em engagement", "gh pr edit", "awaiting-merge", "ceiling", "em-validator", "em-critic"]) {
      expect(agent, s).not.toContain(s);
    }
  });
});

describe("the new skill directory is part of the bundle (MIL-270)", () => {
  it("is a stamp-checked skill dir, so check:skill-version, em skill check/sync and the skill-bundle step cover it", () => {
    expect(EM_SKILL_DIR_NAMES).toContain("event-modeling-engagement");
    expect(EM_SKILL_DIR_NAMES).toHaveLength(7);
    expect(EM_ALL_SKILL_BUNDLE_DIRS).toContain("event-modeling-engagement");
  });

  it("em skill check flags a vendored bundle without it, and a bundle sync vendors it", () => {
    const vendored = mkdtempSync(join(tmpdir(), "em-engagement-vendored-"));
    try {
      for (const d of EM_ALL_SKILL_BUNDLE_DIRS) {
        if (d !== "event-modeling-engagement") cpSync(join(SKILLS, d), join(vendored, d), { recursive: true });
      }
      const version = /^em-version: (.+)$/m.exec(read(ROUTER_MD))![1];
      const before = checkSkillSyncBundle(SKILLS, vendored, version, EM_SKILL_DIR_NAMES, EM_SHARED_DIR_NAMES);
      expect(before.ok).toBe(false);
      expect(before.findings.map((f) => f.code)).toEqual(["skill-check-not-installed"]);
      expect(before.findings[0].message).toContain("event-modeling-engagement");

      const bundlePlan = planSkillSyncBundle(SKILLS, vendored, EM_ALL_SKILL_BUNDLE_DIRS);
      const changed = bundlePlan.flatMap((d) => d.plan.changes.map((c) => `${c.kind}: ${d.dirName}/${c.relPath}`));
      expect(changed.sort()).toEqual([
        "added: event-modeling-engagement/SKILL.md",
        "added: event-modeling-engagement/reference/engagement.md",
      ]);
      applySkillSyncBundle(bundlePlan, SKILLS, vendored);
      expect(checkSkillSyncBundle(SKILLS, vendored, version, EM_SKILL_DIR_NAMES, EM_SHARED_DIR_NAMES).ok).toBe(true);
    } finally {
      rmSync(vendored, { recursive: true, force: true });
    }
  });
});

// --- (b) scripted scenario, no agents ---------------------------------------------------------

const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function run(cmd: string, args: string[], cwd: string) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} (exit ${res.status}):\n${res.stderr}${res.stdout}`);
  return res.stdout;
}
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.email=lead@example.test", "-c", "user.name=Lead", ...args], cwd).trim();
const em = (cwd: string, ...args: string[]) => run(process.execPath, [TSX, CLI, ...args], cwd);

interface PlanSlice {
  key: string;
  level: number;
  branch: string;
  base: string | null;
  planHeld: string | null;
  held: string | null;
  state: string;
}
interface StatusSlice {
  key: string;
  state: string;
  branch: string | null;
  base: string | null;
  pr: string | null;
}

describe("scripted engagement scenario — the skill's commands by hand, no agents (MIL-270)", () => {
  const SLUG = "loans";
  const MODEL = "lending.em";
  const KEYS = [
    "reserve-tool",
    "cancel-reservation",
    "reservations",
    "overdue-loans-to-notify",
    "send-overdue-notice",
    "loan-history",
  ];
  let repo = "";
  const plan = (): { levels: Array<{ level: number; slices: string[] }>; slices: PlanSlice[] } =>
    JSON.parse(em(repo, "engagement", "plan", MODEL, SLUG, "--json"));
  const ledger = (): Map<string, StatusSlice> =>
    new Map(
      (JSON.parse(em(repo, "engagement", "status", MODEL, SLUG, "--json")).slices as StatusSlice[]).map((s) => [s.key, s]),
    );
  const set = (key: string, state: string, ...extra: string[]) =>
    em(repo, "engagement", "set", MODEL, SLUG, key, "--state", state, ...extra);
  const pr = (key: string) => `https://example.test/lending/pull/${KEYS.indexOf(key) + 1}`;

  /** Step 3 for one slice, exactly as the skill writes it: worktree from the plan's base, then the Ledger. */
  function cut(slice: PlanSlice): void {
    if (slice.held || slice.base === null) throw new Error(`skill never starts a held slice (${slice.key})`);
    git(repo, "worktree", "add", `.claude/worktrees/${slice.key}`, "-b", `impl/${slice.key}`, slice.base);
    set(slice.key, "building", "--branch", `impl/${slice.key}`, "--base", slice.base);
  }
  /** What an implementer leaves behind on its branch (no agent: one commit by hand). */
  function implementerCommit(key: string): void {
    git(join(repo, ".claude", "worktrees", key), "commit", "-q", "--allow-empty", "-m", `implement ${key}`);
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-engagement-skill-"));
    writeLendingFixture(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "model + ratified docs (foundation merged)");
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("step 1-2: `em engagement new` + `plan` give three levels, one stacked base and one hold", () => {
    em(repo, "engagement", "new", MODEL, SLUG, "--slices", KEYS.join(","), "--by", "Alex Rivera");
    const p = plan();
    expect(p.levels.map((l) => [l.level, [...l.slices].sort()])).toEqual([
      [0, ["cancel-reservation", "overdue-loans-to-notify", "reserve-tool"]],
      [1, ["reservations", "send-overdue-notice"]],
      [2, ["loan-history"]],
    ]);
    const byKey = new Map(p.slices.map((s) => [s.key, s]));
    expect(byKey.get("send-overdue-notice")!.base).toBe("impl/overdue-loans-to-notify");
    expect(byKey.get("reservations")!.planHeld).toBe("multiple-unmerged-upstreams");
    expect(byKey.get("reservations")!.base).toBeNull();
    expect(p.slices.every((s) => s.state === "planned")).toBe(true);
  });

  it("step 3, level 0: worktrees cut from the plan's base, Ledger at building", () => {
    const level0 = plan().slices.filter((s) => s.level === 0);
    expect(level0.length).toBeLessThanOrEqual(3); // within the ceiling
    for (const s of level0) cut(s);

    const mainTip = git(repo, "rev-parse", "main");
    const worktrees = git(repo, "worktree", "list", "--porcelain");
    const l = ledger();
    for (const s of level0) {
      expect(s.base).toBe("main");
      const path = resolve(repo, ".claude", "worktrees", s.key);
      expect(worktrees).toContain(`branch refs/heads/impl/${s.key}`);
      expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`impl/${s.key}`);
      expect(git(repo, "rev-parse", `impl/${s.key}`)).toBe(mainTip);
      expect(l.get(s.key)).toMatchObject({ state: "building", branch: `impl/${s.key}`, base: "main", pr: null });
    }
    for (const k of ["send-overdue-notice", "reservations", "loan-history"]) expect(l.get(k)!.state).toBe("planned");
  });

  it("steps 4-5: the upstream walks validating → review → awaiting-merge with its PR recorded", () => {
    const key = "overdue-loans-to-notify";
    implementerCommit(key);
    const seen: string[] = [ledger().get(key)!.state];
    set(key, "validating", "--pr", pr(key));
    seen.push(ledger().get(key)!.state);
    set(key, "review");
    seen.push(ledger().get(key)!.state);
    set(key, "awaiting-merge");
    const after = ledger().get(key)!;
    seen.push(after.state);
    expect(seen).toEqual(["building", "validating", "review", "awaiting-merge"]);
    expect(after).toMatchObject({ branch: `impl/${key}`, base: "main", pr: pr(key) });
  });

  it("step 3, level 1: the dependent is cut from impl/<upstream>, never from HEAD; the held slice is not cut", () => {
    const p = plan();
    const dep = p.slices.find((s) => s.key === "send-overdue-notice")!;
    expect(dep.base).toBe("impl/overdue-loans-to-notify");
    expect(p.slices.find((s) => s.key === "reservations")!.held).toBe("multiple-unmerged-upstreams");
    cut(dep);

    const upstreamTip = git(repo, "rev-parse", "impl/overdue-loans-to-notify");
    expect(upstreamTip).not.toBe(git(repo, "rev-parse", "HEAD")); // the lead's HEAD is main
    expect(git(repo, "rev-parse", "impl/send-overdue-notice")).toBe(upstreamTip);
    expect(ledger().get("send-overdue-notice")).toMatchObject({
      state: "building",
      branch: "impl/send-overdue-notice",
      base: "impl/overdue-loans-to-notify",
    });
    expect(existsSync(join(repo, ".claude", "worktrees", "reservations"))).toBe(false);
  });

  it("step 6: a merge releases the held dependent onto impl/<the other upstream>", () => {
    const key = "reserve-tool";
    implementerCommit(key);
    set(key, "validating", "--pr", pr(key));
    set(key, "review");
    set(key, "awaiting-merge");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #1 from impl/reserve-tool", `impl/${key}`);
    set(key, "merged");

    const res = plan().slices.find((s) => s.key === "reservations")!;
    expect(res.planHeld).toBeNull();
    expect(res.held).toBeNull();
    expect(res.base).toBe("impl/cancel-reservation");
    expect(ledger().get(key)!.state).toBe("merged");
  });

  it("step 6: after the upstream merges, the dependent's base moves to main and is recorded with its state kept", () => {
    const key = "overdue-loans-to-notify";
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #4 from impl/overdue-loans-to-notify", `impl/${key}`);
    set(key, "merged");
    expect(plan().slices.find((s) => s.key === "send-overdue-notice")!.base).toBe("main");
    set("send-overdue-notice", "building", "--base", "main");
    expect(ledger().get("send-overdue-notice")).toMatchObject({ state: "building", base: "main" });
  });

  it("step 7-8: gaps park the rest, and the engagement closes once every slice is merged or gap", () => {
    for (const k of ["cancel-reservation", "send-overdue-notice", "reservations", "loan-history"]) set(k, "gap");
    em(repo, "engagement", "close", MODEL, SLUG);
    const status = JSON.parse(em(repo, "engagement", "status", MODEL, SLUG, "--json"));
    expect(status.status).toBe("closed");
    expect((status.slices as StatusSlice[]).map((s) => [s.key, s.state])).toEqual([
      ["reserve-tool", "merged"],
      ["cancel-reservation", "gap"],
      ["overdue-loans-to-notify", "merged"],
      ["send-overdue-notice", "gap"],
      ["loan-history", "gap"],
      ["reservations", "gap"],
    ]);
  });
});
