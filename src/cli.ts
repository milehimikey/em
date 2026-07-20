#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { compile, CompileOptions } from "./pipeline.js";
import { NormalizedModel } from "./model/model.js";
import { ParseError } from "./parser/parser.js";
import { renderDot, formatFromPath } from "./render/render.js";
import { watchFile } from "./render/watch.js";
import { formatDiagnostic, hasErrors, Diagnostic } from "./model/validate.js";
import { loadSliceDocs, SlicePattern, SliceStatus } from "./model/sliceDoc.js";
import { validateSliceDocs, VALID_PATTERNS, VALID_STATUSES } from "./model/validateSliceDocs.js";
import { newSlice } from "./slice/generate.js";
import { syncAll, syncSlice } from "./slice/sync.js";
import {
  listSliceRecords,
  listSlices,
  searchSliceRecords,
  searchSlices,
  showSlice,
  SliceSummary,
  updateSlice,
} from "./slice/query.js";
import {
  applyMigration,
  assertCleanWorkingTree,
  formatMigrationReport,
  planMigration,
} from "./migrate/migrate.js";
import { STARTER_EM } from "./templates.js";

const program = new Command();

program
  .name("em")
  .description("Event Modeling CLI — slice-first DSL rendered as a strict Graphviz grid")
  .version("1.1.0");

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
  .action(async (file: string, opts) => {
    const out = opts.out ?? defaultOut(file, opts.format ?? "svg");
    const fmt = opts.format ?? formatFromPath(out);

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
      } catch (e) {
        reportError(e);
      }
    };

    await build();
    watchFile(file, build);
    console.log(`watching ${file} … (ctrl-c to stop)`);
  });

program
  .command("validate")
  .description("check a model against event-modeling rules")
  .argument("<file>", "input .em file")
  .option("--skip-slices", "don't validate slice docs (slices/*.md)")
  .action((file: string, opts: { skipSlices?: boolean }) => {
    const { model, diagnostics } = compileFile(file);
    if (!opts.skipSlices) {
      const docs = loadSliceDocs(dirname(file));
      diagnostics.push(...validateSliceDocs(model, file, docs));
    }
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

const slice = program.command("slice").description("manage slice design docs (slices/*.md)");

slice
  .command("new")
  .description("scaffold a new slice doc with injected frontmatter")
  .argument("<name>", 'slice title, e.g. "Place Order"')
  .option("--dir <path>", "model directory", ".")
  .option("--model <path>", "explicit .em file (default: the only .em in --dir)")
  .option("--config <path>", "explicit em.config.json path")
  .addOption(
    new Option("--pattern <pattern>", "slice pattern").choices(VALID_PATTERNS).default("state-change"),
  )
  .option("--id <id>", "explicit slice id (default: kebab-case of the name)")
  .option("--slice-element <id>", "the .em Element.id this doc documents, if already known")
  .option("-f, --force", "overwrite an existing doc with this id")
  .action(
    (
      name: string,
      opts: {
        dir: string;
        model?: string;
        config?: string;
        pattern: SlicePattern;
        id?: string;
        sliceElement?: string;
        force?: boolean;
      },
    ) => {
      try {
        const result = newSlice(name, {
          dir: opts.dir,
          modelPath: opts.model,
          configPath: opts.config,
          pattern: opts.pattern,
          id: opts.id,
          sliceElement: opts.sliceElement,
          force: opts.force,
        });
        console.log(`wrote ${result.path} (id: ${result.id})`);
      } catch (e) {
        reportError(e);
        process.exit(1);
      }
    },
  );

slice
  .command("sync")
  .description(
    "recompute generated frontmatter fields (commands/events/readModels/contexts/personas/triggers) from the .em",
  )
  .argument("[id]", "slice id to sync (omit with --all)")
  .option("--dir <path>", "model directory", ".")
  .option("--model <path>", "explicit .em file")
  .option("--all", "sync every slice doc in the directory")
  .action((id: string | undefined, opts: { dir: string; model?: string; all?: boolean }) => {
    try {
      if (opts.all) {
        const { synced, skipped } = syncAll({ dir: opts.dir, modelPath: opts.model });
        for (const s of synced) console.log(`synced ${s.path}${s.changed ? "" : " (no changes)"}`);
        for (const s of skipped) console.warn(`  skip  ${s.file}: ${s.reason}`);
      } else {
        if (!id) {
          console.error("pass a slice id, or --all");
          process.exit(1);
        }
        const result = syncSlice(id, { dir: opts.dir, modelPath: opts.model });
        console.log(`synced ${result.path}${result.changed ? "" : " (no changes)"}`);
      }
    } catch (e) {
      reportError(e);
      process.exit(1);
    }
  });

slice
  .command("list")
  .description("list slice docs from frontmatter only (no .em parse, no body read)")
  .option("--dir <path>", "model directory", ".")
  .addOption(new Option("--status <status>", "filter by status").choices(VALID_STATUSES))
  .addOption(new Option("--pattern <pattern>", "filter by pattern").choices(VALID_PATTERNS))
  .option("--context <context>", "filter by context")
  .option("--tag <tag>", "filter by tag")
  .option("--format <fmt>", "table | json", "table")
  .option("--full", "emit every frontmatter field per slice (requires --format json)")
  .action(
    (opts: {
      dir: string;
      status?: SliceStatus;
      pattern?: SlicePattern;
      context?: string;
      tag?: string;
      format: string;
      full?: boolean;
    }) => {
      const filter = {
        dir: opts.dir,
        status: opts.status,
        pattern: opts.pattern,
        context: opts.context,
        tag: opts.tag,
      };
      if (opts.full) {
        requireJson(opts.format);
        console.log(JSON.stringify(listSliceRecords(filter), null, 2));
        return;
      }
      printSlices(listSlices(filter), opts.format);
    },
  );

slice
  .command("show")
  .description("show one slice doc's frontmatter")
  .argument("<id>", "slice id")
  .option("--dir <path>", "model directory", ".")
  .option("--format <fmt>", "table | json", "table")
  .option("--body", "include the doc body")
  .action((id: string, opts: { dir: string; format: string; body?: boolean }) => {
    const doc = showSlice(id, { dir: opts.dir });
    if (!doc) {
      console.error(`no slice doc with id "${id}" found in ${opts.dir}`);
      process.exit(1);
    }
    if (opts.format === "json") {
      const payload = opts.body ? { ...doc.frontmatter, body: doc.body } : doc.frontmatter;
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`# ${doc.file}`);
    for (const [k, v] of Object.entries(doc.frontmatter ?? {})) {
      console.log(`${k}: ${JSON.stringify(v)}`);
    }
    if (opts.body) {
      console.log("");
      console.log(doc.body);
    }
  });

slice
  .command("search")
  .description("search slice docs by frontmatter only (title/tags/commands/events/readModels)")
  .argument("[query]", "free-text query", "")
  .option("--dir <path>", "model directory", ".")
  .addOption(new Option("--status <status>", "filter by status").choices(VALID_STATUSES))
  .addOption(new Option("--pattern <pattern>", "filter by pattern").choices(VALID_PATTERNS))
  .option("--context <context>", "filter by context")
  .option("--tag <tag>", "filter by tag")
  .option("--format <fmt>", "table | json", "table")
  .option("--full", "emit every frontmatter field per slice (requires --format json)")
  .action(
    (
      query: string,
      opts: {
        dir: string;
        status?: SliceStatus;
        pattern?: SlicePattern;
        context?: string;
        tag?: string;
        format: string;
        full?: boolean;
      },
    ) => {
      const filter = {
        dir: opts.dir,
        status: opts.status,
        pattern: opts.pattern,
        context: opts.context,
        tag: opts.tag,
      };
      if (opts.full) {
        requireJson(opts.format);
        console.log(JSON.stringify(searchSliceRecords(query, filter), null, 2));
        return;
      }
      printSlices(searchSlices(query, filter), opts.format);
    },
  );

slice
  .command("update")
  .description("write status/version changes back into a slice doc's frontmatter")
  .argument("<id>", "slice id")
  .option("--dir <path>", "model directory", ".")
  .addOption(new Option("--status <status>", "new status").choices(VALID_STATUSES))
  .option("--bump-version", "increment version by 1")
  .action((id: string, opts: { dir: string; status?: SliceStatus; bumpVersion?: boolean }) => {
    try {
      const result = updateSlice(id, {
        dir: opts.dir,
        status: opts.status,
        bumpVersion: opts.bumpVersion,
      });
      console.log(`updated ${result.path}`);
    } catch (e) {
      reportError(e);
      process.exit(1);
    }
  });

program
  .command("migrate")
  .description("upgrade a pre-1.0 model directory to the frontmatter standard (docs/1.0.0-spec.md)")
  .argument("<model-dir>", "model directory")
  .option("--model <path>", "explicit .em file")
  .option("--dry-run", "print the plan/report without writing")
  .option("--force", "proceed even with uncommitted changes or no git repo")
  .option("--report <path>", "write the migration report to a file instead of stdout")
  .action(
    (
      dir: string,
      opts: { model?: string; dryRun?: boolean; force?: boolean; report?: string },
    ) => {
      try {
        if (!opts.dryRun) assertCleanWorkingTree(dir, opts.force);
        const plan = planMigration(dir, { modelPath: opts.model });
        const report = formatMigrationReport(plan);
        if (opts.report) {
          writeFileSync(opts.report, report);
          console.log(`wrote migration report -> ${opts.report}`);
        } else {
          console.log(report);
        }
        if (opts.dryRun) {
          console.log("dry run — no files written");
          return;
        }
        applyMigration(plan);
        console.log("migration applied");
      } catch (e) {
        reportError(e);
        process.exit(1);
      }
    },
  );

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

/** --full emits a shape only JSON can carry; fail loudly rather than silently ignoring it. */
function requireJson(format: string): void {
  if (format !== "json") {
    console.error("--full requires --format json");
    process.exit(1);
  }
}

function printSlices(results: SliceSummary[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("no matching slices");
    return;
  }
  for (const s of results) {
    console.log(`${s.id}\t${s.pattern ?? "?"}\t${s.status ?? "?"}\tv${s.version ?? "?"}\t${s.title}`);
  }
}
