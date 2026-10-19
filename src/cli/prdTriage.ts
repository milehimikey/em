// SPDX-License-Identifier: MIT
// GH #295: the PRD/spec discovery path's record — `discovery/prd-triage.json`. The discover skill
// (reference/prd-spec-path.md) walks an input document: walkthroughs -> storylines, split into
// single-claim statements, classify against the SHIPPED rubric, group by reaction, rewrite-don't-
// drop, record. The LLM does the judgment; em does the part that must not be judged: the shape,
// the verbatim quotes (the LLM may reword, never invent — every statement and storyline quotes
// the input and the quote must appear in it), the rubric version, and "every statement has a
// group and an outcome". `em discover triage-check <file>` (cli.ts) and the MCP tool
// `discover_triage_check` are thin wrappers over `checkPrdTriage` below.
//
// The rubric's source of truth for the checker is PRD_RUBRIC here; the same data ships in the
// skill bundle as reference/prd-rubric.md (a ```json block — the bundle is markdown-only) so the
// agent reads it, and test/prdTriage.test.ts asserts the two are identical.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const PRD_TRIAGE_SCHEMA_VERSION = "1.0";

export const TRIAGE_OUTCOMES = ["modeled", "rewritten", "constraint", "parked", "question"] as const;
export type TriageOutcome = (typeof TRIAGE_OUTCOMES)[number];

export const TRIAGE_CONFIDENCE = ["high", "low"] as const;

export interface RubricCategory {
  id: string;
  label: string;
  /** Outcomes this category may carry. */
  outcomes: TriageOutcome[];
  meaning: string;
}

export const PRD_RUBRIC = {
  rubricVersion: "1.0",
  independentCheck: "Is this about the business, independent of how it is built?",
  categories: [
    { id: "business-fact", label: "Business fact", outcomes: ["modeled", "rewritten", "parked"], meaning: "Something that happens or is true in the business; candidate event or field." },
    { id: "user-intent", label: "User intent", outcomes: ["modeled", "rewritten"], meaning: "What an actor wants to accomplish; candidate command with its trigger." },
    { id: "information-need", label: "Information need", outcomes: ["modeled", "rewritten"], meaning: "What an actor needs to see or know to act; candidate read model." },
    { id: "actor", label: "Actor", outcomes: ["modeled", "parked"], meaning: "A person, role or calling system; candidate persona." },
    { id: "business-rule", label: "Business rule", outcomes: ["modeled", "rewritten"], meaning: "A constraint the business imposes; candidate invariant or scenario." },
    { id: "external-system", label: "External system", outcomes: ["modeled", "rewritten", "constraint"], meaning: "A system outside the boundary; candidate translation slice or constraint." },
    { id: "implementation-detail", label: "Implementation detail", outcomes: ["rewritten", "constraint", "parked"], meaning: "How it is built. Rewritten in business language when it implies a business fact; a real tech choice goes to the constraints list." },
    { id: "nfr", label: "Non-functional requirement", outcomes: ["constraint", "parked"], meaning: "Performance, availability, security, compliance: feeds the constitution, never a slice." },
    { id: "goal-background", label: "Goal or background", outcomes: ["parked", "rewritten"], meaning: "Why the product exists; context for the main storyline, not a slice." },
    { id: "question", label: "Question", outcomes: ["question"], meaning: "An open question in the source; becomes a Socratic question, never an invented answer." },
    { id: "resource-or-endpoint", label: "Resource or endpoint description", outcomes: ["rewritten", "question", "parked"], meaning: "Describes an API resource or endpoint. Rewritten to the intent it serves (one endpoint may carry several); never promoted to a command as-is." },
  ] as RubricCategory[],
};

export const RUBRIC_CATEGORY_IDS = PRD_RUBRIC.categories.map((c) => c.id);

export interface TriageStoryline {
  id: string;
  name: string;
  main: boolean;
  quote: string;
}

export interface TriageGroup {
  id: string;
  name: string;
  /** The shared trigger (the reaction or user action) that makes the statements one slice. */
  trigger: string;
  /** The acting system or actor. */
  actor: string;
  storyline: string;
}

export interface TriageStatement {
  id: string;
  quote: string;
  category: string;
  /** The independent check: is this about the business, independent of how it is built? */
  aboutBusiness: boolean;
  confidence: "high" | "low";
  outcome: TriageOutcome;
  group: string | null;
  storyline: string | null;
  /** Business-language rewrite; required when outcome is `rewritten`. */
  rewrite?: string;
  /** Why parked; required when outcome is `parked`. */
  reason?: string;
  /** Socratic question; required when outcome is `question`. */
  question?: string;
  /** For a failure/retry/timeout statement: the group whose slice it is a scenario/outcome of. */
  scenarioOf?: string;
}

export interface TriageConstraint {
  id: string;
  text: string;
  statements: string[];
}

export interface PrdTriageDoc {
  prdTriageSchemaVersion: string;
  rubricVersion: string;
  /** The input document, relative to the triage file (or absolute). */
  source: string;
  storylines: TriageStoryline[];
  groups: TriageGroup[];
  statements: TriageStatement[];
  constraints: TriageConstraint[];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shape + cross-reference validation of a parsed triage document (no file access). When
 *  `sourceText` is given, also checks every quote appears verbatim (whitespace-normalised). */
export function validatePrdTriage(input: unknown, sourceText?: string): { ok: true; doc: PrdTriageDoc } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);
  if (!isObj(input)) return { ok: false, errors: ["top level must be a JSON object"] };

  if (input.prdTriageSchemaVersion !== PRD_TRIAGE_SCHEMA_VERSION) {
    err(`prdTriageSchemaVersion must be "${PRD_TRIAGE_SCHEMA_VERSION}" (got ${JSON.stringify(input.prdTriageSchemaVersion)})`);
  }
  if (input.rubricVersion !== PRD_RUBRIC.rubricVersion) {
    err(`rubricVersion must be "${PRD_RUBRIC.rubricVersion}", the shipped rubric (got ${JSON.stringify(input.rubricVersion)})`);
  }
  if (typeof input.source !== "string" || input.source === "") err("source must be a non-empty string (the input document path)");
  for (const k of ["storylines", "groups", "statements", "constraints"] as const) {
    if (!Array.isArray(input[k])) err(`${k} must be an array`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const quoteIn = (where: string, q: string) => {
    if (sourceText !== undefined && !norm(sourceText).includes(norm(q))) {
      err(`${where}: quote does not appear verbatim in the source: "${q.length > 60 ? q.slice(0, 57) + "..." : q}"`);
    }
  };
  const seen = (kind: string, ids: Set<string>, id: unknown): id is string => {
    if (!nonEmpty(id)) {
      err(`${kind}: id must be a non-empty string`);
      return false;
    }
    if (ids.has(id)) {
      err(`${kind} ${id}: duplicate id`);
      return false;
    }
    ids.add(id);
    return true;
  };

  const storylineIds = new Set<string>();
  let mains = 0;
  (input.storylines as unknown[]).forEach((raw, i) => {
    const w = `storylines[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, storylineIds, raw.id)) return;
    if (!nonEmpty(raw.name)) err(`${w} ${raw.id}: name required`);
    if (typeof raw.main !== "boolean") err(`${w} ${raw.id}: main must be a boolean`);
    else if (raw.main) mains++;
    if (!nonEmpty(raw.quote)) err(`${w} ${raw.id}: quote required (the walkthrough's source span)`);
    else quoteIn(`${w} ${raw.id}`, raw.quote);
  });
  if (storylineIds.size === 0) err("storylines must name at least one storyline (the main end-to-end journey)");
  else if (mains !== 1) err(`exactly one storyline must be main (found ${mains})`);

  const groupIds = new Set<string>();
  (input.groups as unknown[]).forEach((raw, i) => {
    const w = `groups[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, groupIds, raw.id)) return;
    for (const k of ["name", "trigger", "actor"]) if (!nonEmpty(raw[k])) err(`${w} ${raw.id}: ${k} required`);
    if (!nonEmpty(raw.storyline) || !storylineIds.has(raw.storyline)) err(`${w} ${raw.id}: storyline must name a declared storyline`);
  });

  const statementIds = new Set<string>();
  const byId = new Map<string, Record<string, unknown>>();
  const usedGroups = new Set<string>();
  (input.statements as unknown[]).forEach((raw, i) => {
    const w = `statements[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, statementIds, raw.id)) return;
    const id = raw.id as string;
    byId.set(id, raw);
    const at = `${w} ${id}`;
    if (!nonEmpty(raw.quote)) err(`${at}: quote required`);
    else quoteIn(at, raw.quote);

    const cat = PRD_RUBRIC.categories.find((c) => c.id === raw.category);
    if (!cat) err(`${at}: category must be one of ${RUBRIC_CATEGORY_IDS.join(", ")} (got ${JSON.stringify(raw.category)})`);
    if (typeof raw.aboutBusiness !== "boolean") err(`${at}: aboutBusiness must be a boolean (the independent check)`);
    if (!(TRIAGE_CONFIDENCE as readonly string[]).includes(raw.confidence as string)) err(`${at}: confidence must be high or low`);
    const outcome = raw.outcome as TriageOutcome;
    if (!(TRIAGE_OUTCOMES as readonly string[]).includes(outcome)) {
      err(`${at}: outcome must be one of ${TRIAGE_OUTCOMES.join(", ")}`);
      return;
    }
    if (cat && !cat.outcomes.includes(outcome)) err(`${at}: category ${cat.id} may not have outcome ${outcome} (allowed: ${cat.outcomes.join(", ")})`);

    const needsGroup = outcome === "modeled" || outcome === "rewritten";
    if (needsGroup) {
      if (!nonEmpty(raw.group) || !groupIds.has(raw.group)) err(`${at}: outcome ${outcome} needs a group naming a declared group`);
      else usedGroups.add(raw.group);
      if (!nonEmpty(raw.storyline) || !storylineIds.has(raw.storyline)) err(`${at}: outcome ${outcome} needs a storyline naming a declared storyline`);
    } else if (raw.group !== null && raw.group !== undefined) {
      err(`${at}: outcome ${outcome} must have group null (only modeled/rewritten statements join a slice group)`);
    }
    if (outcome === "rewritten" && !nonEmpty(raw.rewrite)) err(`${at}: outcome rewritten needs a rewrite (business-language text)`);
    if (outcome === "parked" && !nonEmpty(raw.reason)) err(`${at}: outcome parked needs a reason (it also goes in the Decisions log)`);
    if (outcome === "question" && !nonEmpty(raw.question)) err(`${at}: outcome question needs a question`);
    if (cat?.id === "resource-or-endpoint" && outcome === "modeled") {
      err(`${at}: a resource-or-endpoint statement is never modeled as-is; rewrite it to the intent it serves`);
    }
    // The independent check disagreeing with a modeling outcome, or low confidence, is a human's call.
    if (raw.aboutBusiness === false && outcome === "modeled") err(`${at}: aboutBusiness is false but outcome is modeled; rewrite it, park it, or ask`);
    if (raw.confidence === "low" && outcome !== "question") err(`${at}: low confidence must become a question, not ${outcome}`);
    if (raw.scenarioOf !== undefined && (!nonEmpty(raw.scenarioOf) || !groupIds.has(raw.scenarioOf))) {
      err(`${at}: scenarioOf must name a declared group`);
    }
  });
  if (statementIds.size === 0) err("statements must not be empty");

  const constrained = new Set<string>();
  (input.constraints as unknown[]).forEach((raw, i) => {
    const w = `constraints[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!nonEmpty(raw.id)) err(`${w}: id required`);
    if (!nonEmpty(raw.text)) err(`${w}: text required`);
    if (!Array.isArray(raw.statements) || raw.statements.length === 0) return err(`${w}: statements must list at least one statement id`);
    for (const s of raw.statements as unknown[]) {
      const st = typeof s === "string" ? byId.get(s) : undefined;
      if (!st) err(`${w}: unknown statement ${JSON.stringify(s)}`);
      else if (st.outcome !== "constraint") err(`${w}: statement ${String(s)} has outcome ${String(st.outcome)}, not constraint`);
      else constrained.add(s as string);
    }
  });
  for (const [id, st] of byId) {
    if (st.outcome === "constraint" && !constrained.has(id)) err(`statement ${id}: outcome constraint but no constraints[] entry lists it`);
  }
  for (const g of groupIds) if (!usedGroups.has(g)) err(`group ${g}: no statement joins it`);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc: input as unknown as PrdTriageDoc };
}

export type CheckPrdTriageResult =
  | { ok: true; path: string; source: string; statements: number; storylines: number; groups: number; errors: [] }
  | { ok: false; path: string; errors: string[] };

/** Check a `discovery/prd-triage.json`. The input document is `opts.source` when given, else the
 *  file's own `source`, resolved relative to the triage file's directory. */
export function checkPrdTriage(path: string, opts: { source?: string } = {}): CheckPrdTriageResult {
  if (!existsSync(path)) return { ok: false, path, errors: [`no such file: ${path}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, path, errors: [`${path} is not valid JSON`] };
  }
  const declared = isObj(parsed) && typeof parsed.source === "string" ? parsed.source : undefined;
  const sourceRef = opts.source ?? declared;
  let sourcePath: string | undefined;
  let sourceText: string | undefined;
  const pre: string[] = [];
  if (sourceRef) {
    sourcePath = opts.source ? resolve(opts.source) : isAbsolute(sourceRef) ? sourceRef : resolve(dirname(path), sourceRef);
    if (!existsSync(sourcePath)) pre.push(`source document not found: ${sourcePath}`);
    else sourceText = readFileSync(sourcePath, "utf8");
  }
  const shape = validatePrdTriage(parsed, sourceText);
  const errors = [...pre, ...(shape.ok ? [] : shape.errors)];
  if (errors.length > 0 || !shape.ok) return { ok: false, path, errors };
  return {
    ok: true,
    path,
    source: sourcePath ?? shape.doc.source,
    statements: shape.doc.statements.length,
    storylines: shape.doc.storylines.length,
    groups: shape.doc.groups.length,
    errors: [],
  };
}

/** `em discover triage-check --json` document. */
export function buildCheckPrdTriageJson(result: CheckPrdTriageResult): string {
  const doc = result.ok
    ? { ok: true, path: result.path, source: result.source, storylines: result.storylines, groups: result.groups, statements: result.statements, errors: [] as string[] }
    : { ok: false, path: result.path, errors: result.errors };
  return JSON.stringify(doc, null, 2);
}

/** The Markdown view of a triage record (`--markdown`): deterministic, for the engagement reader. */
export function renderPrdTriageMarkdown(doc: PrdTriageDoc): string {
  const L: string[] = ["# PRD triage", "", `Source: \`${doc.source}\` · rubric ${doc.rubricVersion} · schema ${doc.prdTriageSchemaVersion}`, ""];
  L.push("## Storylines", "");
  for (const s of doc.storylines) L.push(`- **${s.name}**${s.main ? " (main)" : ""} — "${norm(s.quote)}"`);
  L.push("", "## Slice groups", "");
  for (const g of doc.groups) {
    L.push(`### ${g.name}`, "", `Storyline: ${g.storyline} · trigger: ${g.trigger} · acting: ${g.actor}`, "");
    for (const s of doc.statements.filter((x) => x.group === g.id)) {
      const body = s.outcome === "rewritten" ? `${s.rewrite} _(from: "${norm(s.quote)}")_` : `"${norm(s.quote)}"`;
      L.push(`- \`${s.id}\` [${s.category}] ${body}${s.scenarioOf ? ` — scenario of ${s.scenarioOf}` : ""}`);
    }
    L.push("");
  }
  const withOutcome = (o: TriageOutcome) => doc.statements.filter((s) => s.outcome === o);
  L.push("## Constraints (feed the constitution)", "");
  for (const c of doc.constraints) L.push(`- ${c.text} (${c.statements.join(", ")})`);
  L.push("", "## Parked", "");
  for (const s of withOutcome("parked")) L.push(`- \`${s.id}\` "${norm(s.quote)}" — ${s.reason}`);
  L.push("", "## Questions for the owner", "");
  for (const s of withOutcome("question")) L.push(`- \`${s.id}\` ${s.question} _(source: "${norm(s.quote)}")_`);
  return L.join("\n") + "\n";
}
