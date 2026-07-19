// SPDX-License-Identifier: MIT
// `em slice new` — scaffolds slices/<id>.md: resolves the configured (or
// default) body template, injects the required frontmatter block, and never
// touches the .em (wiring `note "slices/<id>.md"` onto an element stays the
// agent's job — see docs/1.0.0-spec.md §6).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveConfig, resolveSliceTemplatePath } from "../config.js";
import { frontmatterFromData, stringifyFrontmatter } from "../model/frontmatter.js";
import { loadSliceDocs, SlicePattern } from "../model/sliceDoc.js";
import { CURRENT_SCHEMA_VERSION } from "../model/validateSliceDocs.js";
import { findModelFile } from "../util/findModel.js";
import { dedupe, kebabSlug } from "../util/slug.js";
import { syncSlice } from "./sync.js";

export interface NewSliceOptions {
  dir?: string;
  modelPath?: string;
  configPath?: string;
  pattern?: SlicePattern;
  id?: string;
  /** The .em Element.id this doc documents, if already known (skips straight to a synced doc). */
  sliceElement?: string;
  force?: boolean;
}

export interface NewSliceResult {
  path: string;
  id: string;
  modelPath: string;
}

export function newSlice(name: string, opts: NewSliceOptions = {}): NewSliceResult {
  const dir = opts.dir ?? process.cwd();
  const modelPath = findModelFile(dir, opts.modelPath);
  const slicesDir = join(dir, "slices");
  mkdirSync(slicesDir, { recursive: true });

  const existingIds = new Set(
    loadSliceDocs(dir)
      .map((d) => d.frontmatter?.id)
      .filter((id): id is string => typeof id === "string"),
  );

  let id: string;
  if (opts.id) {
    if (existingIds.has(opts.id)) {
      throw new Error(`id "${opts.id}" is already used by another slice doc in ${slicesDir}`);
    }
    id = opts.id;
  } else {
    id = dedupe(kebabSlug(name), existingIds, "-");
  }

  const path = join(slicesDir, `${id}.md`);
  if (existsSync(path) && !opts.force) {
    throw new Error(`refusing to overwrite ${path} (use --force)`);
  }

  const resolvedConfig = resolveConfig(dir, opts.configPath);
  const templatePath = resolveSliceTemplatePath(resolvedConfig);
  const bodyTemplate = readFileSync(templatePath, "utf8");
  const body = bodyTemplate.replaceAll("{{Slice Name}}", name);

  const today = new Date().toISOString().slice(0, 10);
  const data: Record<string, unknown> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    title: name,
    pattern: opts.pattern ?? "state-change",
    status: "draft",
    version: 1,
    model: relative(slicesDir, modelPath),
    created: today,
    updated: today,
  };
  if (opts.sliceElement) data.sliceElement = opts.sliceElement;

  writeFileSync(path, stringifyFrontmatter(frontmatterFromData(data), body));

  if (opts.sliceElement) {
    syncSlice(id, { dir, modelPath });
  }

  return { path, id, modelPath };
}
