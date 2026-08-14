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

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { program } from "../src/cli.js";
import { RULES, RuleCode, RuleDef } from "../src/model/rules.js";
import { isMainModule } from "../src/util/isMainModule.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EM_DSL_MD = join(ROOT, ".claude/skills/event-modeling/reference/em-dsl.md");
export const SKILL_MD = join(ROOT, ".claude/skills/event-modeling/SKILL.md");

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
      "em watch <name>.em -o <name>.svg --serve   # + live viewer with instant push-reload (--port N)\n" +
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

// ---- Marker-delimited patching ----

function markerRegex(name: string): RegExp {
  // Captures the exact start/end marker lines separately from whatever sits between them, so
  // replacement never depends on how much whitespace happened to separate them before —
  // matters for a freshly-added, still-empty marker pair (start line immediately followed by
  // end line, nothing in between to non-greedily match a leading "\n" against).
  const start = `<!-- GENERATED:${name}:start[^\\n]*-->`;
  const end = `<!-- GENERATED:${name}:end -->`;
  return new RegExp(`(${start})([\\s\\S]*?)(${end})`);
}

export function applyMarker(content: string, markerName: string, newBody: string): string {
  const re = markerRegex(markerName);
  if (!re.test(content)) {
    throw new Error(`generate-skill-docs: marker "${markerName}" not found — did it move or get renamed?`);
  }
  return content.replace(re, (_m, open, _old, close) => `${open}\n${newBody}\n${close}`);
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
