#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Generates the mechanical reference sections of the bundled skill (MIL-92) from the sources
// `em` actually executes — the real commander `program` (src/cli.ts) for CLI/flag tables, and
// the rule registry (src/model/rules.ts) for the validate-rules code reference — instead of
// those sections drifting as hand-copied prose. Writes into marker-delimited regions only;
// everything outside `<!-- GENERATED:*:start/end -->` stays exactly as the file's author wrote
// it (see reference/em-dsl.md's rule-reference intro, SKILL.md's surrounding prose).
//
// Usage:
//   tsx scripts/generate-skill-docs.ts          # write (npm run docs:generate)
//   tsx scripts/generate-skill-docs.ts --check   # verify only, exit 1 on drift (npm run docs:check)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { program } from "../src/cli.js";
import { RULES, RuleCode, RuleDef } from "../src/model/rules.js";
import type { Severity } from "../src/model/validate.js";
import { isMainModule } from "../src/util/isMainModule.js";
import { applyMarker as patchMarker } from "../src/util/markers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The DSL/CLI reference lives in the shared, non-skill directory (MIL-157) — every
// event-modeling-* skill points back to this one copy instead of duplicating it.
export const EM_DSL_MD = join(ROOT, ".claude/skills/event-modeling-shared/reference/em-dsl.md");
// The quick CLI cheatsheet lives in the router skill's own SKILL.md — the one file every session
// sees regardless of which phase-specific skill ends up handling the work.
export const SKILL_MD = join(ROOT, ".claude/skills/event-modeling/SKILL.md");
export const USAGE_DATA_MD = join(ROOT, "docs/usage-data.md");
// The slice-doc frontmatter contract (MIL-186) — the one docs/ reference an authoring agent
// actually needs mid-session, so it's vendored into the bundle instead of left dangling like
// the rest of docs/*.md (see operating-principles.md's "References to docs/*.md" note).
export const SLICE_DOC_SCHEMA_SRC = join(ROOT, "docs/slice-doc-schema.md");
export const SLICE_DOC_SCHEMA_VENDORED = join(
  ROOT,
  ".claude/skills/event-modeling-shared/reference/slice-doc-schema.md",
);

// ---- CLI reference (full) — every command/option, walked from the real commander tree ----

function argSummary(cmd: Command): string {
  return cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(" ");
}

/** One `code   # comment` row per command (bare invocation) and per option. A command that's
 *  purely a namespace for subcommands (e.g. `skill`, which only groups `skill install`) gets no
 *  bare row of its own — nothing to invoke directly. */
function collectRows(cmd: Command, prefix: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const label = `${prefix} ${cmd.name()}`;
  const args = argSummary(cmd);
  const head = args ? `${label} ${args}` : label;
  const isNamespaceOnly = cmd.options.length === 0 && cmd.registeredArguments.length === 0 && cmd.commands.length > 0;
  if (!isNamespaceOnly) {
    rows.push([head, cmd.description()]);
    for (const opt of cmd.options) rows.push([`${head} ${opt.flags}`, opt.description]);
  }
  for (const sub of cmd.commands) rows.push(...collectRows(sub, label));
  return rows;
}

function renderRows(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([code]) => code.length));
  return rows.map(([code, comment]) => `${code.padEnd(width)}   # ${comment}`).join("\n");
}

export function buildCliReferenceFull(prog: Command): string {
  const rows: Array<[string, string]> = [[`em --version`, "print the installed em version"]];
  for (const cmd of prog.commands) rows.push(...collectRows(cmd, "em"));
  return "```bash\n" + renderRows(rows) + "\n```";
}

// ---- CLI reference (quick) — SKILL.md's curated cheatsheet subset ----
//
// Deliberately hand-authored, not mechanically derived: this is an editorial pick of which
// commands/flags belong in a short session cheatsheet, and the wording is intentionally terser
// than the full descriptions. What IS mechanically checked: every `em <command>` and every
// `--flag`/`-x` token below must resolve against the real commander tree, so a renamed/removed
// command or flag fails generation loudly instead of the cheatsheet quietly going stale.
const QUICK_CLI_LINES: ReadonlyArray<{ line: string; command: string; flags?: string[] }> = [
  { line: "em --version", command: "--version" },
  { line: "em init <name>.em                          # optional starter scaffold", command: "init" },
  {
    line: "em scaffold <name>                         # full project: <slug>/<slug>.em, README.md, .event-modeling.md",
    command: "scaffold",
  },
  { line: "em validate <name>.em                      # check rules; exit 0 if clean/warnings only", command: "validate" },
  { line: "em render <name>.em -o <name>.svg          # render (svg/png/pdf by extension)", command: "render", flags: ["-o"] },
  { line: "em render <name>.em --emit-dot             # inspect generated Graphviz DOT", command: "render", flags: ["--emit-dot"] },
  {
    line: 'em render <name>.em --slice "<slice-name>" -o slices/<slug>.svg   # this slice\'s own diagram',
    command: "render",
    flags: ["--slice", "-o"],
  },
  { line: "em watch <name>.em -o <name>.svg           # re-render on save (run in background)", command: "watch", flags: ["-o"] },
  {
    line:
      "em watch <name>.em -o <name>.svg --serve   # + the live browser viewer: instant push-reload, pan/zoom (--port N)\n" +
      '                                            #   click "Review mode" for a slice-by-slice storyboard walkthrough',
    command: "watch",
    flags: ["-o", "--serve"],
  },
];

function optionFlagTokens(cmd: Command): string[] {
  // "-o, --out <file>" -> ["-o", "--out"]
  return cmd.options.flatMap((o) => o.flags.split(",").map((s) => s.trim().split(/\s+/)[0]));
}

export function buildCliReferenceQuick(prog: Command): string {
  for (const { command, flags } of QUICK_CLI_LINES) {
    if (command === "--version") continue;
    const cmd = prog.commands.find((c) => c.name() === command);
    if (!cmd) throw new Error(`generate-skill-docs: SKILL.md quick reference names unknown command "${command}"`);
    for (const flag of flags ?? []) {
      if (!optionFlagTokens(cmd).includes(flag)) {
        throw new Error(`generate-skill-docs: SKILL.md quick reference names unknown flag "${flag}" on "em ${command}"`);
      }
    }
  }
  return "```bash\n" + QUICK_CLI_LINES.map((l) => l.line).join("\n") + "\n```";
}

// ---- Validate-rules code reference — additive appendix from src/model/rules.ts ----
//
// Deliberately additive, not a replacement of em-dsl.md's hand-written Errors/Warnings prose
// above it: that prose carries teaching rationale a mechanical table would flatten. This table
// closes the actual drift gap instead — a new `RULES` entry is guaranteed to appear here the
// moment it's registered, whether or not the prose above has been updated to match.
export function buildRuleReferenceAppendix(rules: Record<RuleCode, RuleDef>): string {
  const codes = (Object.keys(rules) as RuleCode[])
    .filter((code) => !rules[code].optIn)
    .sort((a, b) => a.localeCompare(b));
  const header = "| Code | Severity | Title | Fix |\n|---|---|---|---|";
  const rows = codes.map((code) => {
    const r = rules[code];
    return `| \`${code}\` | ${r.severity} | ${r.title} | ${r.fix} |`;
  });
  return [header, ...rows].join("\n");
}

// ---- Usage-log Categories tables — docs/usage-data.md's fixed vocabulary from src/model/rules.ts ----
//
// Every RULES entry's `usageCategory` (including the 4 `--slice-ready`-only codes — unlike the
// validate-rules appendix above, a session using `--slice-ready` can still hit one, so it needs
// to be a valid Usage log entry too). Several codes deliberately share one category string
// (e.g. `arrow-unresolved-source`/`arrow-unresolved-target` both read "arrow endpoint
// unresolved") — the table lists the fixed vocabulary itself, one row per distinct string, not
// one row per code.
export function buildUsageCategories(rules: Record<RuleCode, RuleDef>, severity: Severity): string {
  const categories = new Set<string>();
  for (const code of Object.keys(rules) as RuleCode[]) {
    if (rules[code].severity === severity) categories.add(rules[code].usageCategory);
  }
  const sorted = [...categories].sort((a, b) => a.localeCompare(b));
  const header = "| Category |\n|---|";
  const rows = sorted.map((c) => `| ${c} |`);
  return [header, ...rows].join("\n");
}

// ---- Vendored slice-doc-schema.md (MIL-186) ----
//
// Not a byte-identical copy — two classes of relative link need rewriting for the vendored
// copy's new home (.claude/skills/event-modeling-shared/reference/, not docs/):
//   1. Links to *other* docs/*.md files (cli.md, validation.md) aren't vendored, so a plain
//      relative link would be locally unresolvable from the copy's new directory. Repointed at
//      the em GitHub repo directly — the same "em repo — not vendored" convention already used
//      for the bundle's other cross-doc links (see operating-principles.md, implement.md).
//   2. The one link back into this same skill bundle, written relative to docs/
//      (../.claude/skills/event-modeling-shared/templates/slice.md), becomes the shorter
//      sibling-directory form (../templates/slice.md) the copy's new home actually sits next to.
const SLICE_DOC_SCHEMA_LINKED_DOCS = ["cli", "validation"] as const;

export function buildVendoredSliceDocSchema(source: string): string {
  let body = source;
  for (const name of SLICE_DOC_SCHEMA_LINKED_DOCS) {
    body = body.split(`](${name}.md`).join(`](https://github.com/milehimikey/em/blob/main/docs/${name}.md`);
  }
  body = body
    .split("](../.claude/skills/event-modeling-shared/templates/slice.md)")
    .join("](../templates/slice.md)");
  const banner =
    "<!-- GENERATED FILE — do not hand-edit. Synced from docs/slice-doc-schema.md by\n" +
    "     scripts/generate-skill-docs.ts (`npm run docs:generate`); `npm run docs:check` fails\n" +
    "     on drift. A few links below are rewritten for this vendored location (see that\n" +
    "     script's buildVendoredSliceDocSchema for exactly what changes and why) — everything\n" +
    "     else is identical to the source doc. -->\n\n";
  return banner + body;
}

// ---- Marker-delimited patching ----
//
// The regex-matching mechanics live in src/util/markers.ts (shared with the runtime `em slice
// index` command, MIL-98). This wrapper keeps generate-skill-docs' own throw-on-missing
// contract: a dev-tooling script wants a loud failure, not a null to check.

export function applyMarker(content: string, markerName: string, newBody: string): string {
  const result = patchMarker(content, markerName, newBody);
  if (result === null) {
    throw new Error(`generate-skill-docs: marker "${markerName}" not found — did it move or get renamed?`);
  }
  return result;
}

interface FileEdit {
  path: string;
  markers: Array<{ name: string; body: string }>;
}

function buildEdits(): FileEdit[] {
  return [
    {
      path: EM_DSL_MD,
      markers: [
        { name: "cli", body: buildCliReferenceFull(program) },
        { name: "validate-rules", body: buildRuleReferenceAppendix(RULES) },
      ],
    },
    {
      path: SKILL_MD,
      markers: [{ name: "cli-quick", body: buildCliReferenceQuick(program) }],
    },
    {
      path: USAGE_DATA_MD,
      markers: [
        { name: "usage-categories-warnings", body: buildUsageCategories(RULES, "warning") },
        { name: "usage-categories-errors", body: buildUsageCategories(RULES, "error") },
      ],
    },
  ];
}

function main(): void {
  const check = process.argv.includes("--check");
  const edits = buildEdits();
  let drift = false;

  for (const { path, markers } of edits) {
    const original = readFileSync(path, "utf8");
    let updated = original;
    for (const { name, body } of markers) updated = applyMarker(updated, name, body);

    if (updated === original) continue;
    if (check) {
      drift = true;
      console.error(`docs:check — drift in ${path.replace(ROOT + "/", "")}: regenerated content differs from disk`);
    } else {
      writeFileSync(path, updated, "utf8");
      console.log(`wrote ${path.replace(ROOT + "/", "")}`);
    }
  }

  // Whole-file generation (not marker-patched — the entire vendored copy is generated content).
  const vendoredSliceDocSchema = buildVendoredSliceDocSchema(readFileSync(SLICE_DOC_SCHEMA_SRC, "utf8"));
  const vendoredOriginal = existsSync(SLICE_DOC_SCHEMA_VENDORED) ? readFileSync(SLICE_DOC_SCHEMA_VENDORED, "utf8") : null;
  if (vendoredSliceDocSchema !== vendoredOriginal) {
    if (check) {
      drift = true;
      console.error(
        `docs:check — drift in ${SLICE_DOC_SCHEMA_VENDORED.replace(ROOT + "/", "")}: regenerated content differs from disk`,
      );
    } else {
      writeFileSync(SLICE_DOC_SCHEMA_VENDORED, vendoredSliceDocSchema, "utf8");
      console.log(`wrote ${SLICE_DOC_SCHEMA_VENDORED.replace(ROOT + "/", "")}`);
    }
  }

  if (check) {
    if (drift) {
      console.error("\nRun `npm run docs:generate` and commit the result.");
      process.exitCode = 1;
    } else {
      console.log("docs:check — ok, generated sections match the committed skill docs");
    }
  }
}

// Guarded the same way src/cli.ts guards program.parseAsync(): only run when this file is the
// process's entry module, so test/skillDocsGenerated.test.ts can import the builder functions
// above without writing files or setting an exit code as a side effect.
if (isMainModule(import.meta.url)) main();
