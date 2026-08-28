// SPDX-License-Identifier: MIT
// MIL-162 spike: runs the full "portal" pipeline — generate a synthetic multi-model system,
// compile every model the way `em` itself does, consume `em export --json` + the same facts
// `em status` aggregates, resolve cross-model links through the `public` marker, and render one
// self-contained demo page over real (synthetic) model data — to test the decision recorded in
// docs/decisions/mil-162-teachable-navigator.md: that `em export --json` (+ `em status`'s
// underlying facts) is a sufficient, deterministic integration surface for a separate portal
// tool, without em itself growing into that tool. See that doc for the write-up; this file and
// scaleFixture.ts are the throwaway prototype it's written up FROM.
//
// Deliberately NOT wired into src/cli.ts — see prototypes/portal-spike/README.md for why this
// lives outside em's shipped command surface.
//
// Usage: tsx prototypes/portal-spike/spike.ts [modelCount] [slicesPerModel] [outHtmlPath]

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "../../src/pipeline.js";
import { hasErrors } from "../../src/model/validate.js";
import { buildExport, ExportDoc } from "../../src/emit/json.js";
import { resolveSliceStatusFacts, buildStatusReport, StatusReport } from "../../src/cli/status.js";
import { isMainModule } from "../../src/util/isMainModule.js";
import { generateScaleFixture, ScaleFixture } from "./scaleFixture.js";

export interface CompiledModel {
  dirName: string;
  modelName: string;
  file: string;
  doc: ExportDoc;
}

export interface CrossModelLink {
  eventName: string;
  fromModel: string;
  fromRef: string;
  toModel: string;
  toElementRef: string;
}

export interface SpikeSummary {
  modelCount: number;
  totalSlices: number;
  timingMs: {
    generate: number;
    compileAndExport: number;
    statusRollup: number;
    crossModelLinks: number;
    total: number;
  };
  status: StatusReport;
  crossModelLinks: CrossModelLink[];
  models: { dirName: string; modelName: string; sliceCount: number; publicEventCount: number }[];
}

/** Writes every fixture model to `<rootDir>/<dirName>/<fileName>` — the same one-directory-
 *  per-model layout `examples/multi-model/` (MIL-160) documents, so this fixture is laid out
 *  exactly the way a real multi-model project would be, not a synthetic shortcut. */
export function materializeFixture(fixture: ScaleFixture, rootDir: string): { dirName: string; file: string }[] {
  return fixture.models.map((m) => {
    const dir = join(rootDir, m.dirName);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, m.fileName);
    writeFileSync(file, m.source);
    return { dirName: m.dirName, file };
  });
}

/** Binds one real slice doc (frontmatter + body, the templates/slice.md dialect) to the very
 *  first slice of the very first model, via the same `note "slices/<key>.md"` convention every
 *  other doc-aware command reads — proving the onboarding walkthrough and the status rollup
 *  both work off REAL doc content, not just structural element counts. Every other slice in the
 *  fixture stays doc-less on purpose: a large in-flight system is realistically mostly
 *  undocumented, and the rollup's `no-doc` bucket needs to be exercised at scale too. */
function bindOneSliceDoc(materialized: { dirName: string; file: string }[], fixture: ScaleFixture): void {
  const first = fixture.models[0];
  const firstSliceName = `${first.modelName} Slice 000`;
  const key = "checkout-00-slice-000"; // slug(firstSliceName), spelled out for clarity
  const dir = dirname(materialized[0].file);

  // Add the note binding to the ui element's line — same clause em's own examples use.
  const withNote = readFileSync(materialized[0].file, "utf8").replace(
    `ui ${firstSliceName} Screen @Operator`,
    `ui ${firstSliceName} Screen @Operator note "slices/${key}.md"`,
  );
  writeFileSync(materialized[0].file, withNote);

  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(
    join(dir, "slices", `${key}.md`),
    `---
schemaVersion: 1
pattern: state-change
swimlane: Operator → ${first.modelName.replace(/\s+/g, "")}
status: reviewed
version: 1
---
# Slice: ${firstSliceName}

## Intent

The first slice of a large synthetic system generated for MIL-162's scale prototype — stands
in for "the one slice a reader opens first."

## Trigger & Actor

An \`Operator\`, acting on the **${firstSliceName} Screen**.

## Invariants / Business Rules

- **INV-SPK-1:** Recorded once per submission; not idempotent.

## Open Questions

- [ ] Is this slice representative enough of the real system to anchor the guided first read?
`,
  );
}

export function compileAndExportAll(materialized: { dirName: string; file: string }[]): {
  compiled: CompiledModel[];
  statusFacts: ReturnType<typeof resolveSliceStatusFacts>["facts"];
} {
  const compiled: CompiledModel[] = [];
  let statusFacts: ReturnType<typeof resolveSliceStatusFacts>["facts"] = [];

  for (const { dirName, file } of materialized) {
    const source = readFileSync(file, "utf8");
    const { model, refs, diagnostics } = compile(source);
    if (hasErrors(diagnostics)) {
      throw new Error(`fixture model ${file} failed to compile: ${JSON.stringify(diagnostics)}`);
    }
    const exported = buildExport(model, refs, diagnostics, source, file);
    const doc = JSON.parse(exported.text) as ExportDoc; // round-trip through JSON, same as any real portal consumer would
    compiled.push({ dirName, modelName: doc.model.name ?? dirName, file, doc });

    const baseDir = dirname(file);
    const { facts } = resolveSliceStatusFacts(file, model, refs, baseDir);
    statusFacts = statusFacts.concat(facts);
  }

  return { compiled, statusFacts };
}

/** The cross-model navigation join. `em` has no DSL-level construct for "this element's
 *  trigger is another FILE's public event" — each model compiles independently, and `from`
 *  only resolves within the model being compiled (confirmed the hard way: an early draft of
 *  scaleFixture.ts wrote a genuine `view … from "<other model's event>"` and `em validate`
 *  rejected it with `view-from-unresolved`; see docs/decisions/mil-162-teachable-navigator.md).
 *  So the only thing carried across independently-compiled files today is a public event's
 *  exact NAME — this function is exactly the heuristic join a portal has to perform itself:
 *  every model's `public` events (docs/dsl.md "Integration surface"), matched against every
 *  OTHER model's element names that contain that exact string. Pure data, no LLM, no fuzzy
 *  matching — but also no compiler guarantee behind it, which is itself a finding: em could
 *  add a real cross-model reference syntax, and until it does, a portal's cross-model nav is
 *  only as good as naming discipline. */
export function buildCrossModelLinks(compiled: CompiledModel[]): CrossModelLink[] {
  const publicEventsByName = new Map<string, { model: string; ref: string }>();
  for (const c of compiled) {
    for (const slice of c.doc.model.slices) {
      for (const el of slice.elements) {
        if (el.kind === "event" && el.public) {
          publicEventsByName.set(el.name, { model: c.dirName, ref: el.ref });
        }
      }
    }
  }

  const links: CrossModelLink[] = [];
  for (const c of compiled) {
    for (const slice of c.doc.model.slices) {
      for (const el of slice.elements) {
        for (const [eventName, source] of publicEventsByName) {
          if (source.model === c.dirName) continue; // an element referencing its OWN model's public event isn't a cross-model link
          if (el.name.includes(eventName)) {
            links.push({ eventName, fromModel: source.model, fromRef: source.ref, toModel: c.dirName, toElementRef: el.ref });
          }
        }
      }
    }
  }
  return links;
}

export function renderDemoHtml(summary: SpikeSummary): string {
  const documented = summary.status.slices.total - summary.status.slices.byStatus.noDoc;
  const pct = ((documented / summary.status.slices.total) * 100).toFixed(1);
  const modelRows = summary.models
    .map(
      (m) =>
        `<tr><td>${m.modelName}</td><td>${m.sliceCount}</td><td>${m.publicEventCount}</td></tr>`,
    )
    .join("\n");
  const linkRows = summary.crossModelLinks
    .map(
      (l) =>
        `<tr><td><code>${l.eventName}</code></td><td>${l.fromModel}</td><td>${l.toModel}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>em portal spike — MIL-162</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1, h2 { color: #111; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; background: #eef; font-size: 0.85rem; }
  .lesson { border-left: 3px solid #6a5acd; padding-left: 0.8rem; margin: 0.6rem 0; }
</style>
</head>
<body>
<h1>em portal — spike output (MIL-162)</h1>
<p>Generated by <code>prototypes/portal-spike/spike.ts</code> against a synthetic
${summary.modelCount}-model, ${summary.totalSlices}-slice system. Not a shipped surface — see
<code>docs/decisions/mil-162-teachable-navigator.md</code>.</p>

<h2>1. State up front (landing view)</h2>
<p class="badge">${summary.status.slices.total} slices across ${summary.modelCount} models
&middot; ${documented} documented (${pct}%) &middot; ${summary.status.driftSignal.inSync +
    summary.status.driftSignal.neverImplemented +
    summary.status.driftSignal.unpropagatedDelta +
    summary.status.driftSignal.implementedWithoutLink} with a computable drift signal</p>

<h2>2. Guided first read (over this system's own first slice)</h2>
<div class="lesson"><strong>This element is a UI</strong> — where a person acts. White box, top lane.</div>
<div class="lesson"><strong>This element is a Command</strong> — an intent someone submits. Blue box.</div>
<div class="lesson"><strong>This element is an Event</strong> — an immutable fact once recorded. Amber box.
Time runs left to right; a folded corner means there's a note attached with more detail.</div>

<h2>3. Multi-model navigation</h2>
<table>
<tr><th>Model</th><th>Slices</th><th>Public events</th></tr>
${modelRows}
</table>
<p>${summary.crossModelLinks.length} cross-model link(s) resolved via the <code>public</code> marker:</p>
<table>
<tr><th>Event</th><th>From model</th><th>To model (consumer)</th></tr>
${linkRows}
</table>

<h2>Timing</h2>
<pre>${JSON.stringify(summary.timingMs, null, 2)}</pre>
</body>
</html>
`;
}

export async function runSpike(modelCount: number, slicesPerModel: number, outHtmlPath?: string): Promise<SpikeSummary> {
  const t0 = performance.now();
  const fixture = generateScaleFixture(modelCount, slicesPerModel);
  const t1 = performance.now();

  const root = mkdtempSync(join(tmpdir(), "em-portal-spike-"));
  try {
    const materialized = materializeFixture(fixture, root);
    bindOneSliceDoc(materialized, fixture);

    const { compiled, statusFacts } = compileAndExportAll(materialized);
    const t2 = performance.now();

    const status = buildStatusReport(
      materialized.map((m) => m.file),
      statusFacts,
      0,
      null,
      [],
      [],
    );
    const t3 = performance.now();

    const crossModelLinks = buildCrossModelLinks(compiled);
    const t4 = performance.now();

    const summary: SpikeSummary = {
      modelCount,
      totalSlices: fixture.totalSlices,
      timingMs: {
        generate: t1 - t0,
        compileAndExport: t2 - t1,
        statusRollup: t3 - t2,
        crossModelLinks: t4 - t3,
        total: t4 - t0,
      },
      status,
      crossModelLinks,
      models: compiled.map((c) => ({
        dirName: c.dirName,
        modelName: c.modelName,
        sliceCount: c.doc.model.slices.length,
        publicEventCount: c.doc.model.slices
          .flatMap((s) => s.elements)
          .filter((e) => e.kind === "event" && e.public).length,
      })),
    };

    if (outHtmlPath) {
      mkdirSync(dirname(outHtmlPath), { recursive: true });
      writeFileSync(outHtmlPath, renderDemoHtml(summary));
    }

    return summary;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Runnable directly: tsx prototypes/portal-spike/spike.ts [modelCount] [slicesPerModel] [outHtmlPath]
if (isMainModule(import.meta.url)) {
  const modelCount = Number(process.argv[2] ?? 6);
  const slicesPerModel = Number(process.argv[3] ?? 40);
  const outHtmlPath = process.argv[4] ?? join("prototypes", "portal-spike", "demo-output.html");
  runSpike(modelCount, slicesPerModel, outHtmlPath).then((summary) => {
    console.log(`${summary.modelCount} models, ${summary.totalSlices} slices`);
    console.log(`${summary.crossModelLinks.length} cross-model link(s) resolved`);
    console.log(`timing (ms): ${JSON.stringify(summary.timingMs)}`);
    console.log(`wrote ${outHtmlPath}`);
  });
}
