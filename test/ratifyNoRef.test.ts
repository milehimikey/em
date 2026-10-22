// SPDX-License-Identifier: MIT
// GH #255: `em slice ratify --no-ref` — hash-only ratification inside a git work tree, for a repo
// whose squash/rebase merges would leave `ratifiedRef` (and the `shippedRef` mark-implemented
// copies from it) pointing at a commit no longer reachable from the target branch. Runs the real
// binary (spawnSync + tsx) in a real git repository, because the thing under test is precisely
// what ratify does and does not ask git.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sliceDocBodyHash } from "../src/catalog/sliceDoc.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const REVIEWED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";

describe("em slice ratify --no-ref (GH #255, CLI, real git)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const read = () => readFileSync(docPath(), "utf8");
  const ratify = (...extra: string[]) => em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02", ...extra], dir);
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh255-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(docPath(), REVIEWED + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed");
  });
  afterEach(() => rmTemp(dir));

  it("without the flag, an uncommitted doc is refused; with --no-ref it ratifies with the hash only and git is not consulted", () => {
    writeFileSync(docPath(), read().replace("Charge the customer.", "Charge the customer, once."));
    const refused = ratify();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("has uncommitted changes");
    const r = ratify("--no-ref");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ratified: slices/pay.md (ratifiedBy: Alex, ratifiedOn: 2026-10-02) — ratifiedHash only, no ratifiedRef (--no-ref)\n");
    const doc = read();
    expect(doc).toContain(`status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(doc)}\n`);
    expect(doc).not.toContain("ratifiedRef:");
    expect(ready().status).toBe(0);
    // Same-sign-off re-run: still the no-op, still no ref.
    expect(ratify("--no-ref")).toMatchObject({ status: 0, stdout: "already ratified (no-op): slices/pay.md\n" });
    expect(read()).not.toContain("ratifiedRef:");
  });

  it("mark-implemented on a --no-ref doc writes shippedVersion/shippedOn and no shippedRef; export shows ratifiedRef null", () => {
    expect(ratify("--no-ref").status).toBe(0);
    const m = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"], dir);
    expect(m.status).toBe(0);
    const doc = read();
    expect(doc).toContain("shippedVersion: 1\nshippedOn: 2026-10-13\n");
    expect(doc).not.toContain("shippedRef:");
    expect(doc).not.toContain("ratifiedRef:");
    const exported = JSON.parse(em(["export", "model.em", "--slice", "pay"], dir).stdout).slice.doc;
    expect(exported.ratifiedRef).toBeNull();
    expect(exported.ratifiedHash).toBe(sliceDocBodyHash(doc));
    expect(exported.shipped).toMatchObject({ version: 1, ratifiedRef: null, implementedIn: "https://github.com/org/repo/pull/7" });
  });

  it("--no-ref removes a ratifiedRef line left on the doc, rather than carrying the stale pointer forward", () => {
    writeFileSync(docPath(), read().replace("status: reviewed\n", "status: reviewed\nratifiedRef: 0000000000000000000000000000000000000000\n"));
    git(dir, "commit", "-qam", "stale ref");
    expect(ratify("--no-ref").status).toBe(0);
    const doc = read();
    expect(doc).not.toContain("ratifiedRef:");
    expect(doc).toContain(`ratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(doc)}\n`);
  });

  it("the default (no flag) on a committed doc still records HEAD as ratifiedRef — unchanged", () => {
    expect(ratify().status).toBe(0);
    expect(read()).toContain(`ratifiedRef: ${git(dir, "rev-parse", "HEAD")}\n`);
  });
});
