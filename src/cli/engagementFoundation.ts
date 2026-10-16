// SPDX-License-Identifier: MIT
// `em engagement foundation` (GH #240): is the foundation PR (implement.md §8 — every event as a
// contract, fields verbatim from the slice docs' Event tables, the entity's tag) actually in the
// code, for the events THIS engagement's slices emit and consume? The engagement precondition used
// to take the human's word for it; in the run that filed the issue, four events were missing a
// field the ratified slice lists, one lacked two, and one implementer concluded the foundation had
// not landed at all. This check answers per event, and says WHICH of three things is wrong —
// `missing-event`, `missing-field`, `missing-tag` — so "foundation absent" and "foundation
// incomplete" stop being the same report.
//
// It is a TEXT check over the target tree, the same discipline as `em coverage`'s citation scan:
// em does not parse Kotlin, TypeScript or Go, and the constitution's "where a slice's code lives"
// rule is prose. An event counts as present when a file under `--code` contains an identifier
// derived from its name (PascalCase `OrderPlaced`, snake `order_placed`, SCREAMING, kebab, or the
// spaced name itself); its fields and tag fields are then looked for IN THOSE FILES (the same
// naming variants). Deterministic, explainable, cheap — and honest about what it is: a match
// proves the contract was written down, not that it type-checks. Pure aside from the fs reads.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel, collectTags } from "../model/model.js";
import { walkDir } from "../util/walkDir.js";
import type { UnitIndex } from "./engagement.js";

export type FoundationStatus = "present" | "incomplete" | "missing-event";

export interface FoundationEvent {
  event: string;
  /** The engagement unit that emits it, or null when a member only consumes it (emitted elsewhere). */
  emittedBy: string | null;
  /** Engagement units that consume it (`from`), model order. */
  consumedBy: string[];
  status: FoundationStatus;
  /** Files (relative to `--code`) in which the event's identifier was found. */
  files: string[];
  /** Model fields not found in any of `files` (empty when present or when the event is missing). */
  missingFields: string[];
  /** Tag fields (identity, composite, external — by their field names) not found in `files`. */
  missingTagFields: string[];
  /** The model declares no tag for this event at all — nothing to verify; the pre-flight
   *  (GH #239, `event-without-tag`) is where that gap is raised. */
  untaggedInModel: boolean;
  /** The identifier variants that were searched for, for the reader's sanity. */
  identifiers: string[];
}

export interface FoundationCheck {
  code: string;
  /** Files scanned (text, under `--code`, skipping build/vendor dirs). */
  scannedFiles: number;
  events: FoundationEvent[];
  counts: { present: number; incomplete: number; missingEvent: number };
  /** True when every event is `present`. */
  ok: boolean;
}

const SKIP_DIR_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", "coverage", ".claude", ".idea", ".gradle", "__pycache__", ".venv", "venv"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/** `Order Placed` → `["OrderPlaced", "order_placed", "ORDER_PLACED", "order-placed", "Order Placed"]`;
 *  `orderId` → `["orderId", "OrderId", "order_id", "ORDER_ID", "order-id"]`. Words come from
 *  spaces, `_`, `-` and camelCase humps; identifiers are matched on word boundaries. */
export function identifierVariants(name: string): string[] {
  const words = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  const pascal = lower.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const camel = pascal[0].toLowerCase() + pascal.slice(1);
  const out = [pascal, camel, lower.join("_"), lower.join("_").toUpperCase(), lower.join("-"), name.trim()];
  return [...new Set(out)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anyVariantIn(text: string, variants: string[]): boolean {
  return variants.some((v) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(v)}(?![A-Za-z0-9_])`).test(text));
}

/** Read every text file under `codeDir` once. */
function readTree(codeDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of walkDir(codeDir, { skipDir: (name) => SKIP_DIR_SEGMENTS.has(name) })) {
    const abs = join(codeDir, rel);
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      const buf = readFileSync(abs);
      if (isLikelyBinary(buf)) continue;
      files.set(rel, buf.toString("utf8"));
    } catch {
      continue; // unreadable — not this check's job
    }
  }
  return files;
}

/**
 * The events the engagement's slices emit or consume, checked against `codeDir`. `members` are the
 * engagement's unit keys; `idx.unitOfSlice` maps a slice index to its unit. Events are listed in
 * model order; a consumed event emitted outside the engagement is still checked (an implementer
 * of the consuming slice imports it from the foundation all the same).
 */
export function checkFoundation(model: NormalizedModel, members: string[], idx: UnitIndex, codeDir: string): FoundationCheck {
  const memberSet = new Set(members);
  const unitOf = (sliceIndex: number) => idx.unitOfSlice[sliceIndex];

  // Which events matter: emitted by a member, or named in a member's `from`.
  const emittedBy = new Map<string, string>();
  const consumedBy = new Map<string, Set<string>>();
  const events = model.elements.filter((el) => el.kind === "event");
  for (const el of events) {
    const unit = unitOf(el.sliceIndex);
    if (memberSet.has(unit)) emittedBy.set(el.name, unit);
  }
  for (const el of model.elements) {
    const unit = unitOf(el.sliceIndex);
    if (!memberSet.has(unit)) continue;
    for (const source of el.from ?? []) {
      if (events.some((e) => e.name === source)) consumedBy.set(source, (consumedBy.get(source) ?? new Set()).add(unit));
    }
  }
  const inScope = events.filter((el) => emittedBy.has(el.name) || consumedBy.has(el.name));
  // De-duplicate by name (an `again` instance of an event is the same contract).
  const seen = new Set<string>();

  const tree = readTree(codeDir);
  const results: FoundationEvent[] = [];
  for (const el of inScope) {
    if (seen.has(el.name)) continue;
    seen.add(el.name);
    const identifiers = identifierVariants(el.name);
    const files = [...tree].filter(([, text]) => anyVariantIn(text, identifiers)).map(([rel]) => rel);
    const isName = (x: string | null | undefined): x is string => typeof x === "string" && x.length > 0;
    const fields = (el.fields ?? []).map((f) => f.name).filter(isName);
    const tagFields = [...new Set(collectTags(el).flatMap((t) => t.fields).filter(isName))];
    const base: Omit<FoundationEvent, "status" | "missingFields" | "missingTagFields"> = {
      event: el.name,
      emittedBy: emittedBy.get(el.name) ?? null,
      consumedBy: [...(consumedBy.get(el.name) ?? [])],
      files,
      untaggedInModel: tagFields.length === 0,
      identifiers,
    };
    if (files.length === 0) {
      results.push({ ...base, status: "missing-event", missingFields: [], missingTagFields: [] });
      continue;
    }
    const corpus = files.map((rel) => tree.get(rel)!).join("\n");
    const missingFields = fields.filter((f) => !anyVariantIn(corpus, identifierVariants(f)));
    const missingTagFields = tagFields.filter((f) => !anyVariantIn(corpus, identifierVariants(f)));
    const status: FoundationStatus = missingFields.length === 0 && missingTagFields.length === 0 ? "present" : "incomplete";
    results.push({ ...base, status, missingFields, missingTagFields });
  }

  const counts = {
    present: results.filter((r) => r.status === "present").length,
    incomplete: results.filter((r) => r.status === "incomplete").length,
    missingEvent: results.filter((r) => r.status === "missing-event").length,
  };
  return { code: codeDir, scannedFiles: tree.size, events: results, counts, ok: counts.incomplete === 0 && counts.missingEvent === 0 };
}

export function formatFoundationText(slug: string, check: FoundationCheck): string {
  const lines = [`engagement "${slug}" foundation check against ${check.code} — ${check.events.length} event(s), ${check.scannedFiles} file(s) scanned`];
  for (const e of check.events) {
    const who = e.emittedBy ? `emitted by ${e.emittedBy}` : `consumed only (${e.consumedBy.join(", ")})`;
    if (e.status === "missing-event") {
      lines.push(`  missing-event  ${e.event} (${who}) — none of ${e.identifiers.slice(0, 3).join(" / ")}… found in any file`);
      continue;
    }
    const where = e.files.length <= 2 ? e.files.join(", ") : `${e.files.slice(0, 2).join(", ")} +${e.files.length - 2}`;
    if (e.status === "present") {
      lines.push(`  present        ${e.event} (${who}) — ${where}${e.untaggedInModel ? " · no tag in the model (see pre-flight)" : ""}`);
      continue;
    }
    const gaps = [
      ...(e.missingFields.length > 0 ? [`missing-field: ${e.missingFields.join(", ")}`] : []),
      ...(e.missingTagFields.length > 0 ? [`missing-tag: ${e.missingTagFields.join(", ")}`] : []),
    ];
    lines.push(`  incomplete     ${e.event} (${who}) — ${where} — ${gaps.join("; ")}`);
  }
  const c = check.counts;
  lines.push(
    check.ok
      ? `ok — the foundation holds every event these slices need (${c.present} present)`
      : `foundation ${c.missingEvent > 0 ? "absent for " + c.missingEvent + " event(s)" : ""}${c.missingEvent > 0 && c.incomplete > 0 ? ", " : ""}${c.incomplete > 0 ? "incomplete for " + c.incomplete + " event(s)" : ""} (${c.present} present)`,
  );
  return lines.join("\n");
}
