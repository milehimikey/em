// SPDX-License-Identifier: MIT
// GH #412: a repo that serves several coding agents keeps skills in a neutral folder such as
// `.agents/skills/` (with `.claude/skills` a symlink to it). `em skill install|sync|check` take
// `--skills-dir` / `--agents-dir`, or detect `.agents/skills/` when `.claude/skills/` is absent,
// and the four sub-agent definitions follow to `.agents/agents/`. `em upgrade` reads the same place.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveVendoredDirs, EM_AGENT_FILES, EM_SKILL_ANCHOR_DIR } from "../src/cli/skillDirs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "em-skill-generic-"));
  dirs.push(d);
  return d;
}
function em(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, EM_CLAUDE_PLUGINS_DIR: join(cwd, "no-plugins") };
  delete env.CI;
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("resolveVendoredDirs (GH #412)", () => {
  const root = "/repo";
  it("defaults to .claude/skills and .claude/agents", () => {
    const d = resolveVendoredDirs(root, {}, () => false);
    expect(d).toEqual({ skillsRoot: "/repo/.claude/skills", agentsRoot: "/repo/.claude/agents", detected: false });
  });
  it("detects .agents/skills when .claude/skills is absent, and the agents dir follows", () => {
    const d = resolveVendoredDirs(root, {}, (p) => p === "/repo/.agents/skills");
    expect(d).toEqual({ skillsRoot: "/repo/.agents/skills", agentsRoot: "/repo/.agents/agents", detected: true });
  });
  it("prefers an existing .claude/skills over .agents/skills (a symlinked .claude/skills counts as existing)", () => {
    const d = resolveVendoredDirs(root, {}, () => true);
    expect(d.skillsRoot).toBe("/repo/.claude/skills");
    expect(d.detected).toBe(false);
  });
  it("--skills-dir wins over detection; --agents-dir wins over the follow-along default; absolute paths pass through", () => {
    const d = resolveVendoredDirs(root, { skillsDir: "tools/skills", agentsDir: "/elsewhere/agents" }, () => true);
    expect(d).toEqual({ skillsRoot: "/repo/tools/skills", agentsRoot: "/elsewhere/agents", detected: false });
    expect(resolveVendoredDirs(root, { skillsDir: ".agents/skills" }, () => false).agentsRoot).toBe("/repo/.agents/agents");
  });
});

// Each test below spawns several `em` runs under tsx; CI needs far more than vitest's 5s default.
describe("em skill install / check / sync with a generic skills dir (CLI, GH #412)", () => {
  it("--skills-dir/--agents-dir: install writes there, check reads there, nothing lands under .claude/", () => {
    const repo = tmp();
    const r = em(["skill", "install", "--no-agents-md", "--skills-dir", ".agents/skills", "--agents-dir", ".agents/agents"], repo);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".agents", "skills", EM_SKILL_ANCHOR_DIR, "SKILL.md"))).toBe(true);
    for (const f of EM_AGENT_FILES) expect(existsSync(join(repo, ".agents", "agents", f))).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);

    const c = em(["skill", "check", "--skills-dir", ".agents/skills", "--agents-dir", ".agents/agents"], repo);
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(/^ok — vendored skill matches em /);
    // Without the flags and with no .claude/skills/, detection finds the same bundle.
    const detected = em(["skill", "check"], repo);
    expect(detected.status).toBe(0);
    expect(detected.stdout).toMatch(/^ok — vendored skill matches em /);
    // And --json names the root that was checked.
    const j = JSON.parse(em(["skill", "check", "--json"], repo).stdout) as { vendoredDir: string };
    expect(realpathSync(j.vendoredDir)).toBe(realpathSync(join(repo, ".agents", "skills")));
  }, 60_000);

  it("detection: with .agents/skills/ present and no .claude/skills/, install and sync go there without a flag and say so", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    const r = em(["skill", "install", "--no-agents-md"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("using .agents/skills/ (no .claude/skills/ here; pass --skills-dir to choose)");
    expect(existsSync(join(repo, ".agents", "skills", EM_SKILL_ANCHOR_DIR, "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "agents", EM_AGENT_FILES[0]))).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);

    // Drift a file, sync without flags restores it in the detected location.
    const agent = join(repo, ".agents", "agents", EM_AGENT_FILES[0]);
    const original = readFileSync(agent, "utf8");
    writeFileSync(agent, original + "\nlocal edit\n");
    expect(em(["skill", "check"], repo).status).toBe(1);
    const s = em(["skill", "sync", "--no-agents-md"], repo);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain(`modified: agents/${EM_AGENT_FILES[0]}`);
    expect(readFileSync(agent, "utf8")).toBe(original);
    expect(em(["skill", "check"], repo).status).toBe(0);
  }, 60_000);

  it("the documented symlink setup: .claude/skills -> .agents/skills installs through the link, with agents still under .claude/agents by default", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    mkdirSync(join(repo, ".claude"), { recursive: true });
    symlinkSync(join("..", ".agents", "skills"), join(repo, ".claude", "skills"));
    const r = em(["skill", "install", "--no-agents-md"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("using .agents/skills/");
    expect(existsSync(join(repo, ".agents", "skills", EM_SKILL_ANCHOR_DIR, "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "agents", EM_AGENT_FILES[0]))).toBe(true);
    expect(em(["skill", "check"], repo).status).toBe(0);
  }, 60_000);
});
