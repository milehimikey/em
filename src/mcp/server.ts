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
import { buildExport, buildSliceExport, GENERATOR_VERSION } from "../emit/json.js";
import { buildValidateJson, buildSliceReadyJson, buildValidateListJson, collectMarkers } from "../emit/validateJson.js";
import { validateLineage } from "../catalog/lineageValidate.js";
import { validateFrontmatterCoherence } from "../catalog/frontmatterCoherenceValidate.js";
import { validateNoteBindings } from "../catalog/noteBindingValidate.js";
import { validateDocModelConsistency } from "../catalog/docModelConsistencyValidate.js";
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
} from "../cli/status.js";
import { buildStatusJson } from "../emit/statusJson.js";

/** MCP server identity: name "em", version = the installed package's own version — same
 *  `GENERATOR_VERSION` `em export`'s `generator.version` field already reads from package.json,
 *  so `em --version`/`em export`'s `generator.version`/this server's version never drift apart. */
export const SERVER_NAME = "em";
export const SERVER_VERSION = GENERATOR_VERSION;

/** Path to the packaged skill directory bundled with whatever em package is actually running —
 *  same resolution as src/cli.ts's own packagedSkillDir(), computed independently here (this
 *  module never imports cli.ts) since `contract` needs it for readContract()/contractPath().
 *  One directory level deeper than cli.ts's own version (src/mcp/server.ts, not src/cli.ts, so
 *  dist/mcp/server.js sits one level further from the package root than dist/cli.js does). */
function packagedSkillDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "skills", "event-modeling");
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

/** compileFile() plus the same fs-aware checks `em validate` folds into its own diagnostic set
 *  unconditionally (lineage, frontmatter coherence, note bindings, doc↔model consistency) —
 *  shared by the `validate`, `slice_ready`, and `list_markers` tools, same as src/cli.ts's
 *  `validate` action computes them once and reuses the result for all three of its own modes
 *  (--slice-ready, --list-*, plain). */
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
  ];
  return { ...compiled, allDiagnostics };
}

const fileParam = z.string().describe("path to the .em model file, resolved relative to the server's working directory");
const sliceKeyParam = z
  .string()
  .describe('the slice\'s export key (its stable JSON identity, e.g. "place-order" — see `em export`\'s slice.key)');

/** Registers all seven MCP tools on a fresh McpServer instance and returns it, unconnected — the
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
        "elements), arrows, and export-stable refs. Refuses (tool error) when the model has " +
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
        return errorResult(`--tests directory not found: ${testsDir}`);
      }
      if (!statSync(testsDir).isDirectory()) {
        return errorResult(`--tests is not a directory: ${testsDir}`);
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
        if (!existsSync(testsDir)) return errorResult(`--tests directory not found: ${testsDir}`);
        if (!statSync(testsDir).isDirectory()) return errorResult(`--tests is not a directory: ${testsDir}`);
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
      let openIssuesCount = 0;
      const coverageReports: CoverageReport[] = [];
      for (const { file, compiled } of compiledFiles) {
        const { model, refs } = compiled;
        const baseDir = dirname(file);
        sliceFacts.push(...resolveSliceStatusFacts(file, model, refs, baseDir));
        openIssuesCount += countOpenIssues(model);
        if (testsDir !== undefined) coverageReports.push(buildCoverageReport(model, refs, baseDir, testsDir));
      }
      const invariants = testsDir !== undefined ? aggregateInvariantTotals(testsDir, coverageReports) : null;

      const conformance = compiledFiles.map(({ file }) => resolveConformanceEntry(file, repo));

      const report = buildStatusReport(files, sliceFacts, openIssuesCount, invariants, conformance);
      return textResult(buildStatusJson(report));
    },
  );

  return server;
}
