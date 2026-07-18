// SPDX-License-Identifier: MIT
// Loads slice design docs (slices/*.md) and their frontmatter. Parsing only —
// no validation here (see validateSliceDocs.ts) and no writing (see
// src/slice/*.ts). Kept separate so "what's on disk" stays cheap and pure.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Document } from "yaml";
import { parseFrontmatter } from "./frontmatter.js";

export type SlicePattern = "state-change" | "state-view" | "automation" | "translation";

export type SliceStatus =
  | "draft"
  | "reviewed"
  | "ready-to-implement"
  | "in-progress"
  | "implemented"
  | "deprecated"
  | "superseded";

/**
 * The frontmatter schema from docs/1.0.0-spec.md §2. This is the *expected*
 * shape for a valid doc — loadSliceDocs() does not enforce it (a doc on disk
 * may be missing fields, mistyped, or have no frontmatter at all; that's what
 * validateSliceDocs() reports). Unknown/external fields always round-trip
 * through SliceDoc.document even though they aren't listed here.
 */
export interface SliceFrontmatter {
  schemaVersion: number;
  id: string;
  title: string;
  pattern: SlicePattern;
  status: SliceStatus;
  version: number;
  model: string;
  sliceElement: string;

  // Generated (kept fresh by `em slice sync`, never hand-authored).
  commands?: string[];
  events?: string[];
  readModels?: string[];
  contexts?: string[];
  personas?: string[];
  triggers?: string;
  triggeredBy?: string;

  // Optional / authored.
  swimlane?: { persona?: string; context?: string };
  upstreamEvents?: string[];
  relatedSlices?: string[];
  tags?: string[];
  owner?: string;
  created?: string;
  updated?: string;
  contentHash?: string;
  supersededBy?: string;
  implementedRef?: string;
}

export interface SliceDoc {
  /** Absolute path to the doc. */
  path: string;
  /** Filename without directory, e.g. "place-order.md". */
  file: string;
  /** Parsed frontmatter, or null if the doc has no `---` block at all. Not validated. */
  frontmatter: Record<string, unknown> | null;
  /** The YAML Document backing `frontmatter`, for round-trip-safe writes. Null alongside frontmatter. */
  document: Document | null;
  /** Everything after the closing `---` (or the whole file, if there's no frontmatter block). */
  body: string;
  /** Full file contents, as read from disk. */
  raw: string;
}

/** Load every `slices/*.md` doc in a model directory. Returns [] if `slices/` doesn't exist. */
export function loadSliceDocs(modelDir: string): SliceDoc[] {
  const slicesDir = join(modelDir, "slices");
  let entries: string[];
  try {
    entries = readdirSync(slicesDir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const path = join(slicesDir, file);
      const raw = readFileSync(path, "utf8");
      const { data, document, body } = parseFrontmatter(raw);
      return { path, file, frontmatter: data, document, body, raw };
    });
}
