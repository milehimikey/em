// SPDX-License-Identifier: MIT
// `em migrate` — one-time upgrade from the pre-1.0 fixed-template format to
// the frontmatter standard (docs/1.0.0-spec.md §7). planMigration() is pure;
// applyMigration() is the only thing that writes, so --dry-run is just
// "compute the plan, don't call apply."

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { normalize } from "../model/model.js";
import { parse } from "../parser/parser.js";
import { buildDocIdByElementId, deriveGeneratedFields } from "../model/deriveSliceFields.js";
import { frontmatterFromData, parseFrontmatter, stringifyFrontmatter } from "../model/frontmatter.js";
import { loadSliceDocs, SliceDoc, SlicePattern, SliceStatus } from "../model/sliceDoc.js";
import { CURRENT_SCHEMA_VERSION } from "../model/validateSliceDocs.js";
import { findModelFile } from "../util/findModel.js";
import { dedupe, kebabSlug } from "../util/slug.js";

export interface MigrateOptions {
  modelPath?: string;
}

export interface MigrationNote {
  file: string;
  message: string;
}

export interface DocPlan {
  path: string;
  file: string;
  alreadyMigrated: boolean;
  /** New file content to write. Undefined when alreadyMigrated. */
  content?: string;
}

export interface MigrationPlan {
  dir: string;
  modelPath: string;
  docs: DocPlan[];
  stateFile?: DocPlan;
  notes: MigrationNote[];
}

const PATTERN_FROM_PROSE: Record<string, SlicePattern> = {
  "state change": "state-change",
  "state view": "state-view",
  automation: "automation",
  translation: "translation",
};

const STATUS_FROM_PROSE: Record<string, SliceStatus> = {
  draft: "draft",
  reviewed: "reviewed",
  "ready-to-implement": "ready-to-implement",
};

export function planMigration(dir: string, opts: MigrateOptions = {}): MigrationPlan {
  const modelPath = findModelFile(dir, opts.modelPath);
  const model = normalize(parse(readFileSync(modelPath, "utf8")));
  const docs = loadSliceDocs(dir);
  const notes: MigrationNote[] = [];

  const usedIds = new Set<string>();
  for (const doc of docs) {
    if (typeof doc.frontmatter?.id === "string") usedIds.add(doc.frontmatter.id);
  }

  interface Draft {
    doc: SliceDoc;
    id: string;
    title: string;
    pattern: SlicePattern;
    status: SliceStatus;
    sliceElementId?: string;
    upstreamEvents: string[];
  }
  const drafts: Draft[] = [];

  for (const doc of docs) {
    if (typeof doc.frontmatter?.schemaVersion === "number") continue; // already migrated

    const heading = doc.raw.match(/^#\s*Slice:\s*(.+)$/m);
    const title = heading ? heading[1].trim() : doc.file.replace(/\.md$/, "");

    const linkedElement = model.elements.find(
      (el) => el.note && resolve(dirname(modelPath), el.note) === resolve(doc.path),
    );

    let pattern: SlicePattern;
    let sliceElementId: string | undefined;
    if (linkedElement) {
      sliceElementId = linkedElement.id;
      pattern = patternFromElementKind(linkedElement.kind);
    } else {
      const proseMatch = doc.raw.match(/\*\*Pattern:\*\*\s*([A-Za-z ]+)/);
      const key = proseMatch?.[1].trim().toLowerCase();
      const resolved = key ? PATTERN_FROM_PROSE[key] : undefined;
      pattern = resolved ?? "state-change";
      notes.push({
        file: doc.path,
        message: resolved
          ? "no .em element links to this doc (orphan); pattern inferred from prose only — please wire a `note` and re-sync"
          : "no .em element links to this doc and its pattern couldn't be inferred from prose; defaulted to state-change — please review",
      });
    }

    const statusMatch = doc.raw.match(/\*\*Status:\*\*\s*([A-Za-z- ]+)/);
    const statusKey = statusMatch?.[1].trim().toLowerCase();
    const resolvedStatus = statusKey ? STATUS_FROM_PROSE[statusKey] : undefined;
    const status: SliceStatus = resolvedStatus ?? "draft";
    if (!resolvedStatus) {
      notes.push({
        file: doc.path,
        message: "status couldn't be confidently inferred from prose; defaulted to draft",
      });
    }

    const id = dedupe(kebabSlug(title), usedIds, "-");

    const upstreamMatch = doc.raw.match(/\*\*Upstream events this slice relies on:\*\*\s*(.+)/);
    const upstreamEvents = upstreamMatch
      ? upstreamMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter((s) => s.length > 0 && !/^\{\{.*\}\}$/.test(s))
      : [];
    if (upstreamMatch && upstreamEvents.length === 0) {
      notes.push({ file: doc.path, message: "upstream events line found but unparseable; left empty" });
    }

    drafts.push({ doc, id, title, pattern, status, sliceElementId, upstreamEvents });
  }

  // Cross-doc id index (already-migrated docs + newly planned drafts) so
  // triggers/triggeredBy resolve even between two docs migrated in the same run.
  const docIdByElementId = buildDocIdByElementId(model, docs);
  for (const d of drafts) {
    if (d.sliceElementId) docIdByElementId.set(d.sliceElementId, d.id);
  }

  const docPlans: DocPlan[] = docs.map((doc) => {
    const draft = drafts.find((d) => d.doc === doc);
    if (!draft) return { path: doc.path, file: doc.file, alreadyMigrated: true };

    const today = new Date().toISOString().slice(0, 10);
    const data: Record<string, unknown> = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: draft.id,
      title: draft.title,
      pattern: draft.pattern,
      status: draft.status,
      version: 1,
      model: relative(dirname(doc.path), modelPath),
      created: today,
      updated: today,
    };
    if (draft.sliceElementId) {
      data.sliceElement = draft.sliceElementId;
      const derived = deriveGeneratedFields(model, draft.sliceElementId, docIdByElementId);
      if (derived) {
        data.commands = derived.commands;
        data.events = derived.events;
        data.readModels = derived.readModels;
        data.contexts = derived.contexts;
        data.personas = derived.personas;
        if (derived.triggers) data.triggers = derived.triggers;
        if (derived.triggeredBy) data.triggeredBy = derived.triggeredBy;
      }
    }
    if (draft.upstreamEvents.length > 0) data.upstreamEvents = draft.upstreamEvents;

    const content = stringifyFrontmatter(frontmatterFromData(data), stripLegacyBullets(doc.body));
    return { path: doc.path, file: doc.file, alreadyMigrated: false, content };
  });

  const stateFile = planStateFile(dir, modelPath);

  return { dir, modelPath, docs: docPlans, stateFile, notes };
}

function planStateFile(dir: string, modelPath: string): DocPlan | undefined {
  const stateFilePath = join(dir, ".event-modeling.md");
  if (!existsSync(stateFilePath)) return undefined;

  const raw = readFileSync(stateFilePath, "utf8");
  const { data } = parseFrontmatter(raw);
  if (data && typeof data.schemaVersion === "number") {
    return { path: stateFilePath, file: ".event-modeling.md", alreadyMigrated: true };
  }

  const fmData = { schemaVersion: CURRENT_SCHEMA_VERSION, model: relative(dir, modelPath) };
  const content = stringifyFrontmatter(frontmatterFromData(fmData), raw);
  return { path: stateFilePath, file: ".event-modeling.md", alreadyMigrated: false, content };
}

function patternFromElementKind(kind: string): SlicePattern {
  if (kind === "command") return "state-change";
  if (kind === "translation") return "translation";
  if (kind === "processor" || kind === "automation" || kind === "saga") return "automation";
  return "state-view";
}

function stripLegacyBullets(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^-\s*\*\*(Pattern|Status):\*\*/.test(line.trim()))
    .join("\n");
}

export function applyMigration(plan: MigrationPlan): void {
  for (const doc of plan.docs) {
    if (!doc.alreadyMigrated && doc.content !== undefined) writeFileSync(doc.path, doc.content);
  }
  if (plan.stateFile && !plan.stateFile.alreadyMigrated && plan.stateFile.content !== undefined) {
    writeFileSync(plan.stateFile.path, plan.stateFile.content);
  }
}

export function formatMigrationReport(plan: MigrationPlan): string {
  const changed = plan.docs.filter((d) => !d.alreadyMigrated);
  const skipped = plan.docs.filter((d) => d.alreadyMigrated);

  const lines: string[] = [`# em migrate report — ${plan.dir}`, "", `Model: ${plan.modelPath}`, ""];
  lines.push(`## Migrated (${changed.length})`);
  lines.push(...(changed.length ? changed.map((d) => `- ${d.file}`) : ["(none)"]));
  lines.push("", `## Already migrated, skipped (${skipped.length})`);
  lines.push(...(skipped.length ? skipped.map((d) => `- ${d.file}`) : ["(none)"]));
  if (plan.stateFile) {
    lines.push(
      "",
      `## State file: ${plan.stateFile.alreadyMigrated ? "already migrated, skipped" : "migrated"}`,
    );
  }
  lines.push("", `## Flagged for review (${plan.notes.length})`);
  lines.push(...(plan.notes.length ? plan.notes.map((n) => `- ${n.file}: ${n.message}`) : ["(none)"]));

  return lines.join("\n") + "\n";
}

/** Throws unless `dir` is a clean git working tree (or `force` is set). Git is the undo mechanism. */
export function assertCleanWorkingTree(dir: string, force?: boolean): void {
  if (force) return;

  let output: string;
  try {
    output = execFileSync("git", ["-C", dir, "status", "--porcelain", "."], { encoding: "utf8" });
  } catch {
    throw new Error(
      `${dir} doesn't look like it's inside a git repository — em migrate rewrites files in ` +
        `place and relies on git as the undo mechanism; pass --force to proceed anyway`,
    );
  }
  if (output.trim().length > 0) {
    throw new Error(
      `${dir} has uncommitted changes — commit or stash them first (git is em migrate's undo ` +
        `mechanism), or pass --force to proceed anyway`,
    );
  }
}
