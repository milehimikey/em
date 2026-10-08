// SPDX-License-Identifier: MIT
// MIL-230 / R18: the `em` Claude Code plugin under plugin/ (and .claude-plugin/marketplace.json)
// is GENERATED from .claude/skills/ by scripts/build-plugin.ts. This parity test is the CI gate:
// the committed tree must equal a fresh build byte-for-byte, and the built skills must be
// self-consistent (no vendored-layout paths, every plugin-root reference resolves, examples parse).
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import {
  applyRewrites,
  buildPlugin,
  marketplaceNameFor,
  MARKETPLACE_PATH,
  packageVersion,
  PLUGIN_DIR,
  REWRITE_RULES,
} from "../scripts/build-plugin.js";

const ROOT = resolve(__dirname, "..");
const version = packageVersion();
const built = buildPlugin(version);

function listTree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTree(p));
    else out.push(p);
  }
  return out;
}

const BANNER_LINE = /^<!-- GENERATED FILE from .* by scripts\/build-plugin\.ts .*-->$/;
function stripBanner(content: string): string {
  return content
    .split("\n")
    .filter((l) => !BANNER_LINE.test(l))
    .join("\n");
}

describe("plugin build parity (MIL-230, R18)", () => {
  it("the committed plugin/ tree and marketplace.json equal a fresh build, byte for byte", () => {
    const committed = new Map<string, string>();
    for (const abs of listTree(join(ROOT, PLUGIN_DIR))) {
      committed.set(abs.slice(ROOT.length + 1).split("\\").join("/"), readFileSync(abs, "utf8"));
    }
    committed.set(MARKETPLACE_PATH, readFileSync(join(ROOT, MARKETPLACE_PATH), "utf8"));
    expect([...committed.keys()].sort()).toEqual([...built.keys()].sort());
    for (const [rel, content] of built) expect(committed.get(rel), rel).toBe(content);
  });

  it("builds the expected skill set", () => {
    const skills = [...built.keys()]
      .filter((k) => k.endsWith("/SKILL.md"))
      .map((k) => k.split("/")[2])
      .sort();
    expect(skills).toEqual(["conform", "design", "discover", "event-modeling", "implement", "review"]);
  });

  it("every skill's frontmatter name is its short name and the em-version stamp is kept", () => {
    for (const [rel, content] of built) {
      if (!rel.endsWith("/SKILL.md")) continue;
      const short = rel.split("/")[2];
      expect(content, rel).toMatch(new RegExp(`^---\\nname: ${short}\\nem-version: \\d+\\.\\d+\\.\\d+\\n`));
    }
  });

  it("every generated markdown file carries the banner (after any frontmatter)", () => {
    for (const [rel, content] of built) {
      if (!rel.endsWith(".md")) continue;
      const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(body.split("\n")[0], rel).toMatch(BANNER_LINE);
    }
  });

  it("no vendored-layout path survives in plugin/skills/** (banner lines excluded)", () => {
    for (const [rel, content] of built) {
      if (!rel.startsWith(`${PLUGIN_DIR}/skills/`)) continue;
      const body = stripBanner(content);
      expect(body, rel).not.toContain("event-modeling-shared");
      expect(body, rel).not.toContain(".claude/skills");
      if (rel.includes("/reference/")) {
        expect(body, rel).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      } else {
        expect(body, rel).not.toMatch(/\.\.\//);
      }
      expect(body, rel).not.toMatch(/event-modeling-(discover|design|implement|conform|review)\b/);
      expect(body, rel).not.toMatch(/(?<![\w./-])\/event-modeling(?![\w-])/);
    }
  });

  it("every ${CLAUDE_PLUGIN_ROOT}/ target in the built skills exists in the built tree", () => {
    let seen = 0;
    for (const [rel, content] of built) {
      if (!rel.startsWith(`${PLUGIN_DIR}/skills/`)) continue;
      for (const m of content.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./*-]+)/g)) {
        const target = m[1].replace(/[.,]+$/, "");
        seen++;
        if (target.includes("*")) {
          const dir = target.slice(0, target.lastIndexOf("/"));
          const hits = [...built.keys()].filter((k) => k.startsWith(`${PLUGIN_DIR}/${dir}/`));
          expect(hits.length, `${rel}: ${m[0]}`).toBeGreaterThan(0);
        } else {
          expect(built.has(`${PLUGIN_DIR}/${target}`), `${rel}: ${m[0]}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("every ../ target in plugin/skills/*/reference files exists in the built tree", () => {
    let seen = 0;
    for (const [rel, content] of built) {
      if (!/^plugin\/skills\/[^/]+\/reference\//.test(rel)) continue;
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      for (const m of stripBanner(content).matchAll(/(\.\.\/[A-Za-z0-9_./-]+?\.md)/g)) {
        const stack: string[] = [];
        for (const p of `${dir}/${m[1]}`.split("/")) {
          if (p === "..") stack.pop();
          else if (p && p !== ".") stack.push(p);
        }
        seen++;
        expect(built.has(stack.join("/")), `${rel}: ${m[1]}`).toBe(true);
        // and the real path check against disk once generated
        expect(existsSync(join(ROOT, stack.join("/"))), `${rel}: ${m[1]} on disk`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("relative links inside plugin/shared resolve within the built tree", () => {
    for (const [rel, content] of built) {
      if (!rel.startsWith(`${PLUGIN_DIR}/shared/`)) continue;
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      for (const m of content.matchAll(/\]\((\.\.?\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
        const parts = `${dir}/${m[1]}`.split("/");
        const stack: string[] = [];
        for (const p of parts) {
          if (p === "." || p === "") continue;
          if (p === "..") stack.pop();
          else stack.push(p);
        }
        const target = stack.join("/");
        // diagram placeholder inside the slice template is not a real file
        if (target.endsWith("{{slice-name}}.svg")) continue;
        expect(built.has(target), `${rel}: ${m[0]} -> ${target}`).toBe(true);
      }
    }
  });

  it("marketplace name and plugin.json version follow package.json", () => {
    const plugin = JSON.parse(built.get(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)!);
    const market = JSON.parse(built.get(MARKETPLACE_PATH)!);
    expect(plugin.version).toBe(version);
    expect(plugin.name).toBe("em");
    expect(market.name).toBe(`em-${version.replace(/\./g, "-")}`);
    expect(market.name).toBe(marketplaceNameFor(version));
    expect(market.plugins).toEqual([expect.objectContaining({ name: "em", source: "./plugin" })]);
    expect(plugin.mcpServers.em).toEqual({ command: "npx", args: ["-y", `@milehimikey/em@${version}`, "mcp"] });
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["plugin", ".claude-plugin"]));
  });

  it("each rewrite rule maps its documented example", () => {
    for (const rule of REWRITE_RULES) {
      const scope = rule.scope === "all" ? "skills" : rule.scope;
      expect(applyRewrites(rule.example.from, scope, "x.md"), rule.id).toContain(rule.example.to);
    }
  });

  it("every em code block in the built skills still parses and validates", () => {
    const blocks: Array<{ rel: string; src: string }> = [];
    for (const [rel, content] of built) {
      if (!rel.endsWith(".md")) continue;
      for (const m of content.matchAll(/```em\n([\s\S]*?)```/g)) {
        if (/^\s*slice\b/m.test(m[1])) blocks.push({ rel, src: m[1] });
      }
    }
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const { rel, src } of blocks) {
      const model = normalize(parse(src));
      const diags = validate(model, layout(model), computeRefs(model)).filter((d) => !d.message.includes('"..."'));
      expect(diags.map((d) => `${rel} ${d.severity}: ${d.message}`)).toEqual([]);
    }
  });
});
