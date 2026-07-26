#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { compile, CompileOptions, CompileResult } from "./pipeline.js";
import { NormalizedModel } from "./model/model.js";
import { ParseError } from "./parser/parser.js";
import { renderDot, formatFromPath } from "./render/render.js";
import { watchFile } from "./render/watch.js";
import { startLiveServer, LiveServer } from "./render/serve.js";
import { formatDiagnostic, hasErrors, Diagnostic } from "./model/validate.js";
import { buildExport } from "./emit/json.js";
import { buildDiffJson } from "./emit/diffJson.js";
import { diffModels, formatModelDiff, hasChanges } from "./model/diff.js";
import { planDiffArgs, resolveRevision } from "./cli/diff-inputs.js";
import { STARTER_EM } from "./templates.js";

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
  .command("render")
  .description("transpile a model and render it (or emit DOT)")
  .argument("<file>", "input .em file")
  .option("-o, --out <path>", "output path (extension picks the format)")
  .option("-T, --format <fmt>", "output format (svg, png, pdf, ...)")
  .option("--emit-dot", "print the generated DOT instead of rendering")
  .option("--keep-empty-lanes", "keep the API lane even when empty")
  .action(async (file: string, opts) => {
    const { dot, model, diagnostics } = compileFile(file, {
      keepEmptyLanes: opts.keepEmptyLanes,
    });
    printDiagnostics(diagnostics);
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

    if (hasErrors(diagnostics)) {
      console.error("not rendering: fix the errors above");
      process.exit(1);
    }

    const out = opts.out ?? defaultOut(file, opts.format ?? "svg");
    const fmt = opts.format ?? formatFromPath(out);
    await renderDot(dot, model, out, fmt, dirname(file));
    console.log(`rendered ${out}`);
  });

program
  .command("export")
  .description("export a versioned JSON snapshot of the normalized model")
  .argument("<file>", "input .em file")
  .option("-o, --out <path>", "write to a file instead of stdout")
  .action((file: string, opts: { out?: string }) => {
    const { model, diagnostics, source } = compileFile(file);
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) {
      console.error("not exporting: fix the errors above");
      process.exit(1);
    }

    const exported = buildExport(model, diagnostics, source, file);
    printDiagnostics(exported.diagnostics.filter((d) => !diagnostics.includes(d)));

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
        runDiff(oldSource, plan.oldFile, newSource, plan.newFile, opts.exitCode, opts.json);
        return;
      }
      const oldSource = readAtRevision(plan.file, plan.from);
      const oldLabel = `${plan.file}@${plan.from}`;
      const newSource = plan.to ? readAtRevision(plan.file, plan.to) : readFileOrExit(plan.file);
      const newLabel = plan.to ? `${plan.file}@${plan.to}` : plan.file;
      runDiff(oldSource, oldLabel, newSource, newLabel, opts.exitCode, opts.json);
    },
  );

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

    const build = async () => {
      const started = Date.now();
      try {
        const { dot, model, diagnostics } = compileFile(file, {
          keepEmptyLanes: opts.keepEmptyLanes,
        });
        printDiagnostics(diagnostics);
        warnMissingNotes(file, model);
        if (hasErrors(diagnostics)) {
          console.error("skipped render (errors above)");
          return;
        }
        await renderDot(dot, model, out, fmt, dirname(file));
        console.log(`rendered ${out} (${Date.now() - started}ms)`);
        server?.notify();
      } catch (e) {
        reportError(e);
      }
    };

    await build();

    if (opts.serve) {
      try {
        // Serve the directory the SVG is written to — that's what the browser
        // fetches, and note "..." links inside the SVG resolve relative to it.
        server = await startLiveServer({ dir: dirname(resolve(out)), port: opts.port });
        console.log(`→ live view: ${server.url}/?svg=${encodeURIComponent(basename(out))}`);
        console.log("  open it in a browser and share your screen");
      } catch (e) {
        reportError(e);
      }
    }

    watchFile(file, build);
    console.log(`watching ${file} … (ctrl-c to stop)`);
  });

program
  .command("validate")
  .description("check a model against event-modeling rules")
  .argument("<file>", "input .em file")
  .option("--list-issues", "print only open `issue` diagnostics (slice, element, line, text)")
  .option(
    "--fail-on-issues",
    "exit non-zero if the model has any open `issue`s (opt-in — issues are warnings and don't block by default)",
  )
  .action((file: string, opts: { listIssues?: boolean; failOnIssues?: boolean }) => {
    const { model, diagnostics } = compileFile(file);
    if (opts.listIssues) {
      printIssues(model);
      // Errors still fail the run below — surface them rather than exiting
      // non-zero with nothing but the issue list on screen.
      printDiagnostics(diagnostics.filter((d) => d.severity === "error"));
    } else {
      printDiagnostics(diagnostics);
      if (diagnostics.length === 0) console.log("ok — no issues");
    }
    if (hasErrors(diagnostics)) process.exit(1);
    if (opts.failOnIssues && model.elements.some((el) => el.issue)) process.exit(1);
  });

const skill = program
  .command("skill")
  .description("manage Claude Code skills bundled with em");

skill
  .command("install")
  .description("copy the event-modeling skill into .claude/skills/event-modeling/")
  .option("-f, --force", "overwrite an existing installation")
  .action(async (opts: { force?: boolean }) => {
    const pkgDir = dirname(fileURLToPath(import.meta.url));
    const src = join(pkgDir, "..", ".claude", "skills", "event-modeling");
    const dest = join(process.cwd(), ".claude", "skills", "event-modeling");

    if (existsSync(dest) && !opts.force) {
      console.log(`skill already installed at ${dest}`);
      console.log("re-run with --force to overwrite");
      return;
    }

    await mkdir(join(process.cwd(), ".claude", "skills"), { recursive: true });
    await cp(src, dest, { recursive: true });
    console.log(`installed event-modeling skill → ${dest}`);
    console.log("in Claude Code, run /event-modeling to start a guided session");
  });

program.parseAsync().catch((e) => {
  reportError(e);
  process.exit(1);
});

// ---- helpers ----

function compileFile(file: string, opts: CompileOptions = {}) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.error(`cannot read ${file}`);
    process.exit(1);
  }
  try {
    return { ...compile(source, opts), source };
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`parse error in ${file} ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

/** Read a file's text, or exit with a clear error — used by `em diff`'s two-file form. */
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

/** Shared body for both `em diff` forms: compile both sides, gate on errors, print, exit-code. */
function runDiff(
  oldSource: string,
  oldLabel: string,
  newSource: string,
  newLabel: string,
  exitCode?: boolean,
  json?: boolean,
): void {
  const oldResult = compileSource(oldSource, oldLabel);
  const newResult = compileSource(newSource, newLabel);

  printDiagnostics(oldResult.diagnostics);
  printDiagnostics(newResult.diagnostics);

  if (hasErrors(oldResult.diagnostics) || hasErrors(newResult.diagnostics)) {
    console.error("not diffing: fix the errors above");
    process.exit(1);
  }

  const diff = diffModels(oldResult.model, newResult.model);
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

function printDiagnostics(diags: Diagnostic[]): void {
  if (diags.length === 0) return;
  for (const d of diags) {
    const line = formatDiagnostic(d);
    if (d.severity === "error") console.error(line);
    else console.warn(line);
  }
}

function reportError(e: unknown): void {
  console.error(e instanceof Error ? e.message : String(e));
}
