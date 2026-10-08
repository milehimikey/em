// SPDX-License-Identifier: MIT
// MIL-269 (R28-R33): the four vendored Claude Code sub-agent definitions under .claude/agents/
// and how `em skill install|sync|check` and the upgrade steps carry them. The definitions are
// asserted structurally (Claude Code silently skips a malformed agent file, and an omitted `tools:`
// grants everything); the CLI cases spawn the real CLI, so the file gets a file-level timeout.
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EM_AGENT_FILES } from "../src/cli/skillDirs.js";
import { planAgentSync, applySkillSync } from "../src/cli/skillSync.js";
import { checkAgentFiles } from "../src/cli/skillCheck.js";

// Spawns the real CLI (~5-6 s per spawn on a cold CI runner): file-level timeout, as test/cli-state.test.ts.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(ROOT, ".claude", "agents");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function parseAgent(file: string): { fm: Record<string, string>; body: string } {
  const text = readFileSync(join(AGENTS_DIR, file), "utf8");
  expect(text.startsWith("---\n"), `${file}: frontmatter must start on line 1`).toBe(true);
  const end = text.indexOf("\n---\n", 4);
  expect(end, `${file}: frontmatter must close`).toBeGreaterThan(0);
  const fm: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: text.slice(end + 5) };
}
const tools = (file: string) => parseAgent(file).fm.tools.split(",").map((t) => t.trim());

describe("the four agent definitions", () => {
  it("the fixed list is exactly the four em-*.md files on disk", () => {
    expect([...EM_AGENT_FILES].sort()).toEqual(["em-critic.md", "em-implementer.md", "em-reviewer.md", "em-validator.md"]);
    expect(readdirSync(AGENTS_DIR).filter((f) => f.startsWith("em-")).sort()).toEqual([...EM_AGENT_FILES].sort());
  });

  it.each(EM_AGENT_FILES)("%s parses: name matches the file, description set, explicit tools, no model", (file) => {
    const { fm, body } = parseAgent(file);
    expect(fm.name).toBe(file.replace(/\.md$/, ""));
    expect(fm.description.length).toBeGreaterThan(20);
    expect(fm.tools, "omitting tools would grant every tool").toBeTruthy();
    expect(Object.keys(fm), "model is passed at dispatch, never fixed").not.toContain("model");
    expect(Object.keys(fm)).not.toContain("skills");
    expect(body).toContain("managed by em");
    expect(body).not.toMatch(/\b(opus|sonnet|haiku|gpt|codex)\b/i);
  });

  it("the implementer may write", () => {
    const t = tools("em-implementer.md");
    expect(t).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]));
    expect(t).not.toContain("Agent");
  });

  it.each(["em-validator.md", "em-reviewer.md", "em-critic.md"])("%s has no write tools", (file) => {
    const t = tools(file);
    for (const w of ["Write", "Edit", "NotebookEdit", "Agent"]) expect(t).not.toContain(w);
    expect(t).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
  });

  it("validator tools are exactly Read, Bash, Grep, Glob", () => {
    expect(tools("em-validator.md").sort()).toEqual(["Bash", "Glob", "Grep", "Read"]);
  });

  it("the implementer carries no orchestration text and names both skill forms", () => {
    const { body } = parseAgent("em-implementer.md");
    expect(body).toContain("`event-modeling-implement`");
    expect(body).toContain("`/em:implement`");
    expect(body).toMatch(/Never merge/);
    expect(body).toMatch(/Never rebase/);
    expect(body).not.toMatch(/em engagement|worktree add|gh pr merge|restack/i);
  });

  it("validator cites the R30 constitution line shape; reviewer and critic share the findings shape", () => {
    expect(parseAgent("em-validator.md").body).toContain("- **Test command:**");
    for (const f of ["em-reviewer.md", "em-critic.md"]) {
      expect(parseAgent(f).body).toContain("- [<severity>] <file:line or doc §> — <finding>");
    }
    expect(parseAgent("em-critic.md").body).toMatch(/different model/);
    expect(parseAgent("em-critic.md").body).toMatch(/must not be shown the reviewer's findings/);
  });
});

describe("planAgentSync / checkAgentFiles (R32, pure)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "em-agents-"));
    dirs.push(d);
    return d;
  };

  it("never reports, reads or removes a sibling agent", () => {
    const vendored = tmp();
    writeFileSync(join(vendored, "my-agent.md"), "mine\n");
    const plan = planAgentSync(AGENTS_DIR, vendored, EM_AGENT_FILES);
    expect(plan.changes.map((c) => c.kind)).toEqual(["added", "added", "added", "added"]);
    applySkillSync(plan, AGENTS_DIR, vendored);
    expect(readFileSync(join(vendored, "my-agent.md"), "utf8")).toBe("mine\n");
    expect(planAgentSync(AGENTS_DIR, vendored, EM_AGENT_FILES).changes).toEqual([]);
    expect(checkAgentFiles(AGENTS_DIR, vendored, EM_AGENT_FILES)).toEqual({ findings: [], ok: true });
  });

  it("flags a missing file as agent-not-installed and an edited one as agent-content-drift", () => {
    const vendored = tmp();
    applySkillSync(planAgentSync(AGENTS_DIR, vendored, EM_AGENT_FILES), AGENTS_DIR, vendored);
    rmSync(join(vendored, "em-critic.md"));
    writeFileSync(join(vendored, "em-validator.md"), "edited\n");
    const r = checkAgentFiles(AGENTS_DIR, vendored, EM_AGENT_FILES);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code).sort()).toEqual(["agent-content-drift", "agent-not-installed"]);
    expect(r.findings.find((f) => f.code === "agent-content-drift")!.message).toMatch(/^\[agents\] em-validator\.md: content drift/);
    expect(r.findings.find((f) => f.code === "agent-not-installed")!.message).toMatch(/^\[agents\] em-critic\.md: not installed/);
  });
});

describe("em skill install | sync | check carry the agents (CLI, real fs)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function em(args: string[], cwd: string) {
    const env = { ...process.env };
    delete env.CI;
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "em-agents-cli-"));
    dirs.push(d);
    expect(em(["scaffold", "Order Fulfillment"], d).status).toBe(0);
    return join(d, "order-fulfillment");
  }

  it("fresh scaffold + install writes the four files and creates .claude/agents/; check is clean", () => {
    const dir = repo();
    expect(existsSync(join(dir, ".claude", "agents"))).toBe(false);
    const r = em(["skill", "install", "--no-agents-md"], dir);
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, ".claude", "agents")).sort()).toEqual([...EM_AGENT_FILES].sort());
    const c = em(["skill", "check", "."], dir);
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(/^ok — vendored skill matches em /);
  });

  it("check flags a stale or edited copy (text and --json), sync restores byte-exact, siblings untouched", () => {
    const dir = repo();
    em(["skill", "install", "--no-agents-md"], dir);
    const agents = join(dir, ".claude", "agents");
    const sibling = join(agents, "my-agent.md");
    writeFileSync(sibling, "hand-written\n");
    writeFileSync(join(agents, "em-validator.md"), "edited\n");
    rmSync(join(agents, "em-critic.md"));

    const c = em(["skill", "check", "."], dir);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain("[agents] em-validator.md: content drift");
    expect(c.stdout).toContain("[agents] em-critic.md: not installed");
    expect(c.stdout).not.toContain("my-agent");
    const j = JSON.parse(em(["skill", "check", ".", "--json"], dir).stdout);
    expect(j.skillCheckSchemaVersion).toBe("1.1");
    expect(j.findings.map((f: { code: string }) => f.code).sort()).toEqual(["agent-content-drift", "agent-not-installed"]);

    const s = em(["skill", "sync", ".", "--no-agents-md"], dir);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain("modified: agents/em-validator.md");
    expect(s.stdout).toContain("added: agents/em-critic.md");
    for (const f of EM_AGENT_FILES) expect(readFileSync(join(agents, f), "utf8")).toBe(readFileSync(join(AGENTS_DIR, f), "utf8"));
    expect(readFileSync(sibling, "utf8")).toBe("hand-written\n");
    expect(em(["skill", "check", "."], dir).status).toBe(0);
  });

  it("install --force restores an edited agent too", () => {
    const dir = repo();
    em(["skill", "install", "--no-agents-md"], dir);
    writeFileSync(join(dir, ".claude", "agents", "em-reviewer.md"), "edited\n");
    expect(em(["skill", "install", "--force", "--no-agents-md"], dir).status).toBe(0);
    expect(readFileSync(join(dir, ".claude", "agents", "em-reviewer.md"), "utf8")).toBe(readFileSync(join(AGENTS_DIR, "em-reviewer.md"), "utf8"));
  });
});
