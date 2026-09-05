// SPDX-License-Identifier: MIT
// MIL-21: MCP server for em models — agent-facing structured access to `em export`'s data
// layer over the Model Context Protocol, for tool surfaces beyond Claude Code + a shell
// (the Slicewright story's cross-agent demonstration).
//
// Deliberately outside the CLI core: nothing here imports src/cli.ts or commander. Every tool
// is a thin adapter — compile the named file fresh (stateless per call, no session state, no
// caching) and hand back the EXACT SAME JSON document the matching `em <cmd> --json` CLI
// surface emits (src/emit/json.ts, src/emit/validateJson.ts), so there is exactly one schema
// per surface and no drift between "em from a shell" and "em over MCP". No new judgment lives
// here: this module only wires existing builders to MCP's tool-call shape.
//
// Diagnostic scope per tool deliberately mirrors src/cli.ts's own per-command choice, not a
// single shared "compile everything" helper:
//   - `validate`/`slice_ready`/`list_markers` fold in the same fs-aware checks `em validate`
//     does (lineage, frontmatter coherence, note bindings, doc↔model consistency) — see
//     compileWithValidation() below.
//   - `export_model`/`export_slice` gate refusal on compile()'s own diagnostics only, same as
//     `em export` — the doc-join/note-binding diagnostics buildExport() adds are folded into
//     the returned document, never into the refusal gate itself.
//
// Every tool takes the model file path as an input parameter; nothing is held across calls.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { Diagnostic, hasErrors } from "../model/validate.js";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { diffModels, LineageResolvers } from "../model/diff.js";
import { buildExport, buildSliceExport, GENERATOR_VERSION } from "../emit/json.js";
import { buildValidateJson, buildSliceReadyJson, buildValidateListJson, collectMarkers } from "../emit/validateJson.js";
import { buildDiffJson } from "../emit/diffJson.js";
import { validateLineage } from "../catalog/lineageValidate.js";
import { validateFrontmatterCoherence } from "../catalog/frontmatterCoherenceValidate.js";
import { validateNoteBindings } from "../catalog/noteBindingValidate.js";
import { validateDocModelConsistency } from "../catalog/docModelConsistencyValidate.js";
import { validateOrphanedSliceDocs } from "../catalog/orphanedSliceDocValidate.js";
import { validateSliceReady, computeSliceReadyGates } from "../catalog/sliceReadyValidate.js";
import { buildCoverageReport, CoverageReport } from "../cli/coverage.js";
import { buildCoverageJson } from "../emit/coverageJson.js";
import { readContract, contractPath } from "../cli/contract.js";
import {
  resolveSliceStatusFacts,
  countOpenIssues,
  resolveConformanceEntry,
  aggregateInvariantTotals,
  buildStatusReport,
  SliceStatusFact,
  StatusDiagnostic,
} from "../cli/status.js";
import { buildStatusJson } from "../emit/statusJson.js";
import { planDiffArgs, resolveRevision, resolveDocAtRevision } from "../cli/diff-inputs.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { buildGlossary, detectKindConflicts, detectFieldTypeConflicts, GlossaryModelInput } from "../model/glossary.js";
import { buildGlossaryJson, GlossaryFileSide } from "../emit/glossaryJson.js";
import { listModelCommits } from "../cli/changelog-git.js";
import { buildChangelogDoc } from "../cli/changelogBuild.js";
import { buildConformScope, changedPathsSince, resolveSliceDocFacts, SliceDocFacts } from "../cli/conformScope.js";
import { loadStateFile, parseState } from "../cli/stateFile.js";
import { buildFreshnessJson } from "../emit/freshnessJson.js";
import { compileForQuery } from "../query/pipeline.js";
import type { ModelIndex } from "../model/queryIndex.js";
import { buildQuerySystem, QuerySystem } from "../query/system.js";
import {
  queryConsumers,
  queryProducers,
  queryDownstream,
  queryUpstream,
  querySlices,
  queryInvariant,
  queryField,
  queryPath,
} from "../query/verbs.js";
import { buildQueryJson } from "../emit/queryJson.js";

/** MCP server identity: name "em", version = the installed package's own version — same
 *  `GENERATOR_VERSION` `em export`'s `generator.version` field already reads from package.json,
 *  so `em --version`/`em export`'s `generator.version`/this server's version never drift apart. */
export const SERVER_NAME = "em";
export const SERVER_VERSION = GENERATOR_VERSION;

/** Path to the packaged `event-modeling-implement` skill directory bundled with whatever em
 *  package is actually running — same resolution as src/cli.ts's own packagedSkillsRoot(),
 *  computed independently here (this module never imports cli.ts) since `contract` needs it for
 *  readContract()/contractPath(). One directory level deeper than cli.ts's own version
 *  (src/mcp/server.ts, not src/cli.ts, so dist/mcp/server.js sits one level further from the
 *  package root than dist/cli.js does). The implementation contract (reference/implement.md,
 *  MIL-129) lives specifically under `event-modeling-implement/` since the skill split
 *  (MIL-157) — see src/cli/skillDirs.ts. */
function packagedSkillDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "skills", "event-modeling-implement");
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

interface CompiledSource {
  model: NormalizedModel;
  refs: RefsResult;
  source: string;
  /** compile()'s own diagnostics — parse/validate/refs, nothing fs-aware. Exactly what
   *  src/cli.ts's compileFile() returns as `diagnostics`, and what `em export`'s refusal gate
   *  checks. */
  diagnostics: Diagnostic[];
}

/** Read + compile `file`, mirroring src/cli.ts's compileFile() but returning a result instead
 *  of calling process.exit(): a missing file or parse error becomes an `{ error }`, never a
 *  crash or a process exit (MCP tools must survive both — see this module's header). */
function compileFile(file: string): CompiledSource | { error: string } {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return { error: `cannot read ${file}` };
  }
  try {
    const { model, refs, diagnostics } = compile(source);
    return { model, refs, source, diagnostics };
  } catch (e) {
    if (e instanceof ParseError) return { error: `parse error in ${file} ${e.message}` };
    throw e;
  }
}

/** Same as compileFile(), but for source text already in hand (e.g. `git show`'s stdout) rather
 *  than a path to read — shared by the `diff` tool's git-revision form, which never has a real
 *  file on disk for the revision side. `label` is used only for the parse-error message. */
function compileText(source: string, label: string): CompiledSource | { error: string } {
  try {
    const { model, refs, diagnostics } = compile(source);
    return { model, refs, source, diagnostics };
  } catch (e) {
    if (e instanceof ParseError) return { error: `parse error in ${label} ${e.message}` };
    throw e;
  }
}

/** compileFile() plus the same fs-aware checks `em validate` folds into its own diagnostic set
 *  unconditionally (lineage, frontmatter coherence, note bindings, doc↔model consistency,
 *  orphaned slice docs — MIL-183) — shared by the `validate`, `slice_ready`, and `list_markers`
 *  tools, same as src/cli.ts's `validate` action computes them once and reuses the result for all
 *  three of its own modes (--slice-ready, --list-*, plain). */
function compileWithValidation(file: string): (CompiledSource & { allDiagnostics: Diagnostic[] }) | { error: string } {
  const compiled = compileFile(file);
  if ("error" in compiled) return compiled;
  const { model, refs } = compiled;
  const baseDir = dirname(file);
  const allDiagnostics = [
    ...compiled.diagnostics,
    ...validateLineage(model, refs, baseDir),
    ...validateFrontmatterCoherence(model, refs, baseDir),
    ...validateNoteBindings(model, refs, baseDir),
    ...validateDocModelConsistency(model, refs, baseDir),
    ...validateOrphanedSliceDocs(model, refs, baseDir),
  ];
  return { ...compiled, allDiagnostics };
}

/** Same compile-and-diagnose scaffolding `compileFile()`/`compileWithValidation()` give every
 *  other tool, but pointed at `query/pipeline.ts`'s lighter sub-pipeline (no layout allocation,
 *  no DOT emission — see that module's header) and returning a built `QuerySystem` (the exact
 *  same one `src/cli.ts`'s `query` command builds — MCP parity) instead of a single compiled
 *  model. Refuses (an `{ error }`, never a crash) the same way every other tool does when any
 *  input file fails to compile or has errors. */
function compileFilesForQueryMcp(files: string[]): { system: QuerySystem } | { error: string } {
  const entries: Array<{ file: string; model: NormalizedModel; refs: RefsResult; index: ModelIndex }> = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return { error: `cannot read ${file}` };
    }
    let compiled;
    try {
      compiled = compileForQuery(source, dirname(file));
    } catch (e) {
      if (e instanceof ParseError) return { error: `parse error in ${file} ${e.message}` };
      throw e;
    }
    if (hasErrors(compiled.diagnostics)) {
      return { error: `not querying: "${file}" has errors — run \`validate\` first and fix them` };
    }
    entries.push({ file, model: compiled.model, refs: compiled.refs, index: compiled.index });
  }
  return { system: buildQuerySystem(entries) };
}

const fileParam = z.string().describe("path to the .em model file, resolved relative to the server's working directory");
const sliceKeyParam = z
  .string()
  .describe('the slice\'s export key (its stable JSON identity, e.g. "place-order" — see `em export`\'s slice.key)');

/** Registers all fourteen MCP tools on a fresh McpServer instance and returns it, unconnected — the
 *  caller (src/mcp/main.ts's stdio entry, or a test harness using an in-memory transport)
 *  decides how to connect it. Building the server is a pure, side-effect-free function so tests
 *  can exercise it directly with the SDK's in-memory transport, no child process required. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "validate",
    {
      title: "Validate an em model",
      description:
        "Check a .em model against event-modeling rules and return the same JSON document " +
        "`em validate <file> --json` prints: a pass/fail summary plus every diagnostic (code, " +
        "message, line, refs, usageCategory). Works even when the model has errors — this is " +
        "the tool to call first when you just need to know what's wrong, or to confirm a model " +
        "is clean before exporting it.",
      inputSchema: { file: fileParam },
    },
    async ({ file }) => {
      const compiled = compileWithValidation(file);
      if ("error" in compiled) return errorResult(compiled.error);
      return textResult(buildValidateJson(file, compiled.allDiagnostics));
    },
  );

  server.registerTool(
    "slice_ready",
    {
      title: "Check whether a slice is ready to implement",
      description:
        "Return the machine-readable readiness verdict for one slice — the same JSON document " +
        "`em validate <file> --slice-ready <key> --json` prints: 4 named gates (doc bound, " +
        "frontmatter usable, status ready-to-implement, no unchecked Open Questions), the " +
        "overall `ready` boolean, and the scoped diagnostics behind it. Call this before " +
        "implementing a slice — never infer readiness yourself from `export_slice`'s content.",
      inputSchema: { file: fileParam, sliceKey: sliceKeyParam },
    },
    async ({ file, sliceKey }) => {
      const compiled = compileWithValidation(file);
      if ("error" in compiled) return errorResult(compiled.error);
      const { model, refs, allDiagnostics } = compiled;
      const baseDir = dirname(file);
      const readyDiagnostics = validateSliceReady(model, refs, baseDir, sliceKey);
      const combined = [...allDiagnostics, ...readyDiagnostics];
      const scoped = combined.filter((d) => d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)));
      const ready = scoped.length === 0;
      const gates = computeSliceReadyGates(model, refs, baseDir, sliceKey);
      return textResult(buildSliceReadyJson(file, sliceKey, gates, scoped, ready));
    },
  );

  server.registerTool(
    "list_markers",
    {
      title: "List issue/divergence/public markers",
      description:
        "Return the structured marker enumeration `em validate <file> --list-issues " +
        "--list-divergences --list-public --json` prints: every open `issue` annotation, " +
        "accepted `divergence` annotation, and `public`-marked event/view in the model, each " +
        "with its slice/element ref and line. All three kinds default to included — pass " +
        "`issues`/`divergences`/`public: false` to narrow. Never fails the model on its own; " +
        "genuine errors still appear in the `diagnostics` field.",
      inputSchema: {
        file: fileParam,
        issues: z.boolean().default(true).describe("include open `issue` markers"),
        divergences: z.boolean().default(true).describe("include accepted `divergence` markers"),
        public: z.boolean().default(true).describe("include `public`-marked events/views"),
      },
    },
    async ({ file, issues, divergences, public: pub }) => {
      const compiled = compileWithValidation(file);
      if ("error" in compiled) return errorResult(compiled.error);
      const { model, refs, allDiagnostics } = compiled;
      const errorsOnly = allDiagnostics.filter((d) => d.severity === "error");
      const markers = collectMarkers(model, refs, { issues, divergences, public: pub });
      return textResult(buildValidateListJson(file, markers, errorsOnly));
    },
  );

  server.registerTool(
    "export_model",
    {
      title: "Export the full normalized model",
      description:
        "Return the same JSON document `em export <file>` prints: a versioned, deterministic " +
        "snapshot of the whole normalized model — types, slices (pattern, fields, doc, " +
        "elements), arrows, the complete semantic edge list (`model.edges`, the canonical graph " +
        "— read it rather than re-deriving connections from slice membership), and export-stable " +
        "refs. Refuses (tool error) when the model has " +
        "errors, same as the CLI — call `validate` first, or use `export_slice` to read one " +
        "already-ratified slice while the rest of the model is still broken.",
      inputSchema: { file: fileParam },
    },
    async ({ file }) => {
      const compiled = compileFile(file);
      if ("error" in compiled) return errorResult(compiled.error);
      const { model, refs, diagnostics, source } = compiled;
      if (hasErrors(diagnostics)) {
        return errorResult(`not exporting: "${file}" has errors — run \`validate\` first and fix them`);
      }
      const exported = buildExport(model, refs, diagnostics, source, file);
      return textResult(exported.text);
    },
  );

  server.registerTool(
    "export_slice",
    {
      title: "Export one slice, scoped",
      description:
        "Return the same JSON document `em export <file> --slice <key>` prints: just that " +
        "slice's object (pattern, fields, doc, elements) plus the export envelope. Refuses " +
        "(tool error) only if THIS slice has an error, or if `sliceKey` names no slice in the " +
        "model — an unrelated slice's breakage elsewhere never blocks it. Use this to " +
        "implement one already-ratified slice while the rest of a large, still-WIP model has " +
        "unrelated errors.",
      inputSchema: { file: fileParam, sliceKey: sliceKeyParam },
    },
    async ({ file, sliceKey }) => {
      const compiled = compileFile(file);
      if ("error" in compiled) return errorResult(compiled.error);
      const { model, refs, diagnostics, source } = compiled;
      const scopedErrors = diagnostics.filter(
        (d) => d.severity === "error" && d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)),
      );
      if (scopedErrors.length > 0) {
        return errorResult(`not exporting: slice "${sliceKey}" has errors — fix them first`);
      }
      const sliceExport = buildSliceExport(model, refs, diagnostics, source, file, sliceKey);
      if (!sliceExport.found) {
        return errorResult(`no slice with export key "${sliceKey}" in "${file}"`);
      }
      return textResult(sliceExport.text!);
    },
  );

  server.registerTool(
    "coverage",
    {
      title: "Check invariant-to-test citation coverage",
      description:
        "Return the same JSON document `em coverage <file> --tests <dir> --json` prints: for " +
        "every slice whose joined doc status is ready-to-implement or implemented, each INV-* " +
        "invariant ID found in the doc body, whether a test file under `testsDir` cites it " +
        "(word-boundary match on the exact ID), and every citing file:line. Mechanizes " +
        "reference/implement.md's definition-of-done citation check — confirms an ID is cited, " +
        "not that the citing test is good or passing (that stays with review and CI). Refuses " +
        "(tool error) if the model has errors, or if `testsDir` doesn't exist.",
      inputSchema: {
        file: fileParam,
        testsDir: z.string().describe("directory to scan recursively for test files citing invariant IDs"),
      },
    },
    async ({ file, testsDir }) => {
      const compiled = compileFile(file);
      if ("error" in compiled) return errorResult(compiled.error);
      const { model, refs, diagnostics } = compiled;
      if (hasErrors(diagnostics)) {
        return errorResult(`not checking coverage: "${file}" has errors — run \`validate\` first and fix them`);
      }
      if (!existsSync(testsDir)) {
        return errorResult(`testsDir not found: ${testsDir}`);
      }
      if (!statSync(testsDir).isDirectory()) {
        return errorResult(`testsDir is not a directory: ${testsDir}`);
      }
      const report = buildCoverageReport(model, refs, dirname(file), testsDir);
      return textResult(buildCoverageJson(file, testsDir, report));
    },
  );

  server.registerTool(
    "contract",
    {
      title: "Print the implementation contract",
      description:
        "Return the packaged implementation contract (reference/implement.md) verbatim — the " +
        "same text `em contract` prints to stdout. Read this before implementing any slice: it " +
        "defines what \"ready\" means, treats the slice doc as the read-only spec, and says " +
        "when to stop and hand a gap to a human instead of deciding it silently. Takes no " +
        "input.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(readContract(packagedSkillDir()));
      } catch {
        return errorResult(`cannot read the packaged contract at ${contractPath(packagedSkillDir())} — broken em installation`);
      }
    },
  );

  server.registerTool(
    "status",
    {
      title: "Deterministic state-of-the-system rollup",
      description:
        "Return the same JSON document `em status <files...> --json` prints (MIL-163): slices " +
        "by lifecycle status, driftSignal breakdown, invariant coverage totals (when testsDir " +
        "is given), open `issue` markers + unchecked Open Questions, and last-conformance " +
        "commits-behind-HEAD per model. Refuses (tool error) when any model has errors, same " +
        "as the CLI — call `validate` first, or use `export_slice` for one broken model.",
      inputSchema: {
        files: z.array(fileParam).min(1).describe("one or more .em model file paths"),
        testsDir: z
          .string()
          .optional()
          .describe("directory to scan for INV-* test citations — enables invariant coverage totals"),
        repo: z
          .string()
          .optional()
          .describe("git repo to compute commits-behind-HEAD in (default: each model's own directory)"),
      },
    },
    async ({ files, testsDir, repo }) => {
      if (testsDir !== undefined) {
        if (!existsSync(testsDir)) return errorResult(`testsDir not found: ${testsDir}`);
        if (!statSync(testsDir).isDirectory()) return errorResult(`testsDir is not a directory: ${testsDir}`);
      }

      const compiledFiles: Array<{ file: string; compiled: CompiledSource }> = [];
      for (const file of files) {
        const compiled = compileFile(file);
        if ("error" in compiled) return errorResult(compiled.error);
        if (hasErrors(compiled.diagnostics)) {
          return errorResult(`not reporting status: "${file}" has errors — run \`validate\` first and fix them`);
        }
        compiledFiles.push({ file, compiled });
      }

      const sliceFacts: SliceStatusFact[] = [];
      const factsByFile = new Map<string, SliceStatusFact[]>();
      const statusDiagnostics: StatusDiagnostic[] = [];
      let openIssuesCount = 0;
      const coverageReports: CoverageReport[] = [];
      for (const { file, compiled } of compiledFiles) {
        const { model, refs } = compiled;
        const baseDir = dirname(file);
        const { facts, diagnostics: docDiags } = resolveSliceStatusFacts(file, model, refs, baseDir);
        sliceFacts.push(...facts);
        factsByFile.set(file, facts);
        for (const d of docDiags) statusDiagnostics.push({ file, ...d });
        // MIL-183: fold in orphaned-slice-doc warnings the same way the CLI's `status` action does.
        for (const d of validateOrphanedSliceDocs(model, refs, baseDir)) statusDiagnostics.push({ file, ...d });
        openIssuesCount += countOpenIssues(model);
        if (testsDir !== undefined) coverageReports.push(buildCoverageReport(model, refs, baseDir, testsDir));
      }
      const invariants = testsDir !== undefined ? aggregateInvariantTotals(testsDir, coverageReports) : null;

      // MIL-164: slice-PRs-behind-HEAD is scoped per model — THIS model's own facts, not the
      // merged `sliceFacts` above (which spans every input file when several are given).
      const conformance = compiledFiles.map(({ file }) => {
        const facts = factsByFile.get(file) ?? [];
        const sliceDocFacts: SliceDocFacts[] = facts.map((f) => ({ key: f.key, status: f.rawStatus, implementedIn: f.implementedIn }));
        return resolveConformanceEntry(file, repo, sliceDocFacts);
      });

      const report = buildStatusReport(files, sliceFacts, openIssuesCount, invariants, conformance, statusDiagnostics);
      return textResult(buildStatusJson(report));
    },
  );

  server.registerTool(
    "diff",
    {
      title: "Compare two models structurally",
      description:
        "Return the same JSON document `em diff <old> <new> --json` (or `em diff <file> --from " +
        "<rev> [--to <rev>] --json`) prints: a rollup of counts plus every structural change — " +
        "slices/elements added, removed, or moved; field/from/note changes; issue lifecycle; " +
        "an event's public promotion/demotion; declared-type changes. Two mutually exclusive " +
        "forms: pass `oldFile` + `newFile` to compare two files directly (no git involved), or " +
        "`oldFile` + `from` (and optionally `to`) to diff ONE file across git revisions via " +
        "`git show <rev>:<path>` — that form REQUIRES `oldFile` to be tracked in a git " +
        "repository reachable from the server's working directory; `to` defaults to the file's " +
        "current on-disk content. Refuses (tool error) if either side fails to compile or has " +
        "validation errors, same as the CLI.",
      inputSchema: {
        oldFile: z.string().describe("old model file — or the file to diff, when using `from`"),
        newFile: z.string().optional().describe("new model file (omit when using `from`/`to`)"),
        from: z
          .string()
          .optional()
          .describe("diff `oldFile` against this git revision instead of `newFile` — requires a git repository"),
        to: z
          .string()
          .optional()
          .describe("diff against this git revision instead of the current file (requires `from`) — requires a git repository"),
      },
    },
    async ({ oldFile, newFile, from, to }) => {
      const plan = planDiffArgs(oldFile, newFile, { from, to });
      if ("error" in plan) return errorResult(plan.error);

      let oldResult: CompiledSource | { error: string };
      let newResult: CompiledSource | { error: string };
      let oldLabel: string;
      let newLabel: string;
      let lineage: LineageResolvers;

      if (plan.form === "files") {
        oldResult = compileFile(plan.oldFile);
        newResult = compileFile(plan.newFile);
        oldLabel = plan.oldFile;
        newLabel = plan.newFile;
        lineage = {
          oldDoc: (key) => readSliceDoc(dirname(plan.oldFile), key),
          newDoc: (key) => readSliceDoc(dirname(plan.newFile), key),
        };
      } else {
        const oldRev = resolveRevision(plan.file, plan.from);
        if (!oldRev.ok) return errorResult(oldRev.message);
        oldLabel = `${plan.file}@${plan.from}`;
        oldResult = compileText(oldRev.content, oldLabel);

        if (plan.to) {
          const newRev = resolveRevision(plan.file, plan.to);
          if (!newRev.ok) return errorResult(newRev.message);
          newLabel = `${plan.file}@${plan.to}`;
          newResult = compileText(newRev.content, newLabel);
        } else {
          newLabel = plan.file;
          newResult = compileFile(plan.file);
        }

        const toRev = plan.to;
        lineage = {
          oldDoc: (key) => resolveDocAtRevision(plan.file, key, plan.from),
          newDoc: (key) => (toRev ? resolveDocAtRevision(plan.file, key, toRev) : readSliceDoc(dirname(plan.file), key)),
        };
      }

      if ("error" in oldResult) return errorResult(oldResult.error);
      if ("error" in newResult) return errorResult(newResult.error);
      if (hasErrors(oldResult.diagnostics) || hasErrors(newResult.diagnostics)) {
        return errorResult(`not diffing: "${oldLabel}" and/or "${newLabel}" have errors — run \`validate\` first and fix them`);
      }

      const diff = diffModels(oldResult.model, newResult.model, oldResult.refs, newResult.refs, lineage);
      const oldSide = { label: oldLabel, source: oldResult.source, diagnostics: oldResult.diagnostics };
      const newSide = { label: newLabel, source: newResult.source, diagnostics: newResult.diagnostics };
      return textResult(buildDiffJson(diff, oldSide, newSide));
    },
  );

  server.registerTool(
    "glossary",
    {
      title: "Cross-model glossary of terms, with conflict detection",
      description:
        "Return the same JSON document `em glossary <files...> --json` prints: element, field, " +
        "persona, and context terms aggregated across the given models, plus kind-conflict and " +
        "field-type-conflict findings where the same normalized term disagrees across models. " +
        "Each file is compiled independently — never merged. Refuses (tool error) if any file " +
        "fails to compile or has validation errors, same as the CLI.",
      inputSchema: {
        files: z.array(z.string()).min(1).describe("one or more .em model file paths"),
      },
    },
    async ({ files }) => {
      const inputs: GlossaryModelInput[] = [];
      const sources: GlossaryFileSide[] = [];
      for (const file of files) {
        const compiled = compileFile(file);
        if ("error" in compiled) return errorResult(compiled.error);
        if (hasErrors(compiled.diagnostics)) {
          return errorResult(`not building glossary: "${file}" has errors — run \`validate\` first and fix them`);
        }
        inputs.push({ label: file, model: compiled.model });
        sources.push({ label: file, source: compiled.source });
      }
      const glossary = buildGlossary(inputs);
      const conflicts = [...detectKindConflicts(glossary), ...detectFieldTypeConflicts(glossary)];
      return textResult(buildGlossaryJson(glossary, conflicts, sources));
    },
  );

  server.registerTool(
    "changelog",
    {
      title: "Render a model's git history as a business-readable ledger",
      description:
        "Return the exact markdown text `em changelog <file>` prints to stdout: one section per " +
        "commit that touched the file (newest first), each with its structural delta (same " +
        "vocabulary as the `diff` tool) and any dated Decisions-log entries from the adjacent " +
        "state file (.event-modeling.md) woven in by date. REQUIRES `file` to be tracked in a " +
        "git repository reachable from the server's working directory — the walk is driven by " +
        "`git log --follow`. Returns markdown, not JSON: this command has no `--json` form on " +
        "the CLI either, the rendered document IS the artifact.",
      inputSchema: {
        file: z.string().describe("input .em model file (must be tracked in git)"),
        from: z.string().optional().describe("start the walk at this revision (inclusive)"),
        to: z.string().optional().describe("end the walk at this revision (inclusive; default HEAD)"),
      },
    },
    async ({ file, from, to }) => {
      const commitsResult = listModelCommits(file, { from, to });
      if (!commitsResult.ok) return errorResult(commitsResult.message);
      return textResult(buildChangelogDoc(file, commitsResult.repoRoot, commitsResult.commits));
    },
  );

  server.registerTool(
    "conform_scope",
    {
      title: "Scope a conformance check: map changed paths to slices",
      description:
        "Return the same JSON document `em conform-scope <file> --repo <repo>` prints: the " +
        "state file's `Last conformance:` marker, the target repo's changed paths since that " +
        "revision (`git diff --name-only`), each mapped to a candidate slice via its doc's " +
        "`implementedIn`, and any leftover unmapped paths. REQUIRES `repo` to be (or be inside) " +
        "a git repository, and `file`'s sibling state file (.event-modeling.md) to exist and " +
        "parse. Read-only: unlike the CLI's `--seed-asis` flag (which writes a scratch model " +
        "file to disk), this tool never writes anything — use the CLI directly for that step.",
      inputSchema: {
        file: z.string().describe("input .em model file"),
        repo: z.string().describe("path to (or inside) the target codebase's git repository"),
        full: z
          .boolean()
          .default(false)
          .describe("ignore Last conformance:/changed paths; scope every status: implemented slice"),
      },
    },
    async ({ file, repo, full }) => {
      const compiled = compileFile(file);
      if ("error" in compiled) return errorResult(compiled.error);
      if (hasErrors(compiled.diagnostics)) {
        return errorResult(`not scoping: "${file}" has errors — run \`validate\` first and fix them`);
      }
      const { model, refs } = compiled;

      const loaded = loadStateFile(dirname(file));
      if (!loaded.ok) return errorResult(loaded.message);
      const parsed = parseState(loaded.text);
      if (!parsed.ok) return errorResult(`em conform-scope: ${parsed.message}`);
      const { lastConformance } = parsed.state;

      const { facts } = resolveSliceDocFacts(model, refs, dirname(file));

      const skipGit = full || lastConformance === null;
      let changedPaths: string[] = [];
      if (!skipGit) {
        const result = changedPathsSince(repo, lastConformance!.revision);
        if (!result.ok) return errorResult(result.message);
        changedPaths = result.paths;
      }

      const scope = buildConformScope(facts, lastConformance, changedPaths, full);
      return textResult(JSON.stringify(scope, null, 2));
    },
  );

  server.registerTool(
    "freshness",
    {
      title: "Standalone conformance freshness signal",
      description:
        "Return the same JSON document `em freshness <file> --json` prints (MIL-164): one " +
        "model's conformance record — last-conformed revision, commits behind HEAD, and slice-" +
        "PRs behind HEAD — without the rest of `em status`'s rollup. Refuses (tool error) when " +
        "the model has errors, same as the CLI.",
      inputSchema: {
        file: fileParam,
        repo: z.string().optional().describe("git repo to compute behind-HEAD in (default: the model's own directory)"),
      },
    },
    async ({ file, repo }) => {
      const compiled = compileFile(file);
      if ("error" in compiled) return errorResult(compiled.error);
      if (hasErrors(compiled.diagnostics)) {
        return errorResult(`not reporting freshness: "${file}" has errors — run \`validate\` first and fix them`);
      }
      const { model, refs } = compiled;
      const baseDir = dirname(file);
      const { facts } = resolveSliceDocFacts(model, refs, baseDir);
      const entry = resolveConformanceEntry(file, repo, facts);
      return textResult(buildFreshnessJson(entry));
    },
  );

  server.registerTool(
    "query",
    {
      title: "Deterministic graph queries over the compiled model",
      description:
        "Return the same JSON document `em query <verb> <files...> --json` prints (MIL-168): " +
        "scoped, token-cheap graph answers instead of a whole-model `export_model` — 8 verbs " +
        "selected by `verb`: consumers/producers (who reads/writes an event), downstream/" +
        "upstream (transitive closure along the six legal connections, optionally depth-" +
        "limited), slices (filtered list — pattern/status/context/persona/tag AND-combine), " +
        "invariant (an INV-* id's declaring slice + doc facts, and with `testsDir` its test " +
        "citations), field (one field's type/tag/assigned/renamed-from facts), and path " +
        "(shortest path between two elements). `event`/`of`/`from`/`to` accept a stable export " +
        "ref or a bare display name — an ambiguous bare name is a tool error listing every " +
        "candidate ref, never a guess. Refs in `results` are `<modelKey>:<ref>`-qualified " +
        "whenever `files` has more than one entry, bare otherwise. Refuses (tool error) when " +
        "any input model has errors, same as every other tool; a legitimately empty answer " +
        "(e.g. an event with no consumers) is `results: []`, not an error.",
      inputSchema: {
        files: z.array(fileParam).min(1).describe("one or more .em model file paths"),
        verb: z
          .enum(["consumers", "producers", "downstream", "upstream", "slices", "invariant", "field", "path"])
          .describe("which query to run"),
        event: z.string().optional().describe("consumers/producers: the event's export ref or display name"),
        of: z.string().optional().describe("downstream/upstream/field: the element's export ref or display name"),
        depth: z.number().int().positive().optional().describe("downstream/upstream: limit traversal to n hops (default: unlimited)"),
        pattern: z.string().optional().describe("slices: state-change | state-view | automation | translation | unclassified"),
        status: z.string().optional().describe("slices: the slice's joined doc status"),
        context: z.string().optional().describe("slices: match a slice with an event in this @Context"),
        persona: z.string().optional().describe("slices: match a slice with a ui in this @Persona"),
        tag: z.string().optional().describe("slices: match a slice with an event carrying this tag key"),
        id: z.string().optional().describe("invariant: the INV-* id to look up"),
        testsDir: z.string().optional().describe("invariant: directory to scan for test files citing this id"),
        name: z.string().optional().describe("field: the field's name"),
        from: z.string().optional().describe("path: the starting element's export ref or display name"),
        to: z.string().optional().describe("path: the ending element's export ref or display name"),
      },
    },
    async ({ files, verb, event, of, depth, pattern, status, context, persona, tag, id, testsDir, name, from, to }) => {
      if (testsDir !== undefined) {
        if (!existsSync(testsDir)) return errorResult(`testsDir not found: ${testsDir}`);
        if (!statSync(testsDir).isDirectory()) return errorResult(`testsDir is not a directory: ${testsDir}`);
      }
      const compiled = compileFilesForQueryMcp(files);
      if ("error" in compiled) return errorResult(compiled.error);
      const { system } = compiled;

      switch (verb) {
        case "consumers": {
          if (!event) return errorResult("query consumers: `event` is required");
          const result = queryConsumers(system, event);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { event }, result.results));
        }
        case "producers": {
          if (!event) return errorResult("query producers: `event` is required");
          const result = queryProducers(system, event);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { event }, result.results));
        }
        case "downstream": {
          if (!of) return errorResult("query downstream: `of` is required");
          const result = queryDownstream(system, of, depth);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { of, depth: depth ?? null }, result.results));
        }
        case "upstream": {
          if (!of) return errorResult("query upstream: `of` is required");
          const result = queryUpstream(system, of, depth);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { of, depth: depth ?? null }, result.results));
        }
        case "slices": {
          const filters = { pattern, status, context, persona, tag };
          const result = querySlices(system, filters);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, filters, result.results));
        }
        case "invariant": {
          if (!id) return errorResult("query invariant: `id` is required");
          const result = queryInvariant(system, id, testsDir);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { id, tests: testsDir ?? null }, result.results));
        }
        case "field": {
          if (!of || !name) return errorResult("query field: `of` and `name` are required");
          const result = queryField(system, of, name);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { of, name }, result.results));
        }
        case "path": {
          if (!from || !to) return errorResult("query path: `from` and `to` are required");
          const result = queryPath(system, from, to);
          if (!result.ok) return errorResult(result.error);
          return textResult(buildQueryJson(verb, files, { from, to }, result.results));
        }
      }
    },
  );

  return server;
}
