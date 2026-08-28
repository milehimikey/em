#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { compile, CompileOptions, CompileResult } from "./pipeline.js";
import { isMainModule } from "./util/isMainModule.js";
import { NormalizedModel } from "./model/model.js";
import { RefsResult } from "./model/refs.js";
import { ParseError } from "./parser/parser.js";
import { renderDot, layoutDot, composeSvg, writeRendered, formatFromPath } from "./render/render.js";
import { buildSliceDiagram } from "./render/sliceDiagram.js";
import { resolveSliceArg, defaultSliceOut } from "./cli/render-inputs.js";
import { serializeBuilds, watchFile } from "./render/watch.js";
import { startLiveServer, LiveServer } from "./render/serve.js";
import { formatDiagnostic, hasErrors, Diagnostic } from "./model/validate.js";
import { buildExport, buildSliceExport } from "./emit/json.js";
import { buildValidateJson, buildSliceReadyJson, buildValidateListJson, collectMarkers } from "./emit/validateJson.js";
import { buildDiffJson } from "./emit/diffJson.js";
import { diffModels, formatModelDiff, hasChanges, LineageResolvers } from "./model/diff.js";
import { planDiffArgs, resolveRevision, resolveDocAtRevision } from "./cli/diff-inputs.js";
import { readSliceDoc } from "./catalog/readSliceDoc.js";
import { validateLineage } from "./catalog/lineageValidate.js";
import { validateFrontmatterCoherence } from "./catalog/frontmatterCoherenceValidate.js";
import { validateNoteBindings } from "./catalog/noteBindingValidate.js";
import { validateDocModelConsistency } from "./catalog/docModelConsistencyValidate.js";
import { validateSliceReady, computeSliceReadyGates } from "./catalog/sliceReadyValidate.js";
import { detectSliceDocCollisions } from "./catalog/modelCollisionValidate.js";
import { checkLedger } from "./cli/ledgerCheck.js";
import { planMigration, verifyMigration } from "./cli/migrateReactionShape.js";
import { buildLedgerJson } from "./emit/ledgerJson.js";
import { buildCoverageReport, CoverageReport } from "./cli/coverage.js";
import { buildCoverageJson } from "./emit/coverageJson.js";
import {
  resolveSliceStatusFacts,
  countOpenIssues,
  resolveConformanceEntry,
  aggregateInvariantTotals,
  buildStatusReport,
  formatStatusText,
  formatStatusMarkdown,
  buildStatusBadge,
  SliceStatusFact,
  StatusDiagnostic,
} from "./cli/status.js";
import { buildStatusJson } from "./emit/statusJson.js";
import { planSkillSync, applySkillSync } from "./cli/skillSync.js";
import { checkSkillSync } from "./cli/skillCheck.js";
import { buildSkillCheckJson } from "./emit/skillCheckJson.js";
import { readContract } from "./cli/contract.js";
import { createServer as createMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { syncAgentsMd, AgentsMdResult } from "./cli/agentsMd.js";
import {
  buildGlossary,
  detectKindConflicts,
  detectFieldTypeConflicts,
  hasConflicts,
  formatGlossarySummary,
  formatConflictLine,
  GlossaryModelInput,
} from "./model/glossary.js";
import { buildGlossaryJson, GlossaryFileSide } from "./emit/glossaryJson.js";
import { planGlossaryArgs } from "./cli/glossary-inputs.js";
import { buildCatalog, CatalogModelInput } from "./catalog/build.js";
import { planCatalogArgs } from "./cli/catalog-inputs.js";
import { runSliceIndex } from "./cli/sliceIndex.js";
import { runMarkImplemented } from "./cli/markImplemented.js";
import { runRatify } from "./cli/ratify.js";
import { buildConformScope, changedPathsSince, resolveSliceDocFacts, seedAsisModel } from "./cli/conformScope.js";
import { buildSliceDocContent, isSlicePattern, sliceDocKey, SLICE_PATTERNS } from "./cli/sliceNew.js";
import { listModelCommits, readFileAtCommit, CommitInfo } from "./cli/changelog-git.js";
import { buildChangelog, parseDecisionsLog, ChangelogEntry, ChangelogIntro } from "./emit/changelog.js";
import {
  STATE_FILE_NAME,
  PHASES,
  isPhase,
  loadStateFile,
  parseState,
  setPhase,
  setConformance,
  setReview,
  isValidDateString,
  PatchResult,
} from "./cli/stateFile.js";
import { STARTER_EM, starterEmFor, scaffoldReadme, scaffoldStateFile } from "./templates.js";
import { kebabSlug } from "./util/slug.js";

const program = new Command();

// Single source of truth for the version (also read by src/emit/json.ts for
// `generator.version` in `em export`): package.json, one level up from both
// src/ and dist/.
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

program
  .name("em")
  .description("Event Modeling CLI — slice-first DSL rendered as a strict Graphviz grid")
  .version(PKG_VERSION);

program
  .command("init")
  .description("scaffold a starter .em model")
  .argument("[file]", "output file", "model.em")
  .option("-f, --force", "overwrite if the file exists")
  .action((file: string, opts: { force?: boolean }) => {
    if (existsSync(file) && !opts.force) {
      console.error(`refusing to overwrite ${file} (use --force)`);
      process.exit(1);
    }
    writeFileSync(file, STARTER_EM);
    console.log(`wrote ${file}`);
  });

program
  .command("scaffold")
  .description(
    "scaffold a full project: <slug>/<slug>.em, README.md, .event-modeling.md " +
      "(see docs/cli.md — for just a starter .em, use `em init`; for a multi-model project, " +
      "pass --under to nest it under a shared parent directory)",
  )
  .argument("<name>", "model display name — kebab-cased for the directory and file names, used as-is for titles/prose")
  .option("-f, --force", "overwrite the directory's contents if it already exists")
  .option(
    "--under <dir>",
    "parent directory to scaffold into — writes <dir>/<slug>/ instead of ./<slug>/, the " +
      "supported multi-model layout (docs/cli.md, \"Multi-model projects\"): one directory per " +
      "model, so each model's slices/ never collides with a sibling model's",
  )
  .action(async (name: string, opts: { force?: boolean; under?: string }) => {
    if (name.includes('"') || name.includes("{{")) {
      console.error(
        `em scaffold: name must not contain '"' or '{{' (breaks the generated .em/README/state files): ${name}`,
      );
      process.exit(1);
    }
    const slugName = kebabSlug(name);
    const dirPath = opts.under ? join(opts.under, slugName) : slugName;
    if (existsSync(dirPath) && !opts.force) {
      console.error(`refusing to overwrite ${dirPath}/ (use --force)`);
      process.exit(1);
    }
    await mkdir(dirPath, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dirPath, `${slugName}.em`), starterEmFor(name));
    writeFileSync(join(dirPath, "README.md"), scaffoldReadme(name, slugName));
    writeFileSync(join(dirPath, STATE_FILE_NAME), scaffoldStateFile(name, slugName, today));
    console.log(`scaffolded ${dirPath}/`);
  });

program
  .command("render")
  .description("transpile a model and render it (or emit DOT)")
  .argument("<file>", "input .em file")
  .option("-o, --out <path>", "output path (extension picks the format)")
  .option("-T, --format <fmt>", "output format (svg, png, pdf, ...)")
  .option(
    "--slice <name>",
    "render only this slice, redrawn in its own canonical pattern shape " +
      "(default out: slices/<kebab-slug>.svg)",
  )
  .option("--emit-dot", "print the generated DOT instead of rendering")
  .option("--keep-empty-lanes", "keep the API lane even when empty")
  .action(async (file: string, opts) => {
    if (opts.slice !== undefined && opts.emitDot) {
      console.error("em render: --slice cannot be combined with --emit-dot");
      process.exit(1);
    }

    const { dot, model, grid, diagnostics, refs } = compileFile(file, {
      keepEmptyLanes: opts.keepEmptyLanes,
    });
    // MIL-126: note-binding mismatches read slices/*.md alongside the model, so (like
    // validateLineage/validateFrontmatterCoherence in `em validate`) they're computed here
    // rather than living in compile()'s pure diagnostics. Always warning-severity — folding
    // them in never changes whether rendering proceeds below.
    const allDiagnostics = [...diagnostics, ...validateNoteBindings(model, refs, dirname(file))];
    printDiagnostics(allDiagnostics);
    warnMissingNotes(file, model);

    if (opts.emitDot) {
      if (opts.out) {
        writeFileSync(opts.out, dot);
        console.log(`wrote ${opts.out}`);
      } else {
        process.stdout.write(dot + "\n");
      }
      return;
    }

    if (hasErrors(allDiagnostics)) {
      console.error("not rendering: fix the errors above");
      process.exit(1);
    }

    if (opts.slice !== undefined) {
      const lookup = resolveSliceArg(opts.slice, model.slices);
      if ("error" in lookup) {
        console.error(lookup.error);
        process.exit(1);
      }
      const out = opts.out ?? defaultSliceOut(file, opts.slice);
      const fmt = opts.format ?? formatFromPath(out);
      await mkdir(dirname(out), { recursive: true }); // slices/ may not exist yet
      const { model: sliceModel, grid: sliceGrid, dot: sliceDot } = buildSliceDiagram(model, lookup.index, {
        keepEmptyLanes: opts.keepEmptyLanes,
      });
      const raw = await layoutDot(sliceDot);
      const svg = composeSvg(raw, sliceModel, sliceGrid, dirname(file), dirname(out));
      await writeRendered(svg, out, fmt);
      console.log(`rendered ${out}`);
      return;
    }

    const out = opts.out ?? defaultOut(file, opts.format ?? "svg");
    const fmt = opts.format ?? formatFromPath(out);
    await renderDot(dot, model, grid, out, fmt, dirname(file));
    console.log(`rendered ${out}`);
  });

program
  .command("export")
  .description("export a versioned JSON snapshot of the normalized model")
  .argument("<file>", "input .em file")
  .option("-o, --out <path>", "write to a file instead of stdout")
  .option(
    "--slice <key>",
    "export only this slice's object (pattern/fields/doc) instead of the whole model (export " +
      "key, MIL-128) — refuses only if THIS slice has an error; an unrelated slice's breakage " +
      "elsewhere in the model doesn't block it (see docs/cli.md)",
  )
  .action((file: string, opts: { out?: string; slice?: string }) => {
    const { model, refs, diagnostics, source } = compileFile(file);
    printDiagnostics(diagnostics);

    if (opts.slice) {
      // Scoped export deliberately does NOT reuse the whole-model error guard below: the
      // ticket's own motivation for `--slice` is an agent implementing one already-ratified
      // slice while the rest of a large, still-WIP model has unrelated errors — the same
      // "don't gate on breakage elsewhere" call `--slice-ready` already made (see its own
      // scoping comment above). Only an error that concerns THIS slice (bare key, or an
      // element ref prefixed `<key>/`) refuses.
      const key = opts.slice;
      const scopedErrors = diagnostics.filter(
        (d) => d.severity === "error" && d.refs?.some((r) => r === key || r.startsWith(`${key}/`)),
      );
      if (scopedErrors.length > 0) {
        console.error(`not exporting: slice "${key}" has errors — fix them first`);
        process.exit(1);
      }

      const sliceExport = buildSliceExport(model, refs, diagnostics, source, file, key);
      if (!sliceExport.found) {
        console.error(`em export --slice: no slice with export key "${key}" in this model`);
        process.exit(1);
      }
      printDiagnostics(newDiagnostics(sliceExport.diagnostics, diagnostics));

      if (opts.out) {
        writeFileSync(opts.out, sliceExport.text! + "\n");
        console.log(`wrote ${opts.out}`);
      } else {
        process.stdout.write(sliceExport.text! + "\n");
      }
      return;
    }

    if (hasErrors(diagnostics)) {
      console.error("not exporting: fix the errors above");
      process.exit(1);
    }

    const exported = buildExport(model, refs, diagnostics, source, file);
    printDiagnostics(newDiagnostics(exported.diagnostics, diagnostics));

    if (opts.out) {
      writeFileSync(opts.out, exported.text + "\n");
      console.log(`wrote ${opts.out}`);
    } else {
      process.stdout.write(exported.text + "\n");
    }
  });

program
  .command("diff")
  .description("compare two models structurally (two files, or one file across git revisions)")
  .argument("<old>", "old model file — or the file to diff, when using --from")
  .argument("[new]", "new model file (omit when using --from/--to)")
  .option("--from <rev>", "diff <old> against this git revision instead of a second file")
  .option("--to <rev>", "diff against this git revision instead of the current file (requires --from)")
  .option("--exit-code", "exit 1 if the models differ, 0 if identical (git-diff convention)")
  .option("--json", "print a JSON document instead of the text report (see docs/cli.md)")
  .action(
    (
      oldFile: string,
      newFile: string | undefined,
      opts: { from?: string; to?: string; exitCode?: boolean; json?: boolean },
    ) => {
      const plan = planDiffArgs(oldFile, newFile, opts);
      if ("error" in plan) {
        console.error(plan.error);
        process.exit(1);
      }
      if (plan.form === "files") {
        const oldSource = readFileOrExit(plan.oldFile);
        const newSource = readFileOrExit(plan.newFile);
        const lineage: LineageResolvers = {
          oldDoc: (key) => readSliceDoc(dirname(plan.oldFile), key),
          newDoc: (key) => readSliceDoc(dirname(plan.newFile), key),
        };
        runDiff(oldSource, plan.oldFile, newSource, plan.newFile, opts.exitCode, opts.json, lineage);
        return;
      }
      const oldSource = readAtRevision(plan.file, plan.from);
      const oldLabel = `${plan.file}@${plan.from}`;
      const newSource = plan.to ? readAtRevision(plan.file, plan.to) : readFileOrExit(plan.file);
      const newLabel = plan.to ? `${plan.file}@${plan.to}` : plan.file;
      const lineage: LineageResolvers = {
        oldDoc: (key) => resolveDocAtRevision(plan.file, key, plan.from),
        newDoc: (key) =>
          plan.to ? resolveDocAtRevision(plan.file, key, plan.to) : readSliceDoc(dirname(plan.file), key),
      };
      runDiff(oldSource, oldLabel, newSource, newLabel, opts.exitCode, opts.json, lineage);
    },
  );

program
  .command("glossary")
  .description("cross-model glossary of terms, with consistency checks across models (see docs/cli.md)")
  .argument("<files...>", "input .em files")
  .option("--json", "print the full glossary document instead of the text report")
  .option("-o, --out <path>", "write the JSON document to a file instead of stdout (requires --json)")
  .option("--list-conflicts", "print only the conflict lines, no summary")
  .option(
    "--fail-on-conflicts",
    "exit non-zero if any cross-model term conflicts were found (opt-in — conflicts are warnings and don't block by default)",
  )
  .action(
    (
      files: string[],
      opts: { json?: boolean; out?: string; listConflicts?: boolean; failOnConflicts?: boolean },
    ) => {
      const plan = planGlossaryArgs(opts);
      if ("error" in plan) {
        console.error(plan.error);
        process.exit(1);
      }

      const inputs: GlossaryModelInput[] = [];
      const sources: GlossaryFileSide[] = [];
      let anyErrors = false;
      for (const file of files) {
        const source = readFileOrExit(file);
        const result = compileSource(source, file);
        printDiagnosticsFor(file, result.diagnostics);
        if (hasErrors(result.diagnostics)) anyErrors = true;
        inputs.push({ label: file, model: result.model });
        sources.push({ label: file, source });
      }
      if (anyErrors) {
        console.error("not building glossary: fix the errors above");
        process.exit(1);
      }

      const glossary = buildGlossary(inputs);
      const conflicts = [...detectKindConflicts(glossary), ...detectFieldTypeConflicts(glossary)];

      if (opts.json) {
        const json = buildGlossaryJson(glossary, conflicts, sources);
        if (opts.out) {
          writeFileSync(opts.out, json + "\n");
          console.log(`wrote ${opts.out}`);
        } else {
          process.stdout.write(json + "\n");
        }
      } else if (opts.listConflicts) {
        if (conflicts.length === 0) console.log("no conflicts");
        else for (const c of conflicts) console.log(`  ${formatConflictLine(c)}`);
      } else {
        console.log(formatGlossarySummary(glossary, conflicts));
      }

      // Same rationale as em diff's --exit-code: set the code rather than
      // process.exit() so stdout to a pipe (a large --json -o document) can't
      // be truncated.
      if (opts.failOnConflicts && hasConflicts(conflicts)) process.exitCode = 1;
    },
  );

program
  .command("catalog")
  .description("generate a browsable static HTML catalog site over one or more .em models (see docs/cli.md)")
  .argument("<files...>", "input .em files")
  .option("-o, --out <dir>", "output directory", "catalog")
  .option("-T, --format <fmt>", "diagram format embedded in the catalog (svg or png)", "svg")
  .option("--title <text>", "catalog site title", "Event Model Catalog")
  .option("--keep-empty-lanes", "keep the API lane even when empty")
  .action(
    async (
      files: string[],
      opts: { out: string; format: string; title: string; keepEmptyLanes?: boolean },
    ) => {
      const plan = planCatalogArgs(opts);
      if ("error" in plan) {
        console.error(plan.error);
        process.exit(1);
      }

      const inputs: CatalogModelInput[] = [];
      // Tracked so the post-buildCatalog print below can skip diagnostics already printed
      // here (ref-collision warnings now live in compileFile()'s own `diagnostics`, and
      // buildCatalog() forwards those same, reference-identical objects rather than
      // recomputing them — printing both lists unfiltered would double-print them).
      const diagnosticsByFile = new Map<string, Diagnostic[]>();
      let anyErrors = false;
      for (const file of files) {
        const { dot, model, grid, diagnostics, refs } = compileFile(file, { keepEmptyLanes: opts.keepEmptyLanes });
        printDiagnosticsFor(file, diagnostics);
        diagnosticsByFile.set(file, diagnostics);
        warnMissingNotes(file, model);
        if (hasErrors(diagnostics)) anyErrors = true;
        inputs.push({ file, model, grid, dot, refs });
      }
      if (anyErrors) {
        console.error("not building catalog: fix the errors above");
        process.exit(1);
      }

      const result = await buildCatalog(inputs, {
        outDir: opts.out,
        format: plan.format,
        title: opts.title,
        keepEmptyLanes: opts.keepEmptyLanes,
      });
      for (const d of result.diagnostics) {
        const already = diagnosticsByFile.get(d.file) ?? [];
        printDiagnosticsFor(d.file, newDiagnostics(d.diagnostics, already));
      }
      const modelWord = result.models === 1 ? "model" : "models";
      const sliceWord = result.slices === 1 ? "slice" : "slices";
      console.log(`wrote ${opts.out}/ (${result.models} ${modelWord}, ${result.slices} ${sliceWord})`);
    },
  );

// Namespace for slice-doc authoring/maintenance subcommands: `new` (MIL-97, scaffolds a fresh
// slice doc's frontmatter) and `index` (MIL-98, regenerates the model README's Slices table)
// share the `em slice <verb>` shape rather than living as separate top-level commands.
const slice = program.command("slice").description("author and maintain slice docs");

slice
  .command("new")
  .description(
    "scaffold a fresh slices/<key>.md doc — the 5 frontmatter keys required at `status: draft` " +
      "plus the `# Slice:` heading and diagram-image stub; judgment sections (Intent, " +
      "Scenarios, Open Questions, ...) stay hand-authored (see docs/slice-doc-schema.md, " +
      "templates/slice.md)",
  )
  .argument("<name>", "slice display name (e.g. \"Request Payment\") — kebab-cased for the filename")
  .requiredOption("--pattern <pattern>", `slice pattern: ${SLICE_PATTERNS.join(" | ")}`)
  .requiredOption("--swimlane <swimlane>", 'swimlane, e.g. "Persona → Context"')
  .option("-f, --force", "overwrite the file if it already exists")
  .action((name: string, opts: { pattern: string; swimlane: string; force?: boolean }) => {
    if (!isSlicePattern(opts.pattern)) {
      console.error(
        `em slice new: invalid --pattern "${opts.pattern}" — expected one of: ${SLICE_PATTERNS.join(", ")}`,
      );
      process.exit(1);
    }

    const key = sliceDocKey(name);
    const dir = "slices";
    const path = join(dir, `${key}.md`);
    if (existsSync(path) && !opts.force) {
      console.error(`refusing to overwrite ${path} (use --force)`);
      process.exit(1);
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buildSliceDocContent(name, key, opts.pattern, opts.swimlane));
    console.log(`wrote ${path}`);
    console.log(`add this to the slice's primary element in the .em file:`);
    console.log(`  note "${path}"`);
  });

slice
  .command("index")
  .description(
    "rewrite the model's sibling README.md's GENERATED Slices table from `em export`'s slice " +
      "facts (key, pattern, doc status/implementedIn) — the hand-maintained table is deprecated",
  )
  .argument("<file>", "input .em file")
  .option("--check", "verify the table is current; exit non-zero on drift without writing (CI)")
  .action((file: string, opts: { check?: boolean }) => {
    const { model, diagnostics, refs } = compileFile(file);
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) {
      console.error("not indexing: fix the errors above");
      process.exit(1);
    }

    const result = runSliceIndex(model, refs, file, !!opts.check);
    printDiagnostics(newDiagnostics(result.table.diagnostics, diagnostics));

    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    if (result.wrote) {
      console.log(`wrote ${result.readmePath}`);
    } else {
      console.log(`ok — ${result.readmePath}'s Slices table is already up to date`);
    }
  });

slice
  .command("mark-implemented")
  .description(
    "flip a slice doc's frontmatter to `status: implemented` / `implementedIn: <pr-url>` — the " +
      "one edit an implementing agent makes to a ratified doc at merge (MIL-103, replaces the " +
      "em-sdd-bridge `em-sdd-mark-implemented` script; see reference/implement.md §6). " +
      "Idempotent on the same URL; refuses to overwrite a different one; never touches `version:` " +
      "or the doc body",
  )
  .argument("<file>", "input .em file")
  .argument("<slice-key>", "slice export key (kebab-case)")
  .argument("<pr-url>", "merged PR (or commit) URL")
  .action((file: string, sliceKey: string, prUrl: string) => {
    const { model, refs, diagnostics } = compileFile(file);
    printDiagnostics(diagnostics);

    // Scoped the same way `em export --slice`/`em validate --slice-ready` are: only an error
    // concerning THIS slice (bare key, or an element ref prefixed `<key>/`) refuses — an
    // unrelated slice's breakage elsewhere in a large, still-WIP model doesn't block marking
    // this one implemented.
    const scopedErrors = diagnostics.filter(
      (d) => d.severity === "error" && d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)),
    );
    if (scopedErrors.length > 0) {
      console.error(`em slice mark-implemented: slice "${sliceKey}" has errors — fix them first`);
      process.exit(1);
    }

    const result = runMarkImplemented(model, refs, dirname(file), sliceKey, prUrl);
    if (!result.ok) {
      console.error(`em slice mark-implemented: ${result.message}`);
      process.exit(1);
    }
    console.log(
      result.changed
        ? `marked implemented: ${result.path} (implementedIn: ${prUrl})`
        : `already implemented (no-op): ${result.path}`,
    );
  });

slice
  .command("ratify")
  .description(
    "flip a slice doc's frontmatter to `status: ready-to-implement` and record `ratifiedBy:`/" +
      "`ratifiedOn:` — the handoff sign-off (MIL-165, docs/process.md#what-ratified-means) that " +
      "makes who ratified, and when, a first-class recorded fact. Idempotent on the same " +
      "--by/--on pair; refuses to overwrite a different one already recorded; never touches " +
      "`version:` or the doc body",
  )
  .argument("<file>", "input .em file")
  .argument("<slice-key>", "slice export key (kebab-case)")
  .requiredOption("--by <name>", "the ratifier's name")
  .option("--on <date>", "ratification date, YYYY-MM-DD (default: today)")
  .action((file: string, sliceKey: string, opts: { by: string; on?: string }) => {
    const { model, refs, diagnostics } = compileFile(file);
    printDiagnostics(diagnostics);

    // Scoped the same way `em slice mark-implemented`/`em export --slice`/`em validate
    // --slice-ready` are: only an error concerning THIS slice refuses.
    const scopedErrors = diagnostics.filter(
      (d) => d.severity === "error" && d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)),
    );
    if (scopedErrors.length > 0) {
      console.error(`em slice ratify: slice "${sliceKey}" has errors — fix them first`);
      process.exit(1);
    }

    const today = new Date().toISOString().slice(0, 10);
    const ratifiedOn = opts.on ?? today;
    if (opts.on !== undefined && !isValidDateString(opts.on)) {
      console.error(`em slice ratify: invalid --on date "${opts.on}" — expected YYYY-MM-DD`);
      process.exit(1);
    }

    const result = runRatify(model, refs, dirname(file), sliceKey, opts.by, ratifiedOn);
    if (!result.ok) {
      console.error(`em slice ratify: ${result.message}`);
      process.exit(1);
    }
    console.log(
      result.changed
        ? `ratified: ${result.path} (ratifiedBy: ${opts.by}, ratifiedOn: ${ratifiedOn})`
        : `already ratified (no-op): ${result.path}`,
    );
  });

program
  .command("changelog")
  .description("render a model's git history as a business-readable ledger (see docs/cli.md)")
  .argument("<file>", "input .em file (must be tracked in git)")
  .option("--from <rev>", "start the walk at this revision (inclusive)")
  .option("--to <rev>", "end the walk at this revision (inclusive; default HEAD)")
  .option("-o, --out <path>", "write to a file instead of stdout")
  .action((file: string, opts: { from?: string; to?: string; out?: string }) => {
    const commitsResult = listModelCommits(file, { from: opts.from, to: opts.to });
    if (!commitsResult.ok) {
      console.error(commitsResult.message);
      process.exit(1);
    }
    const markdown = buildChangelogDoc(file, commitsResult.repoRoot, commitsResult.commits);

    if (opts.out) {
      writeFileSync(opts.out, markdown + "\n");
      console.log(`wrote ${opts.out}`);
    } else {
      process.stdout.write(markdown + "\n");
    }
  });

const STATE_DIR_HELP =
  "model directory containing .event-modeling.md, or a direct path to that file (default: current directory)";

/** Shared by every `em state` writer: load, apply the pure patch, write, report — the only
 *  difference between set-phase/set-conformance/set-review is which `mutate` closure they pass. */
function writeStateUpdate(dirOrFile: string, cmdLabel: string, mutate: (text: string, today: string) => PatchResult): void {
  const loaded = loadStateFile(dirOrFile);
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = mutate(loaded.text, today);
  if (!result.ok) {
    console.error(`${cmdLabel}: ${result.message}`);
    process.exit(1);
  }
  writeFileSync(loaded.path, result.text);
  console.log(`wrote ${loaded.path}`);
}

const state = program
  .command("state")
  .description("read/write the state file's mechanical fields deterministically (see docs/cli.md)");

state
  .command("read")
  .description("print the state file's mechanical fields as JSON")
  .argument("[dir]", STATE_DIR_HELP, ".")
  .action((dir: string) => {
    const loaded = loadStateFile(dir);
    if (!loaded.ok) {
      console.error(loaded.message);
      process.exit(1);
    }
    const parsed = parseState(loaded.text);
    if (!parsed.ok) {
      console.error(`em state read: ${parsed.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(parsed.state, null, 2));
  });

state
  .command("set-phase")
  .description("rewrite Current phase: (and Last updated:); --step also rewrites Current step:")
  .argument("<phase>", `phase: ${PHASES.join(" | ")}`)
  .argument("[dir]", STATE_DIR_HELP, ".")
  .option("--step <n>", "also set Current step: to this value")
  .action((phase: string, dir: string, opts: { step?: string }) => {
    if (!isPhase(phase)) {
      console.error(`em state set-phase: invalid phase "${phase}" — expected one of: ${PHASES.join(", ")}`);
      process.exit(1);
    }
    writeStateUpdate(dir, "em state set-phase", (text, today) => setPhase(text, phase, today, opts.step));
  });

state
  .command("set-conformance")
  .description("rewrite Last conformance: (and Last updated:) in the exact format reference/conform.md parses")
  .argument("<revision>", "target-repo revision just diffed against")
  .argument("[dir]", STATE_DIR_HELP, ".")
  .requiredOption("--report <path>", "path to the conformance report just written")
  .action((revision: string, dir: string, opts: { report: string }) => {
    writeStateUpdate(dir, "em state set-conformance", (text, today) => setConformance(text, revision, opts.report, today));
  });

state
  .command("set-review")
  .description("rewrite Last stakeholder review: (and Last updated:)")
  .argument("<date>", "review date, YYYY-MM-DD")
  .argument("[dir]", STATE_DIR_HELP, ".")
  .action((date: string, dir: string) => {
    if (!isValidDateString(date)) {
      console.error(`em state set-review: invalid date "${date}" — expected YYYY-MM-DD`);
      process.exit(1);
    }
    writeStateUpdate(dir, "em state set-review", (text, today) => setReview(text, date, today));
  });

program
  .command("conform-scope")
  .description(
    "mechanize conform phase step 1 (reference/conform.md): map the target repo's changed paths " +
      "since Last conformance: to slices via each slice doc's implementedIn, JSON to stdout — " +
      "--seed-asis also seeds the <model>-asis.em scratch model (see docs/cli.md)",
  )
  .argument("<file>", "input .em file")
  .requiredOption("--repo <path>", "path to (or inside) the target codebase's git repository")
  .option("--full", "ignore Last conformance:/changed paths; scope every implemented slice")
  .option("--seed-asis", "write <model>-asis.em as a byte copy of the canonical model and ensure it's gitignored")
  .action((file: string, opts: { repo: string; full?: boolean; seedAsis?: boolean }) => {
    const { model, diagnostics, refs } = compileFile(file);
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) {
      console.error("not scoping: fix the errors above");
      process.exit(1);
    }

    const loaded = loadStateFile(dirname(file));
    if (!loaded.ok) {
      console.error(loaded.message);
      process.exit(1);
    }
    const parsed = parseState(loaded.text);
    if (!parsed.ok) {
      console.error(`em conform-scope: ${parsed.message}`);
      process.exit(1);
    }
    const { lastConformance } = parsed.state;

    const { facts, diagnostics: docDiags } = resolveSliceDocFacts(model, refs, dirname(file));
    printDiagnostics(newDiagnostics(docDiags, diagnostics));

    const skipGit = !!opts.full || lastConformance === null;
    let changedPaths: string[] = [];
    if (!skipGit) {
      const result = changedPathsSince(opts.repo, lastConformance!.revision);
      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }
      changedPaths = result.paths;
    }

    const scope = buildConformScope(facts, lastConformance, changedPaths, !!opts.full);
    const output: Record<string, unknown> = { ...scope };
    if (opts.seedAsis) {
      output.seeded = seedAsisModel(file);
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("watch")
  .description("re-render on every save")
  .argument("<file>", "input .em file")
  .option("-o, --out <path>", "output path (extension picks the format)")
  .option("-T, --format <fmt>", "output format (svg, png, pdf, ...)")
  .option("--keep-empty-lanes", "keep the API lane even when empty")
  .option("--serve", "serve a live viewer with instant push-reload (no polling)")
  .option("--port <n>", "port for --serve (default 5173)", (v) => parseInt(v, 10))
  .action(async (file: string, opts) => {
    const out = opts.out ?? defaultOut(file, opts.format ?? "svg");
    const fmt = opts.format ?? formatFromPath(out);

    let server: LiveServer | undefined;

    // serializeBuilds: chokidar can fire several events for one save (and an
    // editor's write can land while a slow png/pdf render is still in flight) —
    // overlapping builds would race each other writing the same output file.
    const build = serializeBuilds(async () => {
      const started = Date.now();
      try {
        const { dot, model, grid, diagnostics } = compileFile(
          file,
          { keepEmptyLanes: opts.keepEmptyLanes },
          // A bad save must not kill the watcher: the error is reported below
          // and pushed to the live view's banner instead.
          { survive: true },
        );
        printDiagnostics(diagnostics);
        warnMissingNotes(file, model);
        if (hasErrors(diagnostics)) {
          console.error("skipped render (errors above)");
          // The shared screen must say WHY it's stale, not silently show an
          // outdated model — push the first error into the viewer's banner.
          const first = diagnostics.find((d) => d.severity === "error");
          server?.notifyError(first ? formatDiagnostic(first).trim() : "model has errors — see terminal");
          return;
        }
        await renderDot(dot, model, grid, out, fmt, dirname(file));
        console.log(`rendered ${out} (${Date.now() - started}ms)`);
        server?.notify();
      } catch (e) {
        reportError(e);
        server?.notifyError(e instanceof Error ? e.message : String(e));
      }
    });

    await build();

    if (opts.serve) {
      try {
        // Serve the directory the SVG is written to — that's what the browser
        // fetches, and note "..." links inside the SVG resolve relative to it.
        server = await startLiveServer({ dir: dirname(resolve(out)), port: opts.port });
        // The viewer inlines SVG only — for png/pdf watches there's nothing
        // live to embed, so don't print a ?svg= URL that can't work.
        if (fmt === "svg") {
          console.log(`→ live view: ${server.url}/?svg=${encodeURIComponent(basename(out))}`);
          console.log("  open it in a browser and share your screen");
        } else {
          console.log(`→ serving ${dirname(resolve(out))} at ${server.url}`);
          console.log("  (the live viewer needs an .svg output — add -o <name>.svg to use it)");
        }
      } catch (e) {
        reportError(e);
      }
    }

    // Also watch slice design docs (slices/*.md): editing just a doc's Status
    // line should live-update the diagram's header colors without touching
    // the .em file. The glob still fires for docs authored after watch starts.
    watchFile([file, join(dirname(file), "slices", "*.md")], build);
    console.log(`watching ${file} … (ctrl-c to stop)`);
    if (!opts.serve) console.log("tip: add --serve for the live browser view");
  });

program
  .command("validate")
  .description("check a model against event-modeling rules")
  .argument("<file>", "input .em file")
  // MIL-123: Commander accepts excess positional args by default, silently dropping
  // everything past <file> — `em validate a.em b.em c.em` looked like it validated all
  // three but only ever checked a.em. Fail loudly instead of under-checking silently.
  .allowExcessArguments(false)
  .option("--list-issues", "print only open `issue` diagnostics (slice, element, line, text)")
  .option(
    "--list-divergences",
    "print only accepted-divergence annotations (slice, element, line, text) — never fails the build",
  )
  .option(
    "--list-public",
    "print only events and views marked `public` (slice, kind, name, line) — an integration-surface audit, never fails the build",
  )
  .option(
    "--fail-on-issues",
    "exit non-zero if the model has any open `issue`s (opt-in — issues are warnings and don't block by default)",
  )
  .option(
    "--slice-ready <key>",
    "readiness gate for one slice (export key): status ready-to-implement, doc resolvable via " +
      "note binding, zero unchecked Open Questions — exits non-zero if not ready (MIL-87)",
  )
  .option(
    "--json",
    "print a JSON document instead of text — works on a model WITH errors, unlike `em export` " +
      "(MIL-128, see docs/cli.md); exit codes are unchanged",
  )
  .action(
    (
      file: string,
      opts: {
        listIssues?: boolean;
        listDivergences?: boolean;
        listPublic?: boolean;
        failOnIssues?: boolean;
        sliceReady?: string;
        json?: boolean;
      },
    ) => {
      const { model, diagnostics, refs } = compileFile(file);
      // Lineage-ref resolution (MIL-84), frontmatter-coherence (MIL-85), note-binding
      // mismatches (MIL-126), and doc↔model consistency (MIL-124) are validate's fs-aware
      // rules — every other check above is a pure function of the .em source. All four read
      // slices/*.md alongside the model. Doc↔model consistency is deliberately validate-only
      // (unlike note-binding, which `em render` also folds in) — it's a conform-phase concern,
      // not something every render needs to recheck.
      const allDiagnostics = [
        ...diagnostics,
        ...validateLineage(model, refs, dirname(file)),
        ...validateFrontmatterCoherence(model, refs, dirname(file)),
        ...validateNoteBindings(model, refs, dirname(file)),
        ...validateDocModelConsistency(model, refs, dirname(file)),
      ];
      if (opts.sliceReady) {
        // MIL-87: a targeted, single-slice readiness gate, not part of the unconditional
        // diagnostic set above (see sliceReadyValidate.ts's header for why). Folds in MIL-85's
        // frontmatter-coherence findings, MIL-126's note-binding-mismatch findings, AND MIL-124's
        // doc-model-consistency findings for free by filtering allDiagnostics' own refs, rather
        // than re-deriving any of those classifications here.
        //
        // "Concerns this slice" means a ref that either IS the bare slice key (lineage,
        // frontmatter-coherence, note-binding, and this module's own diagnostics all tag that
        // way) OR starts with `<sliceKey>/` (every element-level ref from computeRefs()/model/validate.ts,
        // e.g. an unknown-event error on a view inside this slice). An earlier version gated on
        // "any error anywhere in the model," which silently failed the check — with zero
        // diagnostics printed — on an unrelated slice's breakage; scoping to this slice alone
        // matches the ticket's own scenario (check one slice while the rest of a large model is
        // still WIP) and this module's own "single-slice" framing.
        const readyDiagnostics = validateSliceReady(model, refs, dirname(file), opts.sliceReady);
        const combined = [...allDiagnostics, ...readyDiagnostics];
        const key = opts.sliceReady;
        const scoped = combined.filter((d) => d.refs?.some((r) => r === key || r.startsWith(`${key}/`)));
        printDiagnostics(scoped);
        const ready = scoped.length === 0;
        if (opts.json) {
          // MIL-128: the 4 named gates (see computeSliceReadyGates) plus the same `scoped`
          // diagnostics and `ready` verdict driving the exit code below — replaces both the
          // scraped warning prose and the two hand-parsed English sentences.
          const gates = computeSliceReadyGates(model, refs, dirname(file), key);
          process.stdout.write(buildSliceReadyJson(file, key, gates, scoped, ready) + "\n");
        } else {
          console.log(ready ? `slice "${key}" is ready-to-implement` : `slice "${key}" is NOT ready-to-implement`);
        }
        if (!ready) process.exit(1);
        return;
      }
      if (opts.listIssues || opts.listDivergences || opts.listPublic) {
        // Errors still fail the run below — surface them rather than exiting
        // non-zero with nothing but the list on screen.
        const errorsOnly = allDiagnostics.filter((d) => d.severity === "error");
        if (opts.json) {
          const markers = collectMarkers(model, refs, {
            issues: opts.listIssues,
            divergences: opts.listDivergences,
            public: opts.listPublic,
          });
          printDiagnostics(errorsOnly);
          process.stdout.write(buildValidateListJson(file, markers, errorsOnly) + "\n");
        } else {
          if (opts.listIssues) printIssues(model);
          if (opts.listDivergences) printDivergences(model);
          if (opts.listPublic) printPublicElements(model);
          printDiagnostics(errorsOnly);
        }
      } else if (opts.json) {
        printDiagnostics(allDiagnostics);
        process.stdout.write(buildValidateJson(file, allDiagnostics) + "\n");
      } else {
        printDiagnostics(allDiagnostics);
        if (allDiagnostics.length === 0) console.log("ok — no issues");
      }
      if (hasErrors(allDiagnostics)) process.exit(1);
      if (opts.failOnIssues && model.elements.some((el) => el.issue)) process.exit(1);
    },
  );

program
  .command("migrate")
  .description(
    "rewrite the old two-slice Automation/Translation shape into the merged single-slice " +
      "shape MIL-120 made canonical (see docs/cli.md)",
  )
  .argument("<file>", "input .em file")
  .option("--write", "apply the rewrite to the file (default: dry run — report only, write nothing)")
  .action((file: string, opts: { write?: boolean }) => {
    const source = readFileOrExit(file);
    let plan;
    try {
      plan = planMigration(source);
    } catch (e) {
      if (e instanceof ParseError) {
        console.error(`parse error in ${file} ${e.message}`);
        process.exit(1);
      }
      throw e;
    }

    if (plan.changes.length === 0 && plan.refusals.length === 0) {
      console.log(`nothing to migrate — ${file} has no old two-slice Automation/Translation shape`);
      return;
    }

    if (plan.changes.length > 0) {
      const verify = verifyMigration(source, plan.rewritten!);
      if (!verify.ok) {
        console.error(
          `em migrate: aborting — the rewrite would introduce ${verify.newErrors.length} new error(s):`,
        );
        for (const d of verify.newErrors) console.error(`  ${formatDiagnostic(d)}`);
        console.error(`${file} left untouched`);
        process.exit(1);
      }
    }

    for (const c of plan.changes) console.log(c.message);
    for (const r of plan.refusals) console.log(r.message);

    if (plan.changes.length === 0) {
      console.log(`0 site(s) migrated, ${plan.refusals.length} refused`);
    } else if (opts.write) {
      writeFileSync(file, plan.rewritten!);
      const refusedNote = plan.refusals.length > 0 ? `, ${plan.refusals.length} refused` : "";
      console.log(`wrote ${file} — ${plan.changes.length} site(s) migrated${refusedNote}`);
    } else {
      const refusedNote = plan.refusals.length > 0 ? `; ${plan.refusals.length} refused` : "";
      console.log(
        `${plan.changes.length} site(s) would migrate (dry run — re-run with --write to apply)${refusedNote}`,
      );
    }

    // A refusal always means the file still needs a human, whether or not other sites in the
    // same run migrated cleanly — same "set exitCode, don't truncate stdout" rationale as
    // em ledger/em diff, even though migrate's own output is never large.
    if (plan.refusals.length > 0) process.exitCode = 1;
  });

program
  .command("ledger")
  .description(
    "check slice docs' version: field agrees with their content across two git revisions " +
      "(opt-in CI check, MIL-89 — never part of `em validate`, see docs/ci.md)",
  )
  .argument("<file>", "anchor .em file — locates slices/ relative to it; never parsed")
  .option("--from <rev>", "baseline revision")
  .option("--to <rev>", "compare revision (default: current working tree)")
  .option("--json", "print a JSON document instead of the text report (see docs/cli.md)")
  .action((file: string, opts: { from?: string; to?: string; json?: boolean }) => {
    if (!opts.from) {
      console.error("em ledger: --from <rev> is required");
      process.exit(1);
    }
    const to = opts.to ?? null;
    const result = checkLedger(file, opts.from, to);

    if (opts.json) {
      process.stdout.write(buildLedgerJson(result, opts.from, to) + "\n");
    } else {
      for (const f of result.findings) console.log(f.message);
      if (result.findings.length === 0) {
        console.log(`ok — ledger agrees (${result.checkedCount} slice doc(s) checked)`);
      } else {
        console.log(`${result.findings.length} ledger mismatch(es)`);
      }
    }

    // Set the code rather than process.exit(): same rationale as em diff/em glossary — stdout
    // to a pipe (a --json document) shouldn't risk truncation.
    if (result.findings.length > 0) process.exitCode = 1;
  });

program
  .command("coverage")
  .description(
    "check that every INV-* invariant ID cited in a ready-to-implement/implemented slice doc " +
      "is cited by a test under --tests <dir> (MIL-130) — mechanizes reference/implement.md's " +
      "definition-of-done citation check; advisory by default, --strict for CI",
  )
  .argument("<file>", "input .em file")
  .requiredOption("--tests <dir>", "directory to scan recursively for test files citing invariant IDs")
  .option("--strict", "exit non-zero if any invariant ID has zero citations (CI)")
  .option("--json", "print a JSON document instead of the text report (see docs/cli.md)")
  .action((file: string, opts: { tests: string; strict?: boolean; json?: boolean }) => {
    const { model, diagnostics, refs } = compileFile(file);
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) {
      console.error("em coverage: model has errors — fix them first");
      process.exit(1);
    }
    if (!existsSync(opts.tests)) {
      console.error(`em coverage: --tests directory not found: ${opts.tests}`);
      process.exit(1);
    }
    if (!statSync(opts.tests).isDirectory()) {
      console.error(`em coverage: --tests is not a directory: ${opts.tests}`);
      process.exit(1);
    }

    const report = buildCoverageReport(model, refs, dirname(file), opts.tests);

    if (opts.json) {
      process.stdout.write(buildCoverageJson(file, opts.tests, report) + "\n");
    } else {
      for (const slice of report.slices) {
        if (!slice.inScope) continue;
        console.log(`slice "${slice.key}" (${slice.status}):`);
        if (slice.invariants.length === 0) {
          console.log(`  (no INV-* invariant IDs found in the doc body)`);
          continue;
        }
        for (const inv of slice.invariants) {
          if (inv.cited) {
            console.log(`  cited     ${inv.id}`);
            for (const c of inv.citations) console.log(`              ${c.file}:${c.line}`);
          } else {
            console.log(`  uncovered ${inv.id}`);
          }
        }
      }
      console.log(`${report.totalInvariants} invariant(s) checked, ${report.uncoveredCount} uncovered`);
    }

    // Advisory by default (exit 0 even with uncovered IDs) — --strict is the opt-in CI gate,
    // same "set exitCode, don't truncate stdout" rationale as em ledger/em diff for the --json
    // form, and consistent for the text form too.
    if (opts.strict && report.uncoveredCount > 0) process.exitCode = 1;
  });

program
  .command("status")
  .description(
    "deterministic state-of-the-system rollup over one or more .em models: slices by " +
      "lifecycle status, driftSignal breakdown, invariant coverage totals (with --tests), " +
      "open issue markers + unchecked Open Questions, and last-conformance commits-behind-HEAD " +
      "(MIL-163, see docs/cli.md)",
  )
  .argument("<files...>", "input .em files")
  .option("--tests <dir>", "directory to scan for INV-* test citations — enables invariant coverage totals")
  .option("--repo <path>", "git repo to compute commits-behind-HEAD in (default: each model's own directory)")
  .option("--json", "print a JSON document instead of the text report (see docs/cli.md)")
  .option("--md", "print a markdown block suited for README embedding")
  .option("--badge", "print a generated SVG badge")
  .option("-o, --out <path>", "write output to a file instead of stdout")
  .action(
    (
      files: string[],
      opts: { tests?: string; repo?: string; json?: boolean; md?: boolean; badge?: boolean; out?: string },
    ) => {
      const modesSelected = [opts.json, opts.md, opts.badge].filter(Boolean).length;
      if (modesSelected > 1) {
        console.error("em status: --json, --md, and --badge are mutually exclusive");
        process.exit(1);
      }
      if (opts.tests) {
        if (!existsSync(opts.tests)) {
          console.error(`em status: --tests directory not found: ${opts.tests}`);
          process.exit(1);
        }
        if (!statSync(opts.tests).isDirectory()) {
          console.error(`em status: --tests is not a directory: ${opts.tests}`);
          process.exit(1);
        }
      }

      const compiled: Array<{ file: string; model: NormalizedModel; refs: RefsResult }> = [];
      let anyErrors = false;
      for (const file of files) {
        const { model, refs, diagnostics } = compileFile(file);
        printDiagnosticsFor(file, diagnostics);
        if (hasErrors(diagnostics)) anyErrors = true;
        compiled.push({ file, model, refs });
      }
      if (anyErrors) {
        console.error("em status: not reporting status — fix the errors above");
        process.exit(1);
      }

      const sliceFacts: SliceStatusFact[] = [];
      const statusDiagnostics: StatusDiagnostic[] = [];

      // MIL-160: a multi-model run is exactly the case where two `.em` files could share a
      // directory and collide on a slice key — checked once, up front, over every compiled
      // input (never fatal, same "warn, don't block" posture as the doc-join diagnostics below).
      const collisions = detectSliceDocCollisions(compiled.map(({ file, refs }) => ({ file, sliceKeys: refs.sliceKeys })));
      for (const d of collisions) {
        const file = d.refs?.[2] ?? files[0];
        printDiagnosticsFor(file, [d]);
        statusDiagnostics.push({ file, ...d });
      }

      let openIssuesCount = 0;
      const coverageReports: CoverageReport[] = [];
      for (const { file, model, refs } of compiled) {
        const baseDir = dirname(file);
        const { facts, diagnostics: docDiags } = resolveSliceStatusFacts(file, model, refs, baseDir);
        printDiagnosticsFor(file, docDiags);
        sliceFacts.push(...facts);
        for (const d of docDiags) statusDiagnostics.push({ file, ...d });
        openIssuesCount += countOpenIssues(model);
        if (opts.tests) coverageReports.push(buildCoverageReport(model, refs, baseDir, opts.tests));
      }
      const invariants = opts.tests ? aggregateInvariantTotals(opts.tests, coverageReports) : null;

      const conformance = compiled.map(({ file }) => resolveConformanceEntry(file, opts.repo));

      const report = buildStatusReport(files, sliceFacts, openIssuesCount, invariants, conformance, statusDiagnostics);

      let output: string;
      if (opts.json) output = buildStatusJson(report);
      else if (opts.md) output = formatStatusMarkdown(report);
      else if (opts.badge) output = buildStatusBadge(report);
      else output = formatStatusText(report);

      if (opts.out) {
        writeFileSync(opts.out, output + "\n");
        console.log(`wrote ${opts.out}`);
      } else {
        process.stdout.write(output + "\n");
      }
    },
  );

// Shared by install/sync/check: the skill directory bundled with whatever em package is
// actually running (works whether em was installed from npm or run from a checkout, and
// regardless of a symlinked global install — see pkgDir's own resolution above for
// PKG_VERSION) and the skill directory a consumer repo vendors it into.
function packagedSkillDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills", "event-modeling");
}
function vendoredSkillDir(repoRoot: string): string {
  return join(resolve(repoRoot), ".claude", "skills", "event-modeling");
}

program
  .command("contract")
  .description(
    "print the packaged implementation contract (reference/implement.md) to stdout — the " +
      "agent-neutral discovery path for any agent that can run a shell, not just Claude Code " +
      "(MIL-129); see docs/cli.md",
  )
  .action(() => {
    process.stdout.write(readContract(packagedSkillDir()));
  });

program
  .command("mcp")
  .description(
    "start an MCP (Model Context Protocol) server over stdio, exposing validate/slice_ready/" +
      "list_markers/export_model/export_slice/coverage/contract as tools (MIL-21) — a " +
      "structured, agent-facing alternative to shelling out to `em`; see docs/mcp.md. " +
      "Equivalent to running the `em-mcp` bin directly",
  )
  .action(async () => {
    // A 3-line wrapper only, for discoverability — the server itself (src/mcp/) never imports
    // this file or commander, matching the ticket's "outside the CLI core" constraint. The
    // `em-mcp` bin (package.json) starts the identical server the same way.
    await createMcpServer().connect(new StdioServerTransport());
  });

/** One line reporting what `syncAgentsMd` did, shared by `skill install`/`skill sync` so both
 *  commands describe the AGENTS.md write in the same words. */
function agentsMdMessage(result: AgentsMdResult): string {
  if (result.created) return `created ${result.path} with the agent-contract section (MIL-129)`;
  if (result.wrote) return `updated the agent-contract section in ${result.path}`;
  return `${result.path} already has an up-to-date agent-contract section`;
}

const skill = program
  .command("skill")
  .description("manage Claude Code skills bundled with em");

skill
  .command("install")
  .description("copy the event-modeling skill into .claude/skills/event-modeling/")
  .option("-f, --force", "overwrite an existing installation")
  .option(
    "--no-agents-md",
    "skip writing/updating the AGENTS.md agent-contract section (on by default, MIL-129)",
  )
  .action(async (opts: { force?: boolean; agentsMd?: boolean }) => {
    const src = packagedSkillDir();
    const dest = vendoredSkillDir(process.cwd());

    if (existsSync(dest) && !opts.force) {
      console.log(`skill already installed at ${dest}`);
      console.log("re-run with --force to overwrite");
    } else {
      await mkdir(join(process.cwd(), ".claude", "skills"), { recursive: true });
      await cp(src, dest, { recursive: true });
      console.log(`installed event-modeling skill → ${dest}`);
      console.log("in Claude Code, run /event-modeling to start a guided session");
    }

    if (opts.agentsMd !== false) {
      console.log(agentsMdMessage(syncAgentsMd(process.cwd())));
    }
  });

skill
  .command("sync")
  .description(
    "update the vendored .claude/skills/event-modeling/ copy in [path] to match the installed " +
      "em package (overwrites unconditionally; local edits are never merged, MIL-93)",
  )
  .argument("[path]", "consumer repo root", ".")
  .option(
    "--no-agents-md",
    "skip writing/updating the AGENTS.md agent-contract section (on by default, MIL-129)",
  )
  .action(async (path: string, opts: { agentsMd?: boolean }) => {
    const packagedDir = packagedSkillDir();
    const vendoredDir = vendoredSkillDir(path);

    const plan = planSkillSync(packagedDir, vendoredDir);
    if (plan.changes.length === 0) {
      console.log(`up to date — ${vendoredDir} already matches the installed skill (${plan.unchangedCount} file(s))`);
    } else {
      applySkillSync(plan, packagedDir, vendoredDir);
      for (const c of plan.changes) console.log(`${c.kind}: ${c.relPath}`);
      console.log(`synced ${vendoredDir} — ${plan.changes.length} file(s) changed, ${plan.unchangedCount} unchanged`);
    }

    if (opts.agentsMd !== false) {
      console.log(agentsMdMessage(syncAgentsMd(resolve(path))));
    }
  });

skill
  .command("check")
  .description(
    "check the vendored .claude/skills/event-modeling/ copy in [path] for drift against the " +
      "installed em package; exits non-zero on any mismatch (CI-ready, MIL-93)",
  )
  .argument("[path]", "consumer repo root", ".")
  .option("--json", "print a JSON document instead of the text report (see docs/cli.md)")
  .action((path: string, opts: { json?: boolean }) => {
    const packagedDir = packagedSkillDir();
    const vendoredDir = vendoredSkillDir(path);

    const result = checkSkillSync(packagedDir, vendoredDir, PKG_VERSION);

    if (opts.json) {
      process.stdout.write(buildSkillCheckJson(result, vendoredDir, PKG_VERSION) + "\n");
    } else {
      for (const f of result.findings) console.log(f.message);
      console.log(result.ok ? `ok — vendored skill matches em ${PKG_VERSION}` : `${result.findings.length} mismatch(es)`);
    }

    // Set the code rather than process.exit(): same rationale as em ledger/em diff — stdout to
    // a pipe (a --json document) shouldn't risk truncation.
    if (!result.ok) process.exitCode = 1;
  });

// Exported so dev tooling (e.g. scripts/generate-skill-docs.ts) can introspect the registered
// commands/options without triggering a real CLI run. Guarded the same way Node's CJS
// `require.main === module` used to: only actually parse argv when this file is the process's
// entry module, not merely `import`ed. See util/isMainModule.ts for why this has to
// realpath-resolve argv[1] — a naive path comparison breaks the `npm i -g` symlink case.
export { program };

if (isMainModule(import.meta.url)) {
  program.parseAsync().catch((e) => {
    reportError(e);
    process.exit(1);
  });
}

// ---- helpers ----

function compileFile(
  file: string,
  opts: CompileOptions = {},
  // `em watch` must OUTLIVE a bad save — a mid-edit syntax error killing the
  // watcher (and the --serve live view with it) is a session-ending failure.
  // One-shot commands keep the exit-with-message behavior.
  { survive = false } = {},
) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    if (survive) throw new Error(`cannot read ${file}`);
    console.error(`cannot read ${file}`);
    process.exit(1);
  }
  try {
    return { ...compile(source, opts), source };
  } catch (e) {
    if (e instanceof ParseError) {
      if (survive) throw new Error(`parse error in ${file} ${e.message}`);
      console.error(`parse error in ${file} ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

/** Read a file's text, or exit with a clear error — shared by `em diff` (both forms) and
 *  `em glossary`, which each read one or more plain `.em` files off disk before compiling. */
function readFileOrExit(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    console.error(`cannot read ${file}`);
    process.exit(1);
  }
}

/** Parse+normalize source text for `em diff`, exiting with a labeled parse error on failure. */
function compileSource(source: string, label: string): CompileResult {
  try {
    return compile(source);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`parse error in ${label} ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

/** Resolve `file`'s content at a git revision, exiting with a clear error on any git failure. */
function readAtRevision(file: string, rev: string): string {
  const result = resolveRevision(file, rev);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  return result.content;
}

/**
 * Build the `em changelog` markdown document for an already-resolved commit
 * list (oldest -> newest). Compiles every revision once; per-revision
 * warnings are deliberately never printed (historical revisions can be noisy)
 * — only a compile *failure* (parse error or validation error, same
 * threshold `em diff` uses) surfaces, as that entry's error note, never a
 * crash. Diffs are computed against the previous *parseable* revision, so a
 * single bad revision in the middle of the walk doesn't break every entry
 * after it. Content is read at each commit's own path (`readFileAtCommit`),
 * so the walk survives renames.
 */
function buildChangelogDoc(file: string, repoRoot: string, commits: CommitInfo[]): string {
  const models: (NormalizedModel | null)[] = [];
  const refsList: (RefsResult | null)[] = [];
  const errors: (string | null)[] = [];

  for (const c of commits) {
    const rev = readFileAtCommit(repoRoot, c);
    if (!rev.ok) {
      models.push(null);
      refsList.push(null);
      errors.push(rev.message);
      continue;
    }
    try {
      const { model, refs, diagnostics } = compile(rev.content);
      if (hasErrors(diagnostics)) {
        models.push(null);
        refsList.push(null);
        errors.push(`validation errors at ${c.shortHash} — fix with \`em validate\` at that revision`);
      } else {
        models.push(model);
        refsList.push(refs);
        errors.push(null);
      }
    } catch (e) {
      models.push(null);
      refsList.push(null);
      errors.push(e instanceof ParseError ? `parse error: ${e.message}` : e instanceof Error ? e.message : String(e));
    }
  }

  const entries: ChangelogEntry[] = [];
  let prevParseable = -1;
  commits.forEach((c, i) => {
    const base = { shortHash: c.shortHash, date: c.date, subject: c.subject };
    if (i === 0) {
      entries.push({ ...base, diff: null });
    } else if (!models[i]) {
      entries.push({ ...base, diff: null, error: errors[i]! });
    } else if (prevParseable === -1) {
      entries.push({ ...base, diff: null, error: `no earlier parseable revision to diff against (${commits[0].shortHash}: ${errors[0]})` });
    } else {
      entries.push({
        ...base,
        diff: diffModels(models[prevParseable]!, models[i]!, refsList[prevParseable]!, refsList[i]!),
      });
    }
    if (models[i]) prevParseable = i;
  });

  const intro: ChangelogIntro | null = models[0] ? { slices: models[0].slices.length, elements: models[0].elements.length } : null;
  const introError = models[0] ? undefined : (errors[0] ?? undefined);

  const stateFile = join(dirname(file), STATE_FILE_NAME);
  const decisions = existsSync(stateFile) ? parseDecisionsLog(readFileSync(stateFile, "utf8")) : [];

  return buildChangelog(entries, decisions, { file, intro, introError });
}

/** Shared body for both `em diff` forms: compile both sides, gate on errors, print, exit-code. */
function runDiff(
  oldSource: string,
  oldLabel: string,
  newSource: string,
  newLabel: string,
  exitCode?: boolean,
  json?: boolean,
  lineage?: LineageResolvers,
): void {
  const oldResult = compileSource(oldSource, oldLabel);
  const newResult = compileSource(newSource, newLabel);

  printDiagnostics(oldResult.diagnostics);
  printDiagnostics(newResult.diagnostics);

  if (hasErrors(oldResult.diagnostics) || hasErrors(newResult.diagnostics)) {
    console.error("not diffing: fix the errors above");
    process.exit(1);
  }

  const diff = diffModels(oldResult.model, newResult.model, oldResult.refs, newResult.refs, lineage);
  if (json) {
    const oldSide = { label: oldLabel, source: oldSource, diagnostics: oldResult.diagnostics };
    const newSide = { label: newLabel, source: newSource, diagnostics: newResult.diagnostics };
    process.stdout.write(buildDiffJson(diff, oldSide, newSide) + "\n");
  } else {
    console.log(formatModelDiff(diff));
  }

  // Set the code rather than process.exit(): stdout to a pipe is asynchronous
  // on POSIX, so exiting here would truncate a JSON document larger than the
  // pipe buffer — exactly the `--json --exit-code | ...` case in CI.
  if (exitCode && hasChanges(diff)) process.exitCode = 1;
}

function defaultOut(file: string, fmt: string): string {
  const base = basename(file, extname(file));
  return `${base}.${fmt}`;
}

/** Warn (without failing) when an element's `note` file can't be found. */
function warnMissingNotes(file: string, model: NormalizedModel): void {
  const base = dirname(file);
  for (const el of model.elements) {
    if (el.note && !existsSync(resolve(base, el.note))) {
      console.warn(`  warn  note file not found for "${el.name}": ${el.note}`);
    }
  }
}

/** Print only the open `issue "text"` diagnostics: slice, element, line, text — for CI. */
function printIssues(model: NormalizedModel): void {
  const withIssues = model.elements.filter((el) => el.issue);
  if (withIssues.length === 0) {
    console.log("no open issues");
    return;
  }
  for (const el of withIssues) {
    const slice = model.slices[el.sliceIndex];
    console.log(`  issue :${el.line} slice "${slice.name}" ${el.kind} "${el.name}": ${el.issue}`);
  }
}

/** Print only `divergence "text"` annotations: slice, element, line, text — for auditing.
 *  Unlike `printIssues`, nothing checks this list to decide an exit code — accepted
 *  divergences never fail a build. */
function printDivergences(model: NormalizedModel): void {
  const diverged = model.elements.filter((el) => el.divergence);
  if (diverged.length === 0) {
    console.log("no accepted divergences");
    return;
  }
  for (const el of diverged) {
    const slice = model.slices[el.sliceIndex];
    console.log(`  divergence :${el.line} slice "${slice.name}" ${el.kind} "${el.name}": ${el.divergence}`);
  }
}

/** Print only elements marked `public`: slice, kind, name, line — for an integration-surface audit. */
function printPublicElements(model: NormalizedModel): void {
  const pub = model.elements.filter((el) => el.public && (el.kind === "event" || el.kind === "view"));
  if (pub.length === 0) {
    console.log("no public elements");
    return;
  }
  for (const el of pub) {
    const slice = model.slices[el.sliceIndex];
    console.log(`  public :${el.line} slice "${slice.name}" ${el.kind} "${el.name}"`);
  }
}

/** Diagnostics in `all` not already present (by reference identity) in `already` — avoids
 *  double-printing diagnostic objects forwarded unchanged from an earlier compile step (e.g.
 *  ref-collision warnings `buildExport()`/`buildCatalog()` fold in from the same `RefsResult`
 *  `compileFile()` already printed once). */
function newDiagnostics(all: Diagnostic[], already: Diagnostic[]): Diagnostic[] {
  return all.filter((d) => !already.includes(d));
}

function printDiagnostics(diags: Diagnostic[]): void {
  if (diags.length === 0) return;
  for (const d of diags) {
    const line = formatDiagnostic(d);
    if (d.severity === "error") console.error(line);
    else console.warn(line);
  }
}

/** Same as printDiagnostics, prefixed with the file each diagnostic came from —
 *  worth doing once N input files can be more than the two `em diff` compares,
 *  where ambiguity about which side a diagnostic belongs to gets materially worse. */
function printDiagnosticsFor(file: string, diags: Diagnostic[]): void {
  for (const d of diags) {
    const line = `${file}: ${formatDiagnostic(d)}`;
    if (d.severity === "error") console.error(line);
    else console.warn(line);
  }
}

function reportError(e: unknown): void {
  console.error(e instanceof Error ? e.message : String(e));
}
