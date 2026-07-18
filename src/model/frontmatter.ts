// SPDX-License-Identifier: MIT
// Split/parse/stringify a `---\n...\n---\n` YAML frontmatter block. Backed by
// the `yaml` package's Document API so incremental writes (slice sync/update,
// migrate) preserve comments and fields the CLI doesn't know about — external
// tools may own fields in this same block (see docs/1.0.0-spec.md §8).

import { Document, parseDocument } from "yaml";

const DELIMITER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
  /** Parsed YAML data, or null if the file has no frontmatter block. */
  data: Record<string, unknown> | null;
  /** The YAML Document, kept around so writes can preserve comments/formatting. Null if no block. */
  document: Document | null;
  /** Everything after the closing `---`. Equal to the whole input when there's no frontmatter block. */
  body: string;
}

/** Parse a slice doc's leading frontmatter block, if it has one. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(DELIMITER);
  if (!match) return { data: null, document: null, body: raw };

  const [, yamlText, body] = match;
  const document = parseDocument(yamlText);
  const data = (document.toJS() ?? {}) as Record<string, unknown>;
  return { data, document, body };
}

/** Reassemble a `---\n...\n---\n<body>` string from a Document and body text. */
export function stringifyFrontmatter(document: Document, body: string): string {
  const yamlText = document.toString().replace(/\n+$/, "");
  return `---\n${yamlText}\n---\n${body}`;
}

/** Build a fresh Document from a plain object (used when creating a new slice doc). */
export function frontmatterFromData(data: Record<string, unknown>): Document {
  return new Document(data);
}

/**
 * Shallow-merge `patch` into `document` in place, preserving every other key
 * (including ones `em` doesn't know about) and existing comments. Returns the
 * same Document instance for convenience.
 */
export function mergeFrontmatter(document: Document, patch: Record<string, unknown>): Document {
  for (const [key, value] of Object.entries(patch)) {
    document.set(key, value);
  }
  return document;
}
