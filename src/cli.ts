#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { compile, CompileOptions } from "./pipeline.js";
import { NormalizedModel } from "./model/model.js";
import { ParseError } from "./parser/parser.js";
import { renderDot, formatFromPath } from "./render/render.js";
import { watchFile } from "./render/watch.js";
import { startLiveServer, LiveServer } from "./render/serve.js";
import { formatDiagnostic, hasErrors, Diagnostic } from "./model/validate.js";
import { STARTER_EM } from "./templates.js";

const program = new Command();

program
  .name("em")
  .description("Event Modeling CLI — slice-first DSL rendered as a strict Graphviz grid")
  .version("1.2.0");

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
  .action((file: string) => {
    const { diagnostics } = compileFile(file);
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) process.exit(1);
    if (diagnostics.length === 0) console.log("ok — no issues");
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
    return compile(source, opts);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`parse error in ${file} ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
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
