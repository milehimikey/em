// SPDX-License-Identifier: MIT
// GH #528: the repo resolver (src/system/repoResolver.ts) — `--repo` values, the per-machine
// `.em/repos.local.yaml`, the sibling fallback — and `em repos check`, against real throwaway
// git repositories.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { findRepoRoot, normalizeRemote, parseRepoArgs, parseReposLocal, resolveRepos } from "../src/system/repoResolver.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });

describe("parseRepoArgs", () => {
  const none = () => false;
  it("splits <id>=<path> pairs from one bare path", () => {
    const r = parseRepoArgs(["web=../web", "checkout-svc=/abs/co=1", "../code"], none);
    expect(r).toEqual({ ok: true, byId: new Map([["web", "../web"], ["checkout-svc", "/abs/co=1"]]), bare: "../code" });
  });
  it("a value that is an existing path is bare even with = in it; so is one whose prefix is not a repo id", () => {
    expect(parseRepoArgs(["a=b"], (p) => p === "a=b")).toEqual({ ok: true, byId: new Map(), bare: "a=b" });
    expect(parseRepoArgs(["../x=y"], none)).toEqual({ ok: true, byId: new Map(), bare: "../x=y" });
  });
  it.each([
    [["web="], "give a path after `web=`"],
    [["self=../x"], "`self` is the model's own repository"],
    [["web=a", "web=b"], 'repo "web" is given twice'],
    [["a", "b"], "only one bare path is allowed"],
  ])("refuses %j", (values, message) => {
    const r = parseRepoArgs(values, none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(message);
  });
});

describe("parseReposLocal", () => {
  it("reads repos: id -> path, with or without the version key; an empty file maps nothing", () => {
    expect(parseReposLocal(`reposLocalSchemaVersion: "1.0"\nrepos:\n  web: ../web\n  co: ~/src/co\n`)).toEqual({ ok: true, paths: new Map([["web", "../web"], ["co", "~/src/co"]]) });
    expect(parseReposLocal(`repos:\n  web: /abs/web\n`)).toEqual({ ok: true, paths: new Map([["web", "/abs/web"]]) });
    expect(parseReposLocal(`repos:\n`)).toEqual({ ok: true, paths: new Map() });
  });
  it.each([
    [`repos:\n  web: ../web\npaths: {}\n`, 'unknown key "paths"'],
    [`reposLocalSchemaVersion: "2.0"\nrepos: {}\n`, "unsupported reposLocalSchemaVersion"],
    [`repos: [web]\n`, "`repos` must be a mapping"],
    [`repos:\n  self: ../x\n`, "`self` is the model's own repository"],
    [`repos:\n  web: {path: ../web}\n`, 'repo "web": the path must be a non-empty string'],
    [`repos:\n  "bad id": ../x\n`, '"bad id" is not a repo id'],
    [`- a\n`, "must be a YAML mapping"],
  ])("refuses %j", (text, message) => {
    const r = parseReposLocal(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toContain(message);
  });
});

describe("normalizeRemote", () => {
  it("reads scp, ssh and https forms of one repository as equal", () => {
    const forms = ["git@github.com:Acme/Web.git", "ssh://git@github.com/acme/web", "https://github.com/acme/web.git/", "https://token@github.com/acme/web", "ssh://git@github.com:22/acme/web.git"];
    expect(new Set(forms.map(normalizeRemote))).toEqual(new Set(["github.com/acme/web"]));
    expect(normalizeRemote("git@github.com:acme/other.git")).toBe("github.com/acme/other");
    expect(normalizeRemote("github.com:acme/web.git")).toBe("github.com/acme/web"); // scp form with no user
  });
});

describe("resolveRepos and em repos check (real git repos)", () => {
  // <base>/model (the model repo), <base>/web (sibling, matching origin), <base>/elsewhere/co
  // (mapped by the per-machine file, origin differs), <base>/plain (a directory, no .git).
  let base: string;
  let modelRepo: string;
  const SYSTEM = `systemSchemaVersion: "2.1"\nrepos:\n  web: {remote: "git@github.com:acme/web.git"}\n  co: {remote: "git@github.com:acme/co.git"}\n  pay: {remote: "git@github.com:acme/pay.git"}\n  plain: {remote: "git@github.com:acme/plain.git"}\nmodels:\n  shop: {source: models/shop/shop.em}\n`;
  const declared = [
    { id: "web", remote: "git@github.com:acme/web.git" },
    { id: "co", remote: "git@github.com:acme/co.git" },
    { id: "pay", remote: "git@github.com:acme/pay.git" },
    { id: "plain", remote: "git@github.com:acme/plain.git" },
  ];

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "em-repos-")));
    modelRepo = join(base, "model");
    for (const [dir, origin] of [["model", null], ["web", "https://github.com/acme/web.git"], ["elsewhere/co", "git@github.com:acme/something-else.git"]] as const) {
      mkdirSync(join(base, dir), { recursive: true });
      gitInitQuiet(join(base, dir), "-b", "main");
      if (origin) git(["remote", "add", "origin", origin], join(base, dir));
    }
    mkdirSync(join(base, "plain"));
    mkdirSync(join(modelRepo, "models", "shop"), { recursive: true });
    writeFileSync(join(modelRepo, "models", "shop", "shop.em"), 'slice "A" {\n  ui Screen @User\n  command Do It\n  event It Done\n}\n');
    writeFileSync(join(modelRepo, "system.yaml"), SYSTEM);
    mkdirSync(join(modelRepo, ".em"));
    writeFileSync(join(modelRepo, ".em", "repos.local.yaml"), `repos:\n  co: ../elsewhere/co\n`);
  });
  afterAll(() => rmTemp(base));

  it("resolves self, a sibling, a per-machine mapping; reports a missing repo and a non-git directory", () => {
    const r = resolveRepos({ startDir: join(modelRepo, "models", "shop"), repos: declared });
    expect(r.modelRepoRoot).toBe(modelRepo);
    expect(r.localFile).toBe(join(modelRepo, ".em", "repos.local.yaml"));
    expect(r.localFileProblems).toEqual([]);
    expect(r.resolutions).toEqual([
      { id: "self", remote: null, status: "resolved", path: modelRepo, source: "self", remoteMatches: null, actualRemote: null },
      { id: "web", remote: "git@github.com:acme/web.git", status: "resolved", path: join(base, "web"), source: "sibling", remoteMatches: true, actualRemote: null },
      { id: "co", remote: "git@github.com:acme/co.git", status: "resolved", path: join(base, "elsewhere", "co"), source: "local-file", remoteMatches: false, actualRemote: "git@github.com:acme/something-else.git" },
      { id: "pay", remote: "git@github.com:acme/pay.git", status: "missing", path: join(base, "pay"), source: "sibling", remoteMatches: null, actualRemote: null },
      { id: "plain", remote: "git@github.com:acme/plain.git", status: "not-a-git-repo", path: join(base, "plain"), source: "sibling", remoteMatches: null, actualRemote: null },
    ]);
  });

  it("--repo wins over the per-machine file, which wins over the sibling; flag paths are relative to cwd", () => {
    const r = resolveRepos({
      startDir: modelRepo,
      repos: declared,
      flagPaths: new Map([["co", "../web"], ["pay", "elsewhere/co"]]),
      cwd: base,
    });
    const byId = new Map(r.resolutions.map((x) => [x.id, x]));
    expect(byId.get("co")).toMatchObject({ status: "missing", path: join(dirname(base), "web"), source: "flag" });
    expect(byId.get("pay")).toMatchObject({ status: "resolved", path: join(base, "elsewhere", "co"), source: "flag" });
    expect(byId.get("web")).toMatchObject({ source: "sibling" });
  });

  it("a malformed per-machine file is reported and not used", () => {
    const other = join(base, "other-model");
    mkdirSync(join(other, ".em"), { recursive: true });
    gitInitQuiet(other, "-b", "main");
    writeFileSync(join(other, ".em", "repos.local.yaml"), `repos: [web]\n`);
    const r = resolveRepos({ startDir: other, repos: [{ id: "web", remote: null }] });
    expect(r.localFileProblems.join("\n")).toContain("`repos` must be a mapping");
    expect(r.resolutions[1]).toMatchObject({ id: "web", status: "resolved", source: "sibling", remoteMatches: null });
  });

  it("outside git: self is not a git repo and nothing can be found beside it", () => {
    const loose = mkdtempSync(join(tmpdir(), "em-repos-loose-"));
    try {
      const top = findRepoRoot(loose);
      if (top !== null) return; // the temp dir itself sits inside a git work tree on this machine
      const r = resolveRepos({ startDir: loose, repos: [{ id: "web", remote: null }] });
      expect(r.resolutions).toEqual([
        { id: "self", remote: null, status: "not-a-git-repo", path: loose, source: "self", remoteMatches: null, actualRemote: null },
        { id: "web", remote: null, status: "missing", path: null, source: null, remoteMatches: null, actualRemote: null },
      ]);
    } finally {
      rmTemp(loose);
    }
  });

  it("em repos check: text report from a model file, advisory exit 0, --exit-code exits 1", () => {
    const r = em(["repos", "check", "models/shop/shop.em"], modelRepo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`manifest: ${join(modelRepo, "system.yaml")}`);
    expect(r.stdout).toMatch(/self\s+resolved\s+.*\(the model's own repository\)/);
    expect(r.stdout).toMatch(/web\s+resolved\s+.*\(sibling directory\)/);
    expect(r.stdout).toMatch(/co\s+resolved\s+.*\(\.em\/repos\.local\.yaml\)/);
    expect(r.stdout).toContain("warning: origin is git@github.com:acme/something-else.git, the manifest records git@github.com:acme/co.git");
    expect(r.stdout).toMatch(/pay\s+missing/);
    expect(r.stdout).toContain("em does not clone");
    expect(r.stdout).toMatch(/plain\s+not a git repo/);
    expect(r.stdout).toContain("warning: .em/repos.local.yaml is not gitignored");
    expect(r.stdout).toContain("3 of 5 repos resolved, 2 not");
    expect(em(["repos", "check", "models/shop/shop.em", "--exit-code"], modelRepo).status).toBe(1);
  });

  it("em repos check --json: the same facts, and --repo makes every repo resolve", () => {
    writeFileSync(join(modelRepo, ".gitignore"), ".em/*.local.yaml\n");
    const r = em(["repos", "check", "--json", "--exit-code", "--repo", `pay=${join(base, "web")}`, "--repo", "plain=../web"], modelRepo);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.reposCheckSchemaVersion).toBe("1.0");
    expect(doc.ok).toBe(true);
    expect(doc.localFileIgnored).toBe(true);
    expect(doc.summary).toEqual({ total: 5, resolved: 5, missing: 0, notAGitRepo: 0 });
    expect(doc.repos.map((x: { id: string; source: string }) => `${x.id}:${x.source}`)).toEqual(["self:self", "web:sibling", "co:local-file", "pay:flag", "plain:flag"]);
    expect(doc.repos[3]).toMatchObject({ path: join(base, "web"), remoteMatches: false });
  });

  it("em repos check: refuses a bare path with several repos, an undeclared id, and reads an explicit manifest", () => {
    const bare = em(["repos", "check", "--repo", "../web"], modelRepo);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("4 repos are declared, so a bare path is ambiguous");
    const unknown = em(["repos", "check", "--repo", "nope=../web"], modelRepo);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no repo "nope" is declared');
    const explicit = em(["repos", "check", "system.yaml", "--json"], modelRepo);
    expect(JSON.parse(explicit.stdout).repos).toHaveLength(5);
  });

  it("em repos check: with one declared repo a bare --repo names it; with no manifest only self exists", () => {
    const one = join(base, "one");
    mkdirSync(one);
    gitInitQuiet(one, "-b", "main");
    writeFileSync(join(one, "system.yaml"), `systemSchemaVersion: "2.1"\nrepos:\n  code: {remote: "git@github.com:acme/code.git"}\nmodels:\n  m: {source: m.em}\n`);
    const r = em(["repos", "check", "--json", "--repo", "../web"], one);
    expect(JSON.parse(r.stdout).repos[1]).toMatchObject({ id: "code", status: "resolved", source: "flag", remoteMatches: false });
    const none = em(["repos", "check"], join(base, "web"));
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("no system.yaml governs this directory");
    expect(none.stdout).toContain("1 of 1 repos resolved");
  });
});
