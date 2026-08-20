// SPDX-License-Identifier: MIT
// Line-oriented parser for the `.em` slice-first DSL.
//
// Grammar (whitespace-tolerant, `#` starts a comment):
//
//   model "Name"
//   persona Name
//   context Name
//   slice "Name" [source "url"] {
//     ui    <free text> [@Persona]
//     command <free text>
//     view  <free text> [from "Event"[, "Event2" ...]]
//     event <free text> [@Context] [public]
//     automation|processor|saga|translation <free text>
//   }
//   arrow <From Element> -> <To Element>
//   type "Name" { field: Type, ... }

import {
  ArrowNode,
  AUTOMATION_KINDS,
  ElementKind,
  ElementNode,
  Field,
  ModelNode,
  SliceNode,
  TypeDeclNode,
} from "./ast.js";
import {
  decodeQuoted,
  hasUnterminatedQuote,
  indexOfUnquoted,
  lastIndexOfUnquoted,
  matchQuote,
  splitQuotedList,
  splitTopLevel,
  stripComment,
  unquote,
} from "./lexer.js";

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(`line ${line}: ${message}`);
    this.name = "ParseError";
  }
}

const ELEMENT_KEYWORDS = new Set<ElementKind>([
  "ui",
  "command",
  "view",
  "event",
  "automation",
  "processor",
  "saga",
  "translation",
]);

export function parse(source: string): ModelNode {
  const model: ModelNode = {
    name: "",
    personas: [],
    contexts: [],
    slices: [],
    arrows: [],
    types: [],
  };

  const rawLines = source.split(/\r?\n/);
  let currentSlice: SliceNode | null = null;
  let currentElement: ElementNode | null = null; // open `{ … }` field block
  let currentTypeDecl: TypeDeclNode | null = null; // open `type Name { … }` block

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(rawLines[i]).trim();
    if (line.length === 0) continue;

    // End of a block: an element's field block closes before its slice, and a
    // top-level `type` block closes on its own (it has no enclosing container).
    // A multi-line field block's closing line may itself carry trailing
    // clauses, e.g. `}  note "slices/x.md"` — extract those before dropping
    // the open element. A `type` block supports no clauses at all, so any
    // trailing text after its `}` is a hard parse error.
    if (
      line === "}" ||
      (currentElement && line.startsWith("}")) ||
      (currentTypeDecl && line.startsWith("}"))
    ) {
      if (currentElement) {
        const trailing = line.slice(1).trim();
        if (trailing) {
          const leftover = extractClauses(currentElement, trailing, lineNo);
          if (leftover) {
            throw new ParseError(
              `unrecognized trailing text after '}': '${leftover}'`,
              lineNo,
            );
          }
        }
        currentElement = null;
        continue;
      }
      if (currentTypeDecl) {
        const trailing = line.slice(1).trim();
        if (trailing) {
          throw new ParseError(
            `unrecognized trailing text after '}': '${trailing}' (type declarations support no clauses)`,
            lineNo,
          );
        }
        model.types.push(currentTypeDecl);
        currentTypeDecl = null;
        continue;
      }
      if (currentSlice) {
        model.slices.push(currentSlice);
        currentSlice = null;
        continue;
      }
      throw new ParseError("unexpected '}'", lineNo);
    }

    // Inside an open field block: each line is a field declaration.
    if (currentElement) {
      for (const f of parseInlineFields(line, lineNo, currentElement.kind))
        (currentElement.fields ??= []).push(f);
      continue;
    }

    // Inside an open `type` block: each line is a field declaration too.
    if (currentTypeDecl) {
      currentTypeDecl.fields.push(...parseInlineFields(line, lineNo, "type-decl"));
      continue;
    }

    const [keyword, ...rest] = splitFirstWord(line);
    const remainder = rest.join(" ").trim();

    // Inside a slice: only element declarations are allowed, plus a standalone `tag ...` line
    // (MIL-66's canonical form), which attaches to the most recently declared element rather
    // than opening one of its own. Checked before the element-keyword gate below since `tag`
    // is not itself an ELEMENT_KEYWORD.
    if (currentSlice) {
      if (keyword === "tag") {
        const target = currentSlice.elements[currentSlice.elements.length - 1];
        if (!target) {
          throw new ParseError(
            "a standalone `tag` line must follow an event declared earlier in this slice",
            lineNo,
          );
        }
        if (target.kind !== "event") {
          throw new ParseError(
            `a standalone \`tag\` line must follow an event — "${target.name}" is a ${target.kind}`,
            lineNo,
          );
        }
        const leftover = extractTagClauses(target, `tag ${remainder}`, lineNo);
        if (leftover) {
          throw new ParseError(`unrecognized trailing text in 'tag' clause: '${leftover}'`, lineNo);
        }
        continue;
      }
      if (!ELEMENT_KEYWORDS.has(keyword as ElementKind)) {
        throw new ParseError(
          `'${keyword}' is not valid inside a slice (expected ui/command/view/event/automation/processor/saga/translation or '}')`,
          lineNo,
        );
      }
      // An element may open a `{ … }` field block (inline or multi-line). The brace
      // scan is quote-aware: a literal `{`/`}` inside a quoted clause (e.g.
      // `issue "PUT /widgets/{id}"`) is string content, never a block opener (MIL-122).
      const braceAt = indexOfUnquoted(remainder, "{");
      if (braceAt >= 0) {
        const el = parseElement(keyword as ElementKind, remainder.slice(0, braceAt).trim(), lineNo);
        el.fields = [];
        currentSlice.elements.push(el);
        const after = remainder.slice(braceAt + 1);
        const closeAt = indexOfUnquoted(after, "}");
        const inner = closeAt >= 0 ? after.slice(0, closeAt) : after;
        el.fields.push(...parseInlineFields(inner, lineNo, el.kind));
        if (closeAt < 0) {
          currentElement = el; // block stays open across lines
        } else {
          // Clauses may trail the closing brace on the same line, e.g.
          // `event X { a: UUID } issue "..."` — without this, `note`,
          // `issue`, `from`, `@Tag`, and `again` written after an inline
          // fields block were silently discarded (MIL-65, MIL-74).
          const trailing = after.slice(closeAt + 1).trim();
          if (trailing) {
            const leftover = extractClauses(el, trailing, lineNo);
            if (leftover) {
              throw new ParseError(
                `unrecognized trailing text after '{ … }' block: '${leftover}'`,
                lineNo,
              );
            }
          }
        }
        continue;
      }
      currentSlice.elements.push(
        parseElement(keyword as ElementKind, remainder, lineNo),
      );
      continue;
    }

    // Top level.
    switch (keyword) {
      case "model":
        model.name = unquote(remainder);
        break;
      case "persona":
        pushUnique(model.personas, unquote(remainder));
        break;
      case "context":
        pushUnique(model.contexts, unquote(remainder));
        break;
      case "slice": {
        // Quote-aware so a literal `{` inside a quoted `source "url"` (or the slice
        // name itself) is never mistaken for the block opener (MIL-122).
        const open = lastIndexOfUnquoted(remainder, "{");
        if (open < 0)
          throw new ParseError("slice must open a block with '{'", lineNo);
        let header = remainder.slice(0, open).trim();

        const node: SliceNode = { name: "", elements: [], line: lineNo };

        // `source "url"` clause (valid on any slice, order-independent relative
        // to the name): a link to the ticket/conversation this slice traces
        // back to, so the intake-loop audit chain is machine-traversable
        // through `em export` instead of living only in prose (MIL-69).
        const sourceClause = extractQuotedClause(header, "source", lineNo);
        if (sourceClause) {
          node.source = sourceClause.value;
          header = sourceClause.rest;
        }

        node.name = unquote(header);
        if (!node.name) throw new ParseError("slice requires a name", lineNo);
        currentSlice = node;
        break;
      }
      case "arrow":
        model.arrows.push(parseArrow(remainder, lineNo));
        break;
      case "type": {
        const braceAt = indexOfUnquoted(remainder, "{");
        if (braceAt < 0) throw new ParseError("type must open a block with '{'", lineNo);
        const name = unquote(remainder.slice(0, braceAt).trim());
        if (!name) throw new ParseError("type requires a name", lineNo);
        const decl: TypeDeclNode = { name, fields: [], line: lineNo };
        const after = remainder.slice(braceAt + 1);
        const closeAt = indexOfUnquoted(after, "}");
        const inner = closeAt >= 0 ? after.slice(0, closeAt) : after;
        decl.fields.push(...parseInlineFields(inner, lineNo, "type-decl"));
        if (closeAt < 0) {
          currentTypeDecl = decl; // block stays open across lines
        } else {
          const trailing = after.slice(closeAt + 1).trim();
          if (trailing) {
            throw new ParseError(
              `unrecognized trailing text after '{ … }' block: '${trailing}' (type declarations support no clauses)`,
              lineNo,
            );
          }
          model.types.push(decl);
        }
        break;
      }
      default:
        throw new ParseError(`unknown keyword '${keyword}'`, lineNo);
    }
  }

  if (currentElement) {
    throw new ParseError(
      `field block for "${currentElement.name}" is missing a closing '}'`,
      currentElement.line,
    );
  }
  if (currentTypeDecl) {
    throw new ParseError(
      `type "${currentTypeDecl.name}" is missing a closing '}'`,
      currentTypeDecl.line,
    );
  }
  if (currentSlice) {
    throw new ParseError(
      `slice "${currentSlice.name}" is missing a closing '}'`,
      currentSlice.line,
    );
  }
  if (!model.name) model.name = "Event Model";

  return model;
}

function parseElement(
  kind: ElementKind,
  raw: string,
  line: number,
): ElementNode {
  const node: ElementNode = { kind, name: "", line };
  const rest = extractClauses(node, raw, line);
  node.name = unquote(rest);
  if (!node.name) throw new ParseError(`${kind} requires a name`, line);
  return node;
}

/**
 * Pulls a `keyword "value"` clause out of `rest`, case-insensitively, honouring
 * `\"`/`\\` escapes inside the string (decoded in the returned `value`) and a
 * literal `{`/`}`/`#` anywhere inside it — string content is never re-interpreted
 * as block or comment syntax (MIL-122). Returns `null` if `keyword` isn't
 * immediately followed by an opening quote (clause absent; same as a failed regex
 * match, e.g. `keyword` appearing only as part of the element's free-text name).
 * Throws if the string never finds its closing quote, naming the real cause
 * instead of surfacing as a confusing downstream "unrecognized trailing text".
 */
function extractQuotedClause(
  rest: string,
  keyword: string,
  line: number,
): { value: string; rest: string } | null {
  const kwMatch = rest.match(new RegExp(`(?:^|\\s)${keyword}\\s+(?=")`, "i"));
  if (!kwMatch || kwMatch.index === undefined) return null;
  const openIdx = kwMatch.index + kwMatch[0].length;
  const closeIdx = matchQuote(rest, openIdx);
  if (closeIdx < 0)
    throw new ParseError(`unterminated string literal in '${keyword}' clause`, line);
  return {
    value: decodeQuoted(rest.slice(openIdx + 1, closeIdx)),
    rest: (rest.slice(0, kwMatch.index) + rest.slice(closeIdx + 1)).trim(),
  };
}

/**
 * Pulls `note`/`issue`/`divergence`/`from`/`public`/`@Tag`/`again` clauses out
 * of `raw`, applying each to `node` and returning whatever text is left (the
 * element's name, when called on the text before a `{ … }` block —
 * otherwise anything unrecognized).
 *
 * Shared by `parseElement` (clauses before an inline field block, or on an
 * element with no field block at all) and the field-block handling in
 * `parse()` (clauses trailing a `{ … }` block's closing `}`, inline or
 * multi-line) — trailing clauses are matched the same way as leading ones so
 * `note`/`issue`/`divergence`/etc. are never silently dropped just because
 * they come after the fields.
 */
function extractClauses(
  node: ElementNode,
  raw: string,
  line: number,
): string {
  let rest = raw;

  // `note "path.md"` clause (valid on any element). Pulled off first because
  // the `from` clause below greedily consumes to end-of-line.
  const noteClause = extractQuotedClause(rest, "note", line);
  if (noteClause) {
    node.note = noteClause.value;
    rest = noteClause.rest;
  }

  // `issue "text"` clause (valid on any element): an open question flagged red on
  // the diagram, distinct from `note`'s file link. Extracted the same way, before
  // `from`, for the same reason.
  const issueClause = extractQuotedClause(rest, "issue", line);
  if (issueClause) {
    node.issue = issueClause.value;
    rest = issueClause.rest;
  }

  // `divergence "text"` clause (valid on any element): a reasoned, ratified
  // deviation between this element and its implementation — the *resolved*
  // sibling of `issue`'s open question. Extracted the same way, before
  // `from`, for the same reason.
  const divergenceClause = extractQuotedClause(rest, "divergence", line);
  if (divergenceClause) {
    node.divergence = divergenceClause.value;
    rest = divergenceClause.rest;
  }

  // Element-level `tag` clause(s) (event only, MIL-66): `tag <key> from a, b` (composite) or
  // `tag <key> external "text"` (external). Extracted before `from` below — though the two
  // never actually collide (this `from` is an unquoted bare-identifier list, the view/reaction
  // `from` below requires a quote immediately after — see `extractTagClauses`) — so both belong
  // in this same note/issue/divergence "extract before `from`" cluster. May match more than
  // once: `tag` clauses accumulate, unlike every other clause here.
  rest = extractTagClauses(node, rest, line);

  // `from "A", "B"` clause (views and reactions). The keyword is case-sensitive
  // and its operand must open with a quote, so a capitalized `From` — or a bare
  // lowercase `from` — inside an element name (`event Widget Removed From
  // Cabinet`, `view Requests from partners from "Request Submitted"`) folds
  // into the free-text name instead of being mistaken for the clause.
  const fromMatch = rest.match(/(?:^|\s)from\s+(?=")(.+)$/);
  if (fromMatch && fromMatch.index !== undefined) {
    if (node.kind !== "view" && !AUTOMATION_KINDS.has(node.kind))
      throw new ParseError(
        "`from` is only valid on view or a reaction (automation/processor/saga/translation)",
        line,
      );
    if (hasUnterminatedQuote(fromMatch[1]))
      throw new ParseError("unterminated string literal in 'from' clause", line);
    node.from = splitQuotedList(fromMatch[1]);
    rest = rest.slice(0, fromMatch.index).trim();
  }

  // `public` clause (event or view): marks this element as part of the published
  // integration surface — an event as an AsyncAPI-style contract, a view as the response
  // shape of a public read API/webhook another team or service consumes — as opposed to an
  // internal-only fact or read model. Checked here, before `@Tag`/`again`, so `public` may be
  // written either as the true last token, immediately before a trailing `@Tag` (event), or
  // immediately before a trailing `again` (view) — either way the later token ends up the
  // trailing-most once `public` is excised, which is what those blocks below require.
  // Anywhere else in the line, a bare `public` is left alone and folds into the free-
  // text name, same as any other unrecognized word (matching `again`'s discipline).
  // Case-sensitive, like the top-level keyword table, so a title-cased `Public`
  // in a name (`event Account Made Public`) is never taken as the marker.
  const publicMatch = rest.match(/(?:^|\s)public(?=\s+again\s*$|\s+@\S.*$|\s*$)/);
  if (publicMatch && publicMatch.index !== undefined) {
    if (node.kind !== "event" && node.kind !== "view")
      throw new ParseError(
        "`public` is only valid on event or view — only recorded facts and read models are " +
          "promoted to the integration surface",
        line,
      );
    node.public = true;
    rest = (rest.slice(0, publicMatch.index) + rest.slice(publicMatch.index + publicMatch[0].length)).trim();
  }

  // Trailing `@Tag` (persona for ui, context for event). Captures everything from `@` to
  // end of line, not just the first word, so a multi-word persona/context (`@Pax8 Admin`,
  // declared as `persona Pax8 Admin` — declarations are already free multi-word text, see
  // the top-level `persona`/`context` handling) resolves correctly instead of silently
  // failing to match. A failed match here doesn't error — the `@`-prefixed text just folds
  // into the free-text name — so unquoted multi-word tags used to fail *silently*: the
  // element's `persona`/`context` stayed unset, and normalization's fallback (first-declared
  // persona/context) accepted it without complaint. Safe to capture greedily to end of line
  // because every clause that can trail an element (`note`/`issue`/`divergence`/`from`/
  // `public`) is already stripped from `rest` by this point; `again` is view-only and never
  // co-occurs with a tag (ui/event only).
  const tagMatch = rest.match(/(?:^|\s)@(\S.*?)\s*$/);
  if (tagMatch && tagMatch.index !== undefined) {
    const tag = tagMatch[1];
    if (node.kind === "ui") node.persona = tag;
    else if (node.kind === "event") node.context = tag;
    else
      throw new ParseError(
        `'@${tag}' tag is only valid on ui (persona) or event (context)`,
        line,
      );
    rest = rest.slice(0, tagMatch.index).trim();
  }

  // Trailing `again` (view only): a later timeline instance of an existing read model —
  // the Event Modeling device for keeping arrows forward as a view evolves.
  // Case-sensitive for the same reason as `public`: `view Backlog Again` is a name.
  const againMatch = rest.match(/(?:^|\s)again$/);
  if (againMatch && againMatch.index !== undefined) {
    if (node.kind !== "view")
      throw new ParseError("`again` is only valid on view — read models are the only elements that reappear along the timeline", line);
    node.again = true;
    rest = rest.slice(0, againMatch.index).trim();
  }

  return rest;
}

/**
 * Pulls every element-level `tag <key> from a, b` (composite) or `tag <key> external "text"`
 * (external) clause out of `raw`, in a loop — `tag` clauses accumulate, unlike every other
 * clause `extractClauses` handles. Applies each to `node.tags` and returns whatever text is
 * left. Events only (event or nothing — same posture as the `public` kind check above); a
 * non-event `node` throws as soon as a `tag` clause is actually found, so an element that
 * merely has "tag" nowhere in its trailing text pays no penalty.
 *
 * Shared by `extractClauses` (the trailing-clause position, on the header line, after an
 * inline `{ … }` block, or on a multi-line block's closing `}` line) and the standalone
 * `tag ...` line handler in `parse()` (which prepends the literal `"tag "` back on before
 * calling this, so both entry points share one matcher/error-message implementation).
 *
 * The composite field list is a bounded bare-identifier grammar (`a`, `a, b`, `a, b, c`, …),
 * not "everything to end of line" the way the quoted `from`/`note`/etc. clauses are — so a
 * `tag` clause never has to be the line's last token; a trailing `public`/`@Context`/etc.
 * simply isn't valid identifier-list syntax and is left for those clauses to find afterward.
 */
function extractTagClauses(node: ElementNode, raw: string, line: number): string {
  let rest = raw;
  const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
  const compositeRe = new RegExp(`(?:^|\\s)tag\\s+(\\S+)\\s+from\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*)`);
  const externalRe = /(?:^|\s)tag\s+(\S+)\s+external\s+(?=")/;

  for (;;) {
    const cMatch = rest.match(compositeRe);
    const eMatch = rest.match(externalRe);
    let which: "composite" | "external" | null = null;
    if (cMatch && eMatch) which = (cMatch.index ?? 0) <= (eMatch.index ?? 0) ? "composite" : "external";
    else if (cMatch) which = "composite";
    else if (eMatch) which = "external";
    if (!which) break;

    if (node.kind !== "event") {
      throw new ParseError(
        "`tag` is only valid on event — identity/composite/external tags describe an event's " +
          "DCB tag, not a command/view/ui",
        line,
      );
    }

    if (which === "composite") {
      const m = cMatch!;
      const key = m[1];
      const fields = m[2].split(",").map((s) => s.trim());
      if (fields.length < 2)
        throw new ParseError(
          `tag "${key}": a composite tag needs at least 2 fields (got ${fields.length})`,
          line,
        );
      (node.tags ??= []).push({ key, kind: "composite", fields, line });
      rest = (rest.slice(0, m.index) + rest.slice((m.index ?? 0) + m[0].length)).trim();
    } else {
      const m = eMatch!;
      const key = m[1];
      const openIdx = (m.index ?? 0) + m[0].length;
      const closeIdx = matchQuote(rest, openIdx);
      if (closeIdx < 0)
        throw new ParseError(`unterminated string literal in tag "${key}" external clause`, line);
      const description = decodeQuoted(rest.slice(openIdx + 1, closeIdx));
      (node.tags ??= []).push({ key, kind: "external", description, line });
      rest = (rest.slice(0, m.index) + rest.slice(closeIdx + 1)).trim();
    }
  }

  return rest;
}

/** Which enclosing block a field line lives in, passed down to `extractFieldClauses` so a
 *  field-level clause legal only on certain element kinds (e.g. `tag`, event-only) can reject
 *  it elsewhere. `"type-decl"` marks a field inside a top-level `type { … }` block — no
 *  enclosing element kind at all. */
type FieldClauseContext = ElementKind | "type-decl";

/** Trailing clauses recognized on a single field spec, extracted before the `name[: Type]`
 *  split. A new field-level clause (MIL-68's planned `renamedFrom?: string[]`, from
 *  `renamed from "Old1", "Old2"`) is a new optional key here, not a rewrite of this shape or
 *  of `extractFieldClauses`'s control flow. */
interface FieldClauses {
  /** Trailing `tag` keyword (event fields only): marks the field an identity tag. */
  tag?: boolean;
}

/**
 * Pulls recognized trailing clauses off one field spec's raw text (a single comma-separated
 * entry from a `{ … }` block's inner text, BEFORE the `name`/`name: Type` split — a clause
 * trails the type, or the bare name for a typeless field). Returns the leftover text (still to
 * be split on `:`) plus whatever clauses were found.
 *
 * The reusable field-level counterpart to `extractClauses` (element-level) — kept a separate
 * step from the name/type split below so a second field clause slots in as a new case here
 * instead of a restructure. `context` is the enclosing block's element kind (or `"type-decl"`);
 * a clause legal only on certain kinds throws a ParseError naming the actual context, mirroring
 * `extractClauses`'s per-clause kind checks.
 *
 * Anchored as a genuinely TRAILING word requiring non-blank content before it (`/^(.*\S)\s+tag$/`)
 * so a field literally NAMED `tag` (bare `tag`, or `tag: UUID`) is a field declaration, never a
 * clause — the text "tag" alone can't satisfy "something, then whitespace, then tag" against
 * itself. Same discipline `extractClauses` uses for `public`/`again` against a same-named
 * element.
 */
function extractFieldClauses(raw: string, line: number, context: FieldClauseContext): { rest: string; clauses: FieldClauses } {
  const clauses: FieldClauses = {};
  let rest = raw;

  const tagMatch = rest.match(/^(.*\S)\s+tag$/);
  if (tagMatch) {
    if (context !== "event") {
      throw new ParseError(
        "`tag` is only valid on an event field — identity/composite/external tags describe an " +
          `event's DCB tag, not a ${context === "type-decl" ? "type" : context} field`,
        line,
      );
    }
    clauses.tag = true;
    rest = tagMatch[1];
  }

  return { rest, clauses };
}

/** Parse one field spec: `name` or `name: Type`, plus any trailing field-level clauses
 *  (`extractFieldClauses`). Returns null for blanks. */
function parseFieldSpec(raw: string, line: number, context: FieldClauseContext): Field | null {
  const s = raw.trim();
  if (!s) return null;
  const { rest, clauses } = extractFieldClauses(s, line, context);
  const spec = rest.trim();
  if (!spec) return null;

  const colon = spec.indexOf(":");
  let field: Field | null;
  if (colon >= 0) {
    const name = unquote(spec.slice(0, colon).trim());
    const type = unquote(spec.slice(colon + 1).trim());
    field = name ? { name, ...(type ? { type } : {}) } : null;
  } else {
    const name = unquote(spec);
    field = name ? { name } : null;
  }
  if (field && clauses.tag) field.tag = true;
  return field;
}

/** Parse comma-separated field specs from the inner text of a `{ … }` block (or a single
 *  line inside an already-open one). Shared by element field blocks and `type` blocks —
 *  every field-bearing `{ … }` block in the grammar splits and parses fields the same way.
 *  The split is quote-aware (`splitTopLevel`, identical to native `.split(",")` when `inner`
 *  has no quotes at all) so a future field clause carrying a quoted, comma-bearing list
 *  (MIL-68's `renamed from "Old1", "Old2"`) isn't broken apart by the split itself. */
function parseInlineFields(inner: string, line: number, context: FieldClauseContext): Field[] {
  const fields: Field[] = [];
  for (const spec of splitTopLevel(inner, ",")) {
    const f = parseFieldSpec(spec, line, context);
    if (f) fields.push(f);
  }
  return fields;
}

function parseArrow(raw: string, line: number): ArrowNode {
  const parts = raw.split("->");
  if (parts.length !== 2)
    throw new ParseError("arrow must be of the form 'A -> B'", line);
  const from = unquote(parts[0].trim());
  const to = unquote(parts[1].trim());
  if (!from || !to) throw new ParseError("arrow endpoints required", line);
  return { from, to, line };
}

function splitFirstWord(line: string): string[] {
  const idx = line.search(/\s/);
  if (idx < 0) return [line];
  return [line.slice(0, idx), line.slice(idx + 1)];
}

function pushUnique(arr: string[], v: string): void {
  if (v && !arr.includes(v)) arr.push(v);
}