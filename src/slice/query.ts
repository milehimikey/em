// SPDX-License-Identifier: MIT
// `em slice list|show|search|update` — reads (and, for `update`, writes)
// frontmatter only. Never the doc body, never the .em. That's what keeps
// these cheap across hundreds of slices — see docs/1.0.0-spec.md §6.

import { writeFileSync } from "node:fs";
import { mergeFrontmatter, stringifyFrontmatter } from "../model/frontmatter.js";
import { loadSliceDocs, SliceDoc, SlicePattern, SliceStatus } from "../model/sliceDoc.js";

export interface SliceSummary {
  id: string;
  title: string;
  pattern: SlicePattern | undefined;
  status: SliceStatus | undefined;
  version: number | undefined;
  file: string;
}

/**
 * A doc's complete frontmatter, plus the `file` it came from so a caller can
 * open it without a second lookup. `file` is set after the spread, so it wins
 * over a frontmatter key of the same name — treat `file` as reserved.
 */
export type SliceRecord = Record<string, unknown> & { file: string };

export interface ListOptions {
  dir?: string;
  status?: SliceStatus;
  pattern?: SlicePattern;
  context?: string;
  tag?: string;
}

/** The one filter path. Every list/search entry point narrows docs through this. */
function selectDocs(opts: ListOptions, query = ""): SliceDoc[] {
  const dir = opts.dir ?? process.cwd();
  const q = query.trim().toLowerCase();

  return loadSliceDocs(dir)
    .filter((d) => typeof d.frontmatter?.id === "string")
    .filter((d) => !opts.status || d.frontmatter!.status === opts.status)
    .filter((d) => !opts.pattern || d.frontmatter!.pattern === opts.pattern)
    .filter((d) => !opts.context || asStringArray(d.frontmatter!.contexts).includes(opts.context!))
    .filter((d) => !opts.tag || asStringArray(d.frontmatter!.tags).includes(opts.tag!))
    .filter((d) => q.length === 0 || matchesQuery(d.frontmatter!, q));
}

export function listSlices(opts: ListOptions = {}): SliceSummary[] {
  return selectDocs(opts).map(toSummary).filter((s): s is SliceSummary => s !== null);
}

/** Same selection as listSlices, but every frontmatter field rather than the summary. */
export function listSliceRecords(opts: ListOptions = {}): SliceRecord[] {
  return selectDocs(opts).map(toRecord);
}

export function showSlice(id: string, opts: { dir?: string } = {}): SliceDoc | undefined {
  const dir = opts.dir ?? process.cwd();
  return loadSliceDocs(dir).find((d) => d.frontmatter?.id === id);
}

export type SearchOptions = ListOptions;

export function searchSlices(query: string, opts: SearchOptions = {}): SliceSummary[] {
  return selectDocs(opts, query).map(toSummary).filter((s): s is SliceSummary => s !== null);
}

/** Same selection as searchSlices, but every frontmatter field rather than the summary. */
export function searchSliceRecords(query: string, opts: SearchOptions = {}): SliceRecord[] {
  return selectDocs(opts, query).map(toRecord);
}

export interface UpdateOptions {
  dir?: string;
  status?: SliceStatus;
  bumpVersion?: boolean;
}

export function updateSlice(id: string, opts: UpdateOptions = {}): { path: string } {
  const dir = opts.dir ?? process.cwd();
  const doc = loadSliceDocs(dir).find((d) => d.frontmatter?.id === id);
  if (!doc || !doc.document || !doc.frontmatter) {
    throw new Error(`no slice doc with id "${id}" (with valid frontmatter) found in ${dir}`);
  }

  const patch: Record<string, unknown> = {};
  if (opts.status) patch.status = opts.status;
  if (opts.bumpVersion) {
    const current = typeof doc.frontmatter.version === "number" ? doc.frontmatter.version : 0;
    patch.version = current + 1;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to update — pass --status and/or --bump-version");
  }
  patch.updated = new Date().toISOString().slice(0, 10);

  mergeFrontmatter(doc.document, patch);
  writeFileSync(doc.path, stringifyFrontmatter(doc.document, doc.body));
  return { path: doc.path };
}

function toSummary(doc: SliceDoc): SliceSummary | null {
  const data = doc.frontmatter;
  if (!data || typeof data.id !== "string") return null;
  return {
    id: data.id,
    title: typeof data.title === "string" ? data.title : data.id,
    pattern: data.pattern as SlicePattern | undefined,
    status: data.status as SliceStatus | undefined,
    version: typeof data.version === "number" ? data.version : undefined,
    file: doc.file,
  };
}

function toRecord(doc: SliceDoc): SliceRecord {
  return { ...doc.frontmatter, file: doc.file };
}

function matchesQuery(data: Record<string, unknown>, q: string): boolean {
  const haystack = [
    data.title,
    ...asStringArray(data.tags),
    ...asStringArray(data.commands),
    ...asStringArray(data.events),
    ...asStringArray(data.readModels),
    // `compliance` is a reserved, unvalidated block (docs/1.0.0-spec.md §2.6) — its shape isn't
    // known, so flatten whatever's there rather than reading named sub-fields. Without this,
    // freeform compliance data (PCI-DSS, SOX, HIPAA, ...) would be the one thing in frontmatter
    // an agent couldn't search for.
    data.compliance !== undefined ? JSON.stringify(data.compliance) : undefined,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
