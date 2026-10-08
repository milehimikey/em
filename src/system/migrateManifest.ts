// SPDX-License-Identifier: MIT
// Plans the `system.yaml` 1.0 -> 2.0 migration (MIL-235, ruling R3) — the pure half of `em
// upgrade`'s `system-manifest` step (src/cli/upgrade.ts owns detection, fs, compile and the one
// commit). Three rewrites, planned together so the step either writes all of them or none:
//
//  1. every legacy seam `{from, to}` becomes a `consumes <fromModel>:<kind>.<slug>` clause
//     appended to the consuming translation's own line in its `.em` file (a bare-slice `to` —
//     `<model>:<slice>` — resolves to that slice's single reaction, same rule `em system` used);
//  2. every model's manifest `owner:` becomes `owner "<text>"` on that model's `model "Name"`
//     header line (quoted free text as written; a header that already names owners wins);
//  3. the manifest itself is rewritten to 2.0 — `systemSchemaVersion: "2.0"`, `seams:` and every
//     `owner:` removed — through the YAML document API so comments and quoting survive.
//
// Like the verifier, this reads EXPORT DOCUMENTS (refs + element lines) for resolution, never a
// NormalizedModel; the only model text it touches is source-text surgery on the exact lines the
// export points at. Anything it cannot migrate mechanically — a seam whose consumer is not a
// translation (`consumes` is translation-only), a member sourced from an export `.json` (no
// `.em` text to edit), an unresolvable ref — is a refusal with a message, never a partial plan.

import { parseDocument, isMap } from "yaml";
import { indexOfUnquoted, stripComment } from "../parser/lexer.js";
import { AUTOMATION_KINDS } from "../parser/ast.js";
import { formatContractRef, parseContractRef, parseQualifiedRef } from "../model/qualifiedRef.js";
import { SYSTEM_MANIFEST_SCHEMA_VERSION, SystemManifest } from "./manifest.js";
import type { SystemExportDoc, SystemExportElement } from "./verify.js";

export interface MigrationMember {
  /** The manifest key. */
  key: string;
  /** Path the step reads/writes (manifest dir joined with `source`). */
  file: string;
  /** The `.em` source text, or `null` when the member is an `em export --json` document. */
  text: string | null;
  doc: SystemExportDoc;
}

export type ManifestMigrationPlan =
  | {
      ok: true;
      manifestText: string;
      /** Rewritten `.em` files, member order; only files that actually change. */
      files: { file: string; text: string }[];
      /** Human-readable summary lines (one per consumes/owner write), for the step's reason. */
      summary: string[];
    }
  | { ok: false; message: string };

/** Plan the whole migration. `manifest` must be a parsed 1.0 manifest; `members` one entry per
 *  manifest model, same order. */
export function planManifestMigration(manifestText: string, manifest: SystemManifest, members: MigrationMember[]): ManifestMigrationPlan {
  const byKey = new Map(members.map((m) => [m.key, m]));
  // file -> (1-based line -> refs to append), insertion-ordered for stable output.
  const consumesAt = new Map<string, Map<number, string[]>>();
  // file -> (1-based line -> `# …` comment lines carrying each seam's `description`, which has
  // no home in the DSL — kept as a comment above the translation rather than silently dropped).
  const notesAt = new Map<string, Map<number, string[]>>();
  const summary: string[] = [];

  for (const [i, seam] of manifest.seams.entries()) {
    const where = `seams[${i}] (${seam.from} -> ${seam.to})`;
    // --- producer: `<model>:<slice>/<kind>.<slug>` -> `<model>:<kind>.<slug>`
    const from = parseQualifiedRef(seam.from);
    const fromTail = from.ref.includes("/") ? from.ref.slice(from.ref.indexOf("/") + 1) : "";
    const contract = from.modelKey === null ? null : parseContractRef(`${from.modelKey}:${fromTail}`);
    if (!contract) {
      return { ok: false, message: `${where}: \`from\` is not a <modelKey>:<sliceKey>/<event|view>.<slug> ref — fix or drop the seam, then re-run` };
    }
    const ref = formatContractRef(contract.modelKey, contract.kind, contract.slug);

    // --- consumer: an element ref, or a bare slice with exactly one reaction
    const to = parseQualifiedRef(seam.to);
    const consumer = to.modelKey === null ? undefined : byKey.get(to.modelKey);
    if (!consumer) {
      return { ok: false, message: `${where}: \`to\` names no model of this manifest — fix or drop the seam, then re-run` };
    }
    let element: SystemExportElement | undefined;
    if (to.ref.includes("/")) {
      for (const s of consumer.doc.model.slices) element ??= s.elements.find((e) => e.ref === to.ref);
    } else {
      const slice = consumer.doc.model.slices.find((s) => s.key === to.ref);
      const reactions = slice ? slice.elements.filter((e) => AUTOMATION_KINDS.has(e.kind)) : [];
      if (reactions.length === 1) element = reactions[0];
    }
    if (!element) {
      return { ok: false, message: `${where}: \`to\` does not resolve to one reaction in model "${consumer.key}" — fix or drop the seam, then re-run` };
    }
    if (element.kind !== "translation") {
      return {
        ok: false,
        message:
          `${where}: the consumer is ${element.kind} "${element.name}", but \`consumes\` is only valid on translation — ` +
          "make it a translation (it crosses a model boundary) or drop the seam, then re-run",
      };
    }
    if (consumer.text === null) {
      return { ok: false, message: `${where}: model "${consumer.key}" is sourced from an export document, not a .em file — add \`consumes ${ref}\` to its translation by hand` };
    }
    if ((element.consumes ?? []).includes(ref)) continue; // already declared model-side
    const lines = consumesAt.get(consumer.file) ?? new Map<number, string[]>();
    consumesAt.set(consumer.file, lines);
    const refs = lines.get(element.line) ?? [];
    if (!refs.includes(ref)) refs.push(ref);
    lines.set(element.line, refs);
    if (seam.description !== null && seam.description.trim() !== "") {
      const notes = notesAt.get(consumer.file) ?? new Map<number, string[]>();
      notesAt.set(consumer.file, notes);
      notes.set(element.line, [...(notes.get(element.line) ?? []), `${ref} — ${seam.description.trim().replace(/\s+/g, " ")}`]);
    }
  }

  const files: { file: string; text: string }[] = [];
  for (const member of members) {
    const entry = manifest.models.find((m) => m.key === member.key);
    const owner = entry?.owner ?? null;
    const headerOwners = Array.isArray(member.doc.model.owner) ? member.doc.model.owner : [];
    const writeOwner = owner !== null && headerOwners.length === 0;
    const lineEdits = consumesAt.get(member.file);
    if (!writeOwner && !lineEdits) continue;
    if (member.text === null) {
      return { ok: false, message: `model "${member.key}" is sourced from an export document, not a .em file — move its \`owner:\` onto the model header by hand` };
    }
    const eol = member.text.includes("\r\n") ? "\r\n" : "\n";
    const lines = member.text.split(/\r?\n/);
    if (writeOwner) {
      const at = lines.findIndex((l) => /^model(\s|$)/.test(stripComment(l).trim()));
      if (at < 0) {
        return { ok: false, message: `model "${member.key}" (${member.file}) has no \`model "Name"\` header line to carry \`owner "${owner}"\` — add one, then re-run` };
      }
      lines[at] = appendClause(lines[at], `owner ${quote(owner!)}`, false);
      summary.push(`${member.file}: owner ${quote(owner!)}`);
    }
    for (const [line, refs] of lineEdits ?? []) {
      lines[line - 1] = appendClause(lines[line - 1], `consumes ${refs.join(", ")}`, true);
      summary.push(`${member.file}:${line}: consumes ${refs.join(", ")}`);
    }
    // Description comments last, bottom-up, so earlier insertions never shift a later line.
    const notes = [...(notesAt.get(member.file) ?? new Map<number, string[]>()).entries()].sort((a, b) => b[0] - a[0]);
    for (const [line, texts] of notes) {
      const indent = /^\s*/.exec(lines[line - 1])![0];
      lines.splice(line - 1, 0, ...texts.map((t) => `${indent}# ${t}`));
    }
    files.push({ file: member.file, text: lines.join(eol) });
  }

  // --- the manifest itself: same document, 2.0 keys only (comments/quoting preserved).
  const doc = parseDocument(manifestText);
  doc.set("systemSchemaVersion", SYSTEM_MANIFEST_SCHEMA_VERSION);
  doc.delete("seams");
  const models = doc.get("models", true);
  if (isMap(models)) {
    for (const pair of models.items) if (isMap(pair.value)) pair.value.delete("owner");
  }
  let rewritten = String(doc);
  if (!manifestText.endsWith("\n")) rewritten = rewritten.replace(/\n$/, "");
  summary.push(`system.yaml: systemSchemaVersion "${SYSTEM_MANIFEST_SCHEMA_VERSION}" (seams/owner removed)`);
  return { ok: true, manifestText: rewritten, files, summary };
}

/** A `"…"` literal the `.em` lexer decodes back to `text` (`\"` and `\\` escapes). */
function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Append `clause` to one `.em` source line's code — before a trailing `# comment`, and (when
 *  `beforeBlock`) before an element's `{ … }` field-block opener, since clauses on the header
 *  side of the brace are the canonical position. Indentation and the comment are kept. */
function appendClause(raw: string, clause: string, beforeBlock: boolean): string {
  const code = stripComment(raw);
  const comment = raw.slice(code.length);
  const brace = beforeBlock ? indexOfUnquoted(code, "{") : -1;
  if (brace >= 0) {
    return `${code.slice(0, brace).trimEnd()} ${clause} ${code.slice(brace)}${comment}`;
  }
  const trimmed = code.trimEnd();
  return `${trimmed} ${clause}${comment ? ` ${comment.trimStart()}` : code.slice(trimmed.length)}`;
}
