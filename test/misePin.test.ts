// SPDX-License-Identifier: MIT
// GH #298: the mise.toml em pin reader/rewriter (src/cli/misePin.ts), the `mise-pin-mismatch`
// finding, and `em skill check` end to end.
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMisePin, detectMisePin, findMiseEmPin, pluginPinVersion, rewriteMiseEmPin } from "../src/cli/misePin.js";
import { buildSkillCheckJson, SKILL_CHECK_SCHEMA_VERSION } from "../src/emit/skillCheckJson.js";

vi.setConfig({ testTimeout: 20_000 });

const STRING_SHAPE = `# tools\n[tools]\nnode = "22"\n"npm:@milehimikey/em" = "1.14.1" # the em pin\njava = "21"\n`;
const INLINE_SHAPE = `[tools]\n"npm:@milehimikey/em" = { version = "1.14.1", postinstall = "x" }\n`;
const TABLE_SHAPE = `[tools]\nnode = "22"\n\n[tools."npm:@milehimikey/em"]\n# keep\nversion = '1.14.1'\n\n[env]\nFOO = "1"\n`;

describe("findMiseEmPin / rewriteMiseEmPin", () => {
  for (const [name, text] of [["string", STRING_SHAPE], ["inline table", INLINE_SHAPE], ["tools table", TABLE_SHAPE]] as const) {
    it(`reads and rewrites the ${name} shape, touching only the value`, () => {
      expect(findMiseEmPin(text)?.version).toBe("1.14.1");
      expect(rewriteMiseEmPin(text, "1.23.0")).toBe(text.replace("1.14.1", "1.23.0"));
    });
    it(`preserves CRLF line endings in the ${name} shape`, () => {
      const crlf = text.replace(/\n/g, "\r\n");
      expect(findMiseEmPin(crlf)?.version).toBe("1.14.1");
      expect(rewriteMiseEmPin(crlf, "1.23.0")).toBe(crlf.replace("1.14.1", "1.23.0"));
    });
  }

  it("reads a top-level dotted key", () => {
    expect(findMiseEmPin(`tools."npm:@milehimikey/em" = "1.2.3"\n`)?.version).toBe("1.2.3");
  });

  it("ignores a commented-out pin, other packages, other tables and a different em-like key", () => {
    expect(findMiseEmPin(`[tools]\n# "npm:@milehimikey/em" = "1.0.0"\n"npm:@milehimikey/em-portal" = "0.4.0"\n`)).toBeNull();
    expect(findMiseEmPin(`[env]\n"npm:@milehimikey/em" = "1.0.0"\n`)).toBeNull();
    expect(findMiseEmPin(`[tools]\nnode = "22"\n`)).toBeNull();
    expect(findMiseEmPin("")).toBeNull();
  });

  it("tolerates arrays, [[tables]], and unparseable lines without throwing", () => {
    const text = `[[hooks]]\nrun = "x"\n[tools]\nnode = ["22", "20"]\nweird = = =\n"npm:@milehimikey/em" = "1.14.1"\n`;
    expect(findMiseEmPin(text)?.version).toBe("1.14.1");
  });

  it("treats an unsupported value shape as not declared", () => {
    expect(findMiseEmPin(`[tools]\n"npm:@milehimikey/em" = ["1.14.1"]\n`)).toBeNull();
    expect(rewriteMiseEmPin(`[tools]\nnode = "22"\n`, "1.0.0")).toBeNull();
  });
});

describe("detectMisePin / checkMisePin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "em-misepin-"));
    dirs.push(d);
    return d;
  }

  it("walks up to the nearest declaring file and honours .mise.toml", () => {
    const root = tmp();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, ".mise.toml"), STRING_SHAPE);
    const pin = detectMisePin(join(root, "a", "b"));
    expect(pin?.version).toBe("1.14.1");
    expect(pin?.file).toBe(join(root, ".mise.toml"));
    expect(detectMisePin(join(root, "a", "b"), join(root, "a"))).toBeNull();
  });

  it("returns null from checkMisePin when no mise config declares the pin", () => {
    const root = tmp();
    writeFileSync(join(root, "mise.toml"), `[tools]\nnode = "22"\n`);
    expect(checkMisePin(root, "1.23.0", null)).toBeNull();
  });

  it("agrees with the installed em when no plugin is declared, flags a mismatch with the fix line", () => {
    const root = tmp();
    writeFileSync(join(root, "mise.toml"), STRING_SHAPE);
    expect(checkMisePin(root, "1.14.1", null)?.finding).toBeNull();
    const f = checkMisePin(root, "1.23.0", null)!.finding!;
    expect(f.code).toBe("mise-pin-mismatch");
    expect(f.misePin).toBe("1.14.1");
    expect(f.miseFile).toBe("mise.toml");
    expect(f.installCommands).toEqual(["mise use npm:@milehimikey/em@1.23.0"]);
    expect(f.message).toContain("mise use npm:@milehimikey/em@1.23.0");
  });

  it("compares against the plugin pin when the plugin is declared", () => {
    const root = tmp();
    writeFileSync(join(root, "mise.toml"), STRING_SHAPE);
    const plugin = { declared: true as const, name: "em-1-14-1", ref: "v1.14.1", enabled: true };
    expect(pluginPinVersion(plugin)).toBe("1.14.1");
    expect(checkMisePin(root, "1.23.0", plugin)?.finding).toBeNull();
    const other = { ...plugin, name: "em-1-15-0", ref: "v1.15.0" };
    expect(checkMisePin(root, "1.23.0", other)?.finding?.message).toContain("mise use npm:@milehimikey/em@1.15.0");
    expect(pluginPinVersion({ ...plugin, ref: null })).toBe("1.14.1");
  });

  it("serialises the new finding fields in schema 1.2, null when unused", () => {
    expect(SKILL_CHECK_SCHEMA_VERSION).toBe("1.2");
    const root = tmp();
    writeFileSync(join(root, "mise.toml"), STRING_SHAPE);
    const f = checkMisePin(root, "1.23.0", null)!.finding!;
    const doc = JSON.parse(buildSkillCheckJson({ findings: [f, { code: "agent-content-drift", message: "m" }], ok: false }, "d", "1.23.0"));
    expect(doc.skillCheckSchemaVersion).toBe("1.2");
    expect(doc.findings[0].misePin).toBe("1.14.1");
    expect(doc.findings[0].miseFile).toBe("mise.toml");
    expect(doc.findings[1].misePin).toBeNull();
    expect(doc.findings[1].miseFile).toBeNull();
  });
});

describe("em skill check with a mise pin (CLI)", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const CLI = join(ROOT, "src", "cli.ts");
  const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const NAME = `em-${VERSION.replace(/\./g, "-")}`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(misePin: string | null): string {
    const d = mkdtempSync(join(tmpdir(), "em-misepin-cli-"));
    dirs.push(d);
    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(
      join(d, ".claude", "settings.json"),
      JSON.stringify({
        extraKnownMarketplaces: { [NAME]: { source: { source: "github", repo: "milehimikey/em", ref: `v${VERSION}` } } },
        enabledPlugins: { [`em@${NAME}`]: true },
      }),
    );
    if (misePin !== null) writeFileSync(join(d, "mise.toml"), `[tools]\n"npm:@milehimikey/em" = "${misePin}"\n`);
    return d;
  }

  function em(args: string[], cwd: string) {
    const plugins = mkdtempSync(join(tmpdir(), "em-misepin-reg-"));
    dirs.push(plugins);
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ [NAME]: { source: { source: "github", repo: "milehimikey/em", ref: `v${VERSION}` } } }));
    const env: NodeJS.ProcessEnv = { ...process.env, EM_CLAUDE_PLUGINS_DIR: plugins };
    delete env.CI;
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("is green when the mise pin agrees with the plugin pin", () => {
    const r = em(["skill", "check"], repo(VERSION));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`ok — mise pin (${VERSION}) matches`);
  });

  it("is red on a disagreeing mise pin, printing the fix line", () => {
    const r = em(["skill", "check"], repo("0.0.1"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`mise use npm:@milehimikey/em@${VERSION}`);
    expect(r.stdout).toContain("1 mismatch(es)");
  });

  it("reports the finding in --json (schema 1.2) and exits 1", () => {
    const r = em(["skill", "check", "--json"], repo("0.0.1"));
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.skillCheckSchemaVersion).toBe("1.2");
    expect(doc.findings.map((f: { code: string }) => f.code)).toEqual(["mise-pin-mismatch"]);
    expect(doc.findings[0].misePin).toBe("0.0.1");
  });

  it("is unchanged without a mise.toml", () => {
    const r = em(["skill", "check"], repo(null));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`ok — em plugin ${NAME} (v${VERSION}) matches em ${VERSION}\n`);
  });
});
