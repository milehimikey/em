// SPDX-License-Identifier: MIT
// `em slice sync` — the one command that reads the .em and (re)writes the
// generated frontmatter fields (commands/events/readModels/contexts/personas/
// triggers/triggeredBy). Everything else (`list`/`show`/`search`) trusts this
// cache instead of re-deriving it. See docs/1.0.0-spec.md §6.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "../parser/parser.js";
import { normalize } from "../model/model.js";
import { buildDocIdByElementId, deriveGeneratedFields } from "../model/deriveSliceFields.js";
import { mergeFrontmatter, stringifyFrontmatter } from "../model/frontmatter.js";
import { loadSliceDocs, SliceDoc } from "../model/sliceDoc.js";
import { findModelFile } from "../util/findModel.js";

export interface SyncOptions {
  dir?: string;
  modelPath?: string;
}

export interface SyncResult {
  id: string;
  path: string;
  changed: boolean;
}

export interface SyncAllResult {
  synced: SyncResult[];
  skipped: { file: string; reason: string }[];
}

const GENERATED_KEYS = ["commands", "events", "readModels", "contexts", "personas"] as const;

export function syncSlice(id: string, opts: SyncOptions = {}): SyncResult {
  const dir = opts.dir ?? process.cwd();
  const modelPath = findModelFile(dir, opts.modelPath);
  const model = normalize(parse(readFileSync(modelPath, "utf8")));
  const docs = loadSliceDocs(dir);

  const doc = docs.find((d) => d.frontmatter?.id === id);
  if (!doc || !doc.frontmatter || !doc.document) {
    throw new Error(`no slice doc with id "${id}" (with valid frontmatter) found in ${dir}`);
  }

  const rawSliceElement = doc.frontmatter.sliceElement;
  let sliceElementId: string;
  if (typeof rawSliceElement === "string" && rawSliceElement.length > 0) {
    sliceElementId = rawSliceElement;
  } else {
    // Not set yet — discover it from the .em side: the element whose `note`
    // points back at this doc (the agent wires that in after `em slice new`).
    const discovered = model.elements.find(
      (el) => el.note && resolve(dirname(modelPath), el.note) === resolve(doc.path),
    );
    if (!discovered) {
      throw new Error(
        `slice "${id}" has no sliceElement set — wire \`note "slices/${doc.file}"\` onto an ` +
          `element in ${modelPath} first, then re-run sync`,
      );
    }
    sliceElementId = discovered.id;
  }

  const docIdByElementId = buildDocIdByElementId(model, docs);
  const derived = deriveGeneratedFields(model, sliceElementId, docIdByElementId);
  if (!derived) {
    throw new Error(`sliceElement "${sliceElementId}" does not match any element in ${modelPath}`);
  }

  const before = doc.document.toJS() as Record<string, unknown>;
  const changed =
    before.sliceElement !== sliceElementId ||
    GENERATED_KEYS.some((key) => JSON.stringify(before[key] ?? []) !== JSON.stringify(derived[key])) ||
    before.triggers !== derived.triggers ||
    before.triggeredBy !== derived.triggeredBy;

  mergeFrontmatter(doc.document, { sliceElement: sliceElementId });
  for (const key of GENERATED_KEYS) mergeFrontmatter(doc.document, { [key]: derived[key] });
  setOrDelete(doc, "triggers", derived.triggers);
  setOrDelete(doc, "triggeredBy", derived.triggeredBy);

  writeFileSync(doc.path, stringifyFrontmatter(doc.document, doc.body));
  return { id, path: doc.path, changed };
}

export function syncAll(opts: SyncOptions = {}): SyncAllResult {
  const dir = opts.dir ?? process.cwd();
  const docs = loadSliceDocs(dir);
  const synced: SyncResult[] = [];
  const skipped: { file: string; reason: string }[] = [];

  for (const doc of docs) {
    const id = doc.frontmatter?.id;
    if (typeof id !== "string") {
      skipped.push({ file: doc.file, reason: "no frontmatter (or no `id`); run `em migrate`" });
      continue;
    }
    try {
      synced.push(syncSlice(id, opts));
    } catch (e) {
      skipped.push({ file: doc.file, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { synced, skipped };
}

function setOrDelete(doc: SliceDoc, key: string, value: string | undefined): void {
  if (value === undefined) doc.document!.delete(key);
  else mergeFrontmatter(doc.document!, { [key]: value });
}
