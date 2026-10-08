// SPDX-License-Identifier: MIT
// Builds the `em` Claude Code plugin (MIL-230) from the vendored skill bundle in
// `.claude/skills/`. Pure: `buildPlugin(version)` reads the skill sources and returns a
// Map of relative path -> content for the generated `plugin/` tree plus the repo-root
// `.claude-plugin/marketplace.json`. scripts/generate-skill-docs.ts writes / checks it and
// test/pluginBuild.test.ts is the CI gate (byte-for-byte parity with the committed tree).
//
// Layout (see findings of the MIL-229 spike):
//   plugin/.claude-plugin/plugin.json
//   plugin/skills/<short>/SKILL.md (+ reference/*.md)   short = discover|design|implement|conform|review|engagement|event-modeling
//   plugin/shared/{reference,templates}/*.md
//   plugin/agents/em-*.md                                (MIL-269: the four sub-agent definitions)
//   .claude-plugin/marketplace.json                      name = em-<version dots -> dashes>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS_SRC = join(ROOT, ".claude/skills");
/** MIL-269: the vendored sub-agent definitions. Only the fixed `em-*.md` list is copied - the
 *  directory is shared with a consumer's own agents in their repos, never in this one's build. */
export const AGENTS_SRC = join(ROOT, ".claude/agents");
export const AGENT_FILES: readonly string[] = ["em-implementer.md", "em-validator.md", "em-reviewer.md", "em-critic.md"];
export const PLUGIN_DIR = "plugin";
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

const SHARED_SRC_DIR = "event-modeling-shared";
const ROUTER_SRC_DIR = "event-modeling";
// MIL-270 (R33): `engagement` is the lead-session skill (event-modeling-engagement -> /em:engagement).
const PHASES = ["discover", "design", "implement", "conform", "review", "engagement"] as const;
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";

export interface RewriteRule {
  /** Short label used in the findings report and asserted by the parity test. */
  id: string;
  pattern: RegExp;
  replacement: string;
  /** Which generated files the rule applies to. */
  scope: "skills" | "reference" | "shared" | "all";
  example: { from: string; to: string };
}

/**
 * The rewrite table, applied in order. Kept as one exported constant so test/pluginBuild.test.ts
 * can assert every rule's example and the findings can quote it.
 */
export const REWRITE_RULES: readonly RewriteRule[] = [
  {
    id: "skill-file-link",
    pattern: /(?:\.\.\/)+\.claude\/skills\/event-modeling-(discover|design|implement|conform|review|engagement)\/SKILL\.md/g,
    replacement: `${ROOT_VAR}/skills/$1/SKILL.md`,
    scope: "skills",
    example: {
      from: "../.claude/skills/event-modeling-design/SKILL.md",
      to: `${ROOT_VAR}/skills/design/SKILL.md`,
    },
  },
  {
    id: "skill-file-link-shared",
    pattern: /(?:\.\.\/)+\.claude\/skills\/event-modeling-(discover|design|implement|conform|review|engagement)\/SKILL\.md/g,
    replacement: "../../skills/$1/SKILL.md",
    scope: "shared",
    example: {
      from: "../.claude/skills/event-modeling-review/SKILL.md",
      to: "../../skills/review/SKILL.md",
    },
  },
  {
    id: "sibling-skill-reference",
    pattern: /(?:\.\.\/)+event-modeling-(discover|conform|design|implement|review|engagement)\/reference\//g,
    replacement: `${ROOT_VAR}/skills/$1/reference/`,
    scope: "skills",
    example: {
      from: "../../event-modeling-conform/reference/conform.md",
      to: `${ROOT_VAR}/skills/conform/reference/conform.md`,
    },
  },
  {
    id: "shared-relative",
    pattern: /(?:\.\.\/)+event-modeling-shared\//g,
    replacement: `${ROOT_VAR}/shared/`,
    scope: "skills",
    example: {
      from: "../event-modeling-shared/reference/em-dsl.md",
      to: `${ROOT_VAR}/shared/reference/em-dsl.md`,
    },
  },
  {
    id: "shared-repo-root",
    pattern: /\.claude\/skills\/event-modeling-shared\//g,
    replacement: `${ROOT_VAR}/shared/`,
    scope: "skills",
    example: {
      from: ".claude/skills/event-modeling-shared/reference/em-dsl.md",
      to: `${ROOT_VAR}/shared/reference/em-dsl.md`,
    },
  },
  {
    id: "shared-bare",
    pattern: /event-modeling-shared/g,
    replacement: `${ROOT_VAR}/shared`,
    scope: "skills",
    example: { from: "event-modeling-shared", to: `${ROOT_VAR}/shared` },
  },
  {
    id: "sibling-skill-reference-ref",
    pattern: /(?:\.\.\/)+event-modeling-(discover|conform|design|implement|review|engagement)\/reference\//g,
    replacement: "../../$1/reference/",
    scope: "reference",
    example: {
      from: "../../event-modeling-conform/reference/conform.md",
      to: "../../conform/reference/conform.md",
    },
  },
  {
    id: "shared-relative-ref",
    pattern: /(?:\.\.\/)+event-modeling-shared\//g,
    replacement: "../../../shared/",
    scope: "reference",
    example: {
      from: "../../event-modeling-shared/reference/em-dsl.md",
      to: "../../../shared/reference/em-dsl.md",
    },
  },
  {
    id: "shared-repo-root-ref",
    pattern: /\.claude\/skills\/event-modeling-shared\//g,
    replacement: "../../../shared/",
    scope: "reference",
    example: {
      from: ".claude/skills/event-modeling-shared/reference/em-dsl.md",
      to: "../../../shared/reference/em-dsl.md",
    },
  },
  {
    id: "invocation",
    pattern: /(?<![\w./-])\/event-modeling(?![\w-])/g,
    replacement: "/em:event-modeling",
    scope: "all",
    example: { from: "`/event-modeling` model", to: "`/em:event-modeling` model" },
  },
  {
    id: "phase-skill-name",
    pattern: /event-modeling-(discover|design|implement|conform|review|engagement)\b/g,
    replacement: "em:$1",
    scope: "all",
    example: { from: "event-modeling-design", to: "em:design" },
  },
  {
    id: "router-self-reference",
    pattern: /`event-modeling` \(this skill\)/g,
    replacement: "`em:event-modeling` (this skill)",
    scope: "skills",
    example: { from: "`event-modeling` (this skill)", to: "`em:event-modeling` (this skill)" },
  },
  {
    id: "all-skills-glob",
    pattern: /`event-modeling-\*` skill/g,
    replacement: "`em` plugin skill",
    scope: "all",
    example: { from: "every `event-modeling-*` skill", to: "every `em` plugin skill" },
  },
];

/** Files whose content describes the vendored bundle's directory names (generated CLI help); the
 * skill-name rules must not mangle them. Path-shape rules still apply to `skills` scope only. */
const NAME_RULES_SKIP = new Set(["shared/reference/em-dsl.md"]);

export function applyRewrites(content: string, scope: "skills" | "reference" | "shared" | "agents", outRel: string): string {
  let out = content;
  for (const rule of REWRITE_RULES) {
    // "agents" (MIL-269, R33) takes only the name rules (scope "all"): skill names, never path rules.
    if (rule.scope !== "all" && rule.scope !== scope) continue;
    if ((rule.id === "invocation" || rule.id === "phase-skill-name" || rule.id === "all-skills-glob") && NAME_RULES_SKIP.has(outRel)) {
      continue;
    }
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function bannerFor(srcRel: string): string {
  return `<!-- GENERATED FILE from ${srcRel} by scripts/build-plugin.ts — do not hand-edit; run npm run docs:generate -->`;
}

/** Banner goes AFTER a leading frontmatter block (so the SKILL.md frontmatter stays first). */
function withBanner(content: string, srcRel: string): string {
  const banner = bannerFor(srcRel);
  const m = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (m) return `${m[0]}${banner}\n${content.slice(m[0].length)}`;
  return `${banner}\n${content}`;
}

function setFrontmatterName(content: string, name: string): string {
  return content.replace(/^(---\n(?:[\s\S]*?\n)?)name:[^\n]*\n/, `$1name: ${name}\n`);
}

export function marketplaceNameFor(version: string): string {
  return `em-${version.replace(/\./g, "-")}`;
}

const PLUGIN_DESCRIPTION =
  "Event Modeling with em: discover, design, implement, conform, review and engagement skills over a slice-first text DSL, plus the em MCP server.";

export function buildPlugin(version: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const abs of listFiles(SKILLS_SRC)) {
    const srcRel = relative(SKILLS_SRC, abs).split("\\").join("/"); // e.g. event-modeling-design/SKILL.md
    const [srcDir, ...rest] = srcRel.split("/");
    const tail = rest.join("/");
    if (!tail.endsWith(".md")) throw new Error(`build-plugin: unexpected non-markdown skill file ${srcRel}`);

    let outRel: string;
    let scope: "skills" | "reference" | "shared";
    let short: string | null = null;
    if (srcDir === SHARED_SRC_DIR) {
      outRel = `shared/${tail}`;
      scope = "shared";
    } else if (srcDir === ROUTER_SRC_DIR) {
      short = "event-modeling";
      outRel = `skills/${short}/${tail}`;
      scope = "skills";
    } else if (srcDir.startsWith("event-modeling-") && (PHASES as readonly string[]).includes(srcDir.slice("event-modeling-".length))) {
      short = srcDir.slice("event-modeling-".length);
      outRel = `skills/${short}/${tail}`;
      scope = "skills";
    } else {
      throw new Error(`build-plugin: unrecognised skill directory ${srcDir}`);
    }

    let content = readFileSync(abs, "utf8");
    if (short && tail === "SKILL.md") content = setFrontmatterName(content, short);
    // ${CLAUDE_PLUGIN_ROOT} only expands in SKILL.md bodies; reference files are read later with
    // the Read tool, so they get plain relative paths that resolve from their own location.
    if (scope === "skills" && tail !== "SKILL.md") scope = "reference";
    content = applyRewrites(content, scope, outRel);
    content = withBanner(content, `.claude/skills/${srcRel}`);
    out.set(`${PLUGIN_DIR}/${outRel}`, content);
  }

  // MIL-269 (R33): plugin/agents/em-*.md - same skill-name rewrite as the skills. No `agents` key in
  // plugin.json is needed (or wanted): Claude Code scans the default `agents/` directory, and a
  // manifest `agents` value would REPLACE that scan and accepts files only.
  for (const file of AGENT_FILES) {
    const content = applyRewrites(readFileSync(join(AGENTS_SRC, file), "utf8"), "agents", `agents/${file}`);
    out.set(`${PLUGIN_DIR}/agents/${file}`, withBanner(content, `.claude/agents/${file}`));
  }

  const pluginJson = {
    name: "em",
    version,
    description: PLUGIN_DESCRIPTION,
    author: { name: "Mike Key" },
    mcpServers: {
      em: { command: "npx", args: ["-y", `@milehimikey/em@${version}`, "mcp"] },
    },
  };
  out.set(`${PLUGIN_DIR}/.claude-plugin/plugin.json`, JSON.stringify(pluginJson, null, 2) + "\n");

  const marketplace = {
    name: marketplaceNameFor(version),
    owner: { name: "Mike Key" },
    description: `em v${version}: the Event Modeling skill bundle and MCP server as a Claude Code plugin.`,
    plugins: [{ name: "em", source: "./plugin", description: PLUGIN_DESCRIPTION }],
  };
  out.set(MARKETPLACE_PATH, JSON.stringify(marketplace, null, 2) + "\n");

  return out;
}

/** The em package version the plugin is stamped with. */
export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}
