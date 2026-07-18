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

export interface ListOptions {
  dir?: string;
  status?: SliceStatus;
  pattern?: SlicePattern;
}

export function listSlices(opts: ListOptions = {}): SliceSummary[] {
  const dir = opts.dir ?? process.cwd();
  return loadSliceDocs(dir)
    .map(toSummary)
    .filter((s): s is SliceSummary => s !== null)
    .filter((s) => !opts.status || s.status === opts.status)
    .filter((s) => !opts.pattern || s.pattern === opts.pattern);
}

export function showSlice(id: string, opts: { dir?: string } = {}): SliceDoc | undefined {
  const dir = opts.dir ?? process.cwd();
  return loadSliceDocs(dir).find((d) => d.frontmatter?.id === id);
}

export interface SearchOptions extends ListOptions {
  context?: string;
  tag?: string;
}

export function searchSlices(query: string, opts: SearchOptions = {}): SliceSummary[] {
  const dir = opts.dir ?? process.cwd();
  const q = query.trim().toLowerCase();

  return loadSliceDocs(dir)
    .filter((d) => d.frontmatter)
    .filter((d) => !opts.status || d.frontmatter!.status === opts.status)
    .filter((d) => !opts.pattern || d.frontmatter!.pattern === opts.pattern)
    .filter((d) => !opts.context || asStringArray(d.frontmatter!.contexts).includes(opts.context!))
    .filter((d) => !opts.tag || asStringArray(d.frontmatter!.tags).includes(opts.tag!))
    .filter((d) => q.length === 0 || matchesQuery(d.frontmatter!, q))
    .map(toSummary)
    .filter((s): s is SliceSummary => s !== null);
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

function matchesQuery(data: Record<string, unknown>, q: string): boolean {
  const haystack = [
    data.title,
    ...asStringArray(data.tags),
    ...asStringArray(data.commands),
    ...asStringArray(data.events),
    ...asStringArray(data.readModels),
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
