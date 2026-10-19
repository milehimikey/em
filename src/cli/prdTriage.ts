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
export const TRIAGE_PROVENANCE = ["walkthrough", "reference"] as const;

/** A quote shorter than this is too short to prove anything (`"order"` appears everywhere). */
export const MIN_QUOTE_CHARS = 12;

export interface RubricCategory {
  id: string;
  /** What `aboutBusiness` is expected to be for this category. A statement whose answer contradicts
   *  it must have outcome `question` (the human resolves the disagreement). */
  aboutBusiness: boolean | "either";
  /** Outcomes this category may carry (`question` and `parked` are allowed for every category). */
  outcomes: TriageOutcome[];
  meaning: string;
}

export const PRD_RUBRIC = {
  rubricVersion: "1.0",
  independentCheck: "Is this about the business, independent of how it is built?",
  categories: [
    { id: "business-fact", aboutBusiness: true, outcomes: ["modeled", "rewritten", "parked", "question"], meaning: "Something that happens or is true in the business; candidate event or field." },
    { id: "user-intent", aboutBusiness: true, outcomes: ["modeled", "rewritten", "parked", "question"], meaning: "What an actor wants to accomplish; candidate command with its trigger." },
    { id: "information-need", aboutBusiness: true, outcomes: ["modeled", "rewritten", "parked", "question"], meaning: "What an actor needs to see or know to act; candidate read model." },
    { id: "actor", aboutBusiness: true, outcomes: ["modeled", "parked", "question"], meaning: "A person, role or calling system; candidate persona." },
    { id: "business-rule", aboutBusiness: true, outcomes: ["modeled", "rewritten", "parked", "question"], meaning: "A constraint the business imposes; candidate invariant or scenario." },
    { id: "external-system", aboutBusiness: "either", outcomes: ["modeled", "rewritten", "constraint", "parked", "question"], meaning: "A system outside the boundary; candidate translation slice or constraint." },
    { id: "implementation-detail", aboutBusiness: false, outcomes: ["rewritten", "constraint", "parked", "question"], meaning: "How it is built. Rewritten in business language when it implies a business fact; a real tech choice goes to the constraints list." },
    { id: "nfr", aboutBusiness: "either", outcomes: ["constraint", "parked", "question"], meaning: "Performance, availability, security, compliance: feeds the constitution, never a slice." },
    { id: "goal-background", aboutBusiness: true, outcomes: ["parked", "rewritten", "question"], meaning: "Why the product exists; context for the main storyline, not a slice." },
    { id: "question", aboutBusiness: "either", outcomes: ["question", "parked"], meaning: "An open question in the source; becomes a Socratic question, never an invented answer." },
    { id: "resource-or-endpoint", aboutBusiness: false, outcomes: ["rewritten", "parked", "question"], meaning: "Describes an API resource or endpoint. Rewritten to the intent it serves (one endpoint may carry several); never promoted to a command as-is." },
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
  /** null = a reference-only group, outside every storyline. */
  storyline: string | null;
}

export interface TriageStatement {
  id: string;
  quote: string;
  category: string;
  /** The independent check: is this about the business, independent of how it is built? */
  aboutBusiness: boolean;
  confidence: "high" | "low";
  /** Did the claim come from a walkthrough (the story) or from the resource/endpoint reference? */
  provenance: "walkthrough" | "reference";
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

/** Comparison form for the verbatim check, applied to BOTH sides: Markdown emphasis/code marks
 *  stripped, smart quotes straightened, whitespace collapsed. */
const normQuote = (s: string): string =>
  norm(
    s
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[`*_]/g, ""),
  );

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shape + cross-reference validation of a parsed triage document (no file access). When
 *  `sourceText` is given, also checks every quote appears verbatim (see `normQuote`). Quotes
 *  shorter than MIN_QUOTE_CHARS are always rejected. `referenceOnlyGroups` lists the groups whose
 *  every statement came from the resource/endpoint reference rather than a walkthrough. */
export function validatePrdTriage(
  input: unknown,
  sourceText?: string,
): { ok: true; doc: PrdTriageDoc; referenceOnlyGroups: string[] } | { ok: false; errors: string[] } {
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
    if (normQuote(q).length < MIN_QUOTE_CHARS) {
      err(`${where}: quote is shorter than ${MIN_QUOTE_CHARS} characters ("${q}"); quote the whole claim`);
    } else if (sourceText !== undefined && !normQuote(sourceText).includes(normQuote(q))) {
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
  const storylineSpan = new Map<string, string>();
  let mains = 0;
  (input.storylines as unknown[]).forEach((raw, i) => {
    const w = `storylines[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, storylineIds, raw.id)) return;
    if (!nonEmpty(raw.name)) err(`${w} ${raw.id}: name required`);
    if (typeof raw.main !== "boolean") err(`${w} ${raw.id}: main must be a boolean`);
    else if (raw.main) mains++;
    if (!nonEmpty(raw.quote)) err(`${w} ${raw.id}: quote required (the walkthrough's source span)`);
    else {
      quoteIn(`${w} ${raw.id}`, raw.quote);
      storylineSpan.set(raw.id as string, normQuote(raw.quote));
    }
  });
  if (storylineIds.size === 0) err("storylines must name at least one storyline (the main end-to-end journey)");
  else if (mains !== 1) err(`exactly one storyline must be main (found ${mains})`);

  const groupIds = new Set<string>();
  const groupStoryline = new Map<string, string | null>();
  const groupName = new Map<string, string>();
  (input.groups as unknown[]).forEach((raw, i) => {
    const w = `groups[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, groupIds, raw.id)) return;
    groupStoryline.set(raw.id as string, typeof raw.storyline === "string" ? raw.storyline : null);
    groupName.set(raw.id as string, typeof raw.name === "string" ? raw.name : (raw.id as string));
    for (const k of ["name", "trigger", "actor"]) if (!nonEmpty(raw[k])) err(`${w} ${raw.id}: ${k} required`);
    // null = a reference-only group (outside every storyline); verified against its statements below.
    if (raw.storyline !== null && (!nonEmpty(raw.storyline) || !storylineIds.has(raw.storyline))) {
      err(`${w} ${raw.id}: storyline must name a declared storyline, or be null for a reference-only group`);
    }
  });

  const statementIds = new Set<string>();
  const byId = new Map<string, Record<string, unknown>>();
  const usedGroups = new Set<string>();
  const groupMembers = new Map<string, Record<string, unknown>[]>();
  const quoteOwner = new Map<string, string>();
  (input.statements as unknown[]).forEach((raw, i) => {
    const w = `statements[${i}]`;
    if (!isObj(raw)) return err(`${w}: must be an object`);
    if (!seen(w, statementIds, raw.id)) return;
    const id = raw.id as string;
    byId.set(id, raw);
    const at = `${w} ${id}`;
    if (!nonEmpty(raw.quote)) err(`${at}: quote required`);
    else {
      quoteIn(at, raw.quote);
      const nq = normQuote(raw.quote);
      const prior = quoteOwner.get(nq);
      if (prior !== undefined) err(`${at}: quote duplicates statement ${prior}'s; one statement per claim`);
      else quoteOwner.set(nq, id);
      // Provenance is checked, not declared: walkthrough quotes lie inside a storyline span,
      // reference quotes lie outside every span.
      const inside = [...storylineSpan].filter(([, span]) => span.includes(nq)).map(([sid]) => sid);
      if (raw.provenance === "walkthrough" && inside.length === 0) {
        err(`${at}: provenance is walkthrough but its quote lies inside no storyline's span (a walkthrough statement must quote a storyline's span)`);
      }
      if (raw.provenance === "reference" && inside.length > 0) {
        err(`${at}: provenance is reference but its quote lies inside storyline ${inside[0]}'s span (a reference statement must quote text outside every storyline span)`);
      }
    }

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
    if (!(TRIAGE_PROVENANCE as readonly string[]).includes(raw.provenance as string)) err(`${at}: provenance must be walkthrough or reference`);
    // The independent check contradicting the category's expectation is a disagreement: a human's call.
    if (cat && cat.aboutBusiness !== "either" && typeof raw.aboutBusiness === "boolean" && raw.aboutBusiness !== cat.aboutBusiness && outcome !== "question") {
      err(`${at}: aboutBusiness is ${raw.aboutBusiness} but category ${cat.id} expects ${cat.aboutBusiness}; a disagreement must have outcome question (carry the proposed rewrite in the question), not ${outcome}`);
    }

    const needsGroup = outcome === "modeled" || outcome === "rewritten";
    if (needsGroup || (outcome === "question" && raw.group !== null && raw.group !== undefined)) {
      if (!nonEmpty(raw.group) || !groupIds.has(raw.group)) err(`${at}: outcome ${outcome} needs a group naming a declared group`);
      else {
        usedGroups.add(raw.group);
        const members = groupMembers.get(raw.group) ?? [];
        members.push(raw);
        groupMembers.set(raw.group, members);
      }
      const gs = nonEmpty(raw.group) && groupStoryline.has(raw.group) ? groupStoryline.get(raw.group) : undefined;
      if (gs === null) {
        if (raw.storyline !== null && raw.storyline !== undefined) err(`${at}: its group ${String(raw.group)} is reference-only (storyline null), so the statement's storyline must be null`);
      } else if (!nonEmpty(raw.storyline) || !storylineIds.has(raw.storyline)) {
        err(`${at}: outcome ${outcome} needs a storyline naming a declared storyline`);
      } else if (gs !== undefined && gs !== raw.storyline) {
        err(`${at}: storyline ${raw.storyline} differs from its group ${String(raw.group)}'s storyline ${gs}`);
      }
    } else if (raw.group !== null && raw.group !== undefined) {
      err(`${at}: outcome ${outcome} must have group null (only modeled/rewritten statements join a slice group; a question may name the group it would join)`);
    }
    if (outcome === "rewritten" && !nonEmpty(raw.rewrite)) err(`${at}: outcome rewritten needs a rewrite (business-language text)`);
    if (outcome === "parked" && !nonEmpty(raw.reason)) err(`${at}: outcome parked needs a reason (it also goes in the Decisions log)`);
    if (outcome === "question" && !nonEmpty(raw.question)) err(`${at}: outcome question needs a question`);
    if (cat?.id === "resource-or-endpoint" && outcome === "modeled") {
      err(`${at}: a resource-or-endpoint statement is never modeled as-is; rewrite it to the intent it serves`);
    }
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

  // Walkthrough-first: a group is EITHER anchored (a walkthrough statement whose quote lies inside
  // its named storyline's span) OR reference-only (every statement `reference`, the group and its
  // statements outside every storyline: storyline null). Reference-only groups are listed in the
  // report for the human to inspect.
  const referenceOnlyGroups: string[] = [];
  for (const g of groupIds) {
    const members = groupMembers.get(g);
    if (!members) continue;
    const named = groupStoryline.get(g) ?? null;
    if (members.every((m) => m.provenance === "reference")) {
      if (named !== null) err(`group ${g}: every statement is reference, so it is a reference-only group and must have storyline null (it joins no walkthrough storyline), not ${named}`);
      else referenceOnlyGroups.push(groupName.get(g) ?? g);
      continue;
    }
    if (named === null) {
      err(`group ${g}: storyline is null but it has walkthrough statements; name the storyline they advance`);
      continue;
    }
    const span = storylineSpan.get(named);
    const anchored = members.some((m) => m.provenance === "walkthrough" && span !== undefined && typeof m.quote === "string" && span.includes(normQuote(m.quote)));
    if (!anchored) err(`group ${g}: no walkthrough statement lies inside storyline ${named}'s span; anchor it in that walkthrough, or move it to a reference-only group`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc: input as unknown as PrdTriageDoc, referenceOnlyGroups };
}

export type CheckPrdTriageResult =
  | { ok: true; path: string; source: string; statements: number; storylines: number; groups: number; referenceOnlyGroups: string[]; errors: [] }
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
    referenceOnlyGroups: shape.referenceOnlyGroups,
    errors: [],
  };
}

/** `em discover triage-check --json` document. */
export function buildCheckPrdTriageJson(result: CheckPrdTriageResult): string {
  const doc = result.ok
    ? { ok: true, path: result.path, source: result.source, storylines: result.storylines, groups: result.groups, statements: result.statements, referenceOnlyGroups: result.referenceOnlyGroups, errors: [] as string[] }
    : { ok: false, path: result.path, errors: result.errors };
  return JSON.stringify(doc, null, 2);
}

/** The Markdown view of a triage record (`--markdown`): deterministic, for the engagement reader. */
export function renderPrdTriageMarkdown(doc: PrdTriageDoc, referenceOnlyGroups: string[] = []): string {
  const L: string[] = ["# PRD triage", "", `Source: \`${doc.source}\` · rubric ${doc.rubricVersion} · schema ${doc.prdTriageSchemaVersion}`, ""];
  L.push("## Storylines", "");
  for (const s of doc.storylines) L.push(`- **${s.name}**${s.main ? " (main)" : ""} — "${norm(s.quote)}"`);
  L.push("", "## Slice groups", "");
  for (const g of doc.groups) {
    L.push(`### ${g.name}`, "", `Storyline: ${g.storyline ?? "none (reference-only)"} · trigger: ${g.trigger} · acting: ${g.actor}`, "");
    for (const s of doc.statements.filter((x) => x.group === g.id)) {
      const body = s.outcome === "rewritten" ? `${s.rewrite} _(from: "${norm(s.quote)}")_` : `"${norm(s.quote)}"`;
      L.push(`- \`${s.id}\` [${s.category}] ${body}${s.scenarioOf ? ` — scenario of ${s.scenarioOf}` : ""}`);
    }
    L.push("");
  }
  if (referenceOnlyGroups.length > 0) {
    L.push("## Reference-only groups — operations no walkthrough touches; check these are not CRUD fill", "");
    for (const g of referenceOnlyGroups) L.push(`- ${g}`);
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
