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
import { splitQuotedList, stripComment, unquote } from "./lexer.js";

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
      for (const f of parseInlineFields(line)) (currentElement.fields ??= []).push(f);
      continue;
    }

    // Inside an open `type` block: each line is a field declaration too.
    if (currentTypeDecl) {
      currentTypeDecl.fields.push(...parseInlineFields(line));
      continue;
    }

    const [keyword, ...rest] = splitFirstWord(line);
    const remainder = rest.join(" ").trim();

    // Inside a slice: only element declarations are allowed.
    if (currentSlice) {
      if (!ELEMENT_KEYWORDS.has(keyword as ElementKind)) {
        throw new ParseError(
          `'${keyword}' is not valid inside a slice (expected ui/command/view/event/automation/processor/saga/translation or '}')`,
          lineNo,
        );
      }
      // An element may open a `{ … }` field block (inline or multi-line).
      const braceAt = remainder.indexOf("{");
      if (braceAt >= 0) {
        const el = parseElement(keyword as ElementKind, remainder.slice(0, braceAt).trim(), lineNo);
        el.fields = [];
        currentSlice.elements.push(el);
        const after = remainder.slice(braceAt + 1);
        const closeAt = after.indexOf("}");
        const inner = closeAt >= 0 ? after.slice(0, closeAt) : after;
        el.fields.push(...parseInlineFields(inner));
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
        const open = remainder.lastIndexOf("{");
        if (open < 0)
          throw new ParseError("slice must open a block with '{'", lineNo);
        let header = remainder.slice(0, open).trim();

        const node: SliceNode = { name: "", elements: [], line: lineNo };

        // `source "url"` clause (valid on any slice, order-independent relative
        // to the name): a link to the ticket/conversation this slice traces
        // back to, so the intake-loop audit chain is machine-traversable
        // through `em export` instead of living only in prose (MIL-69).
        const sourceMatch = header.match(/(?:^|\s)source\s+"([^"]*)"/i);
        if (sourceMatch && sourceMatch.index !== undefined) {
          node.source = sourceMatch[1];
          header = (header.slice(0, sourceMatch.index) + header.slice(sourceMatch.index + sourceMatch[0].length)).trim();
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
        const braceAt = remainder.indexOf("{");
        if (braceAt < 0) throw new ParseError("type must open a block with '{'", lineNo);
        const name = unquote(remainder.slice(0, braceAt).trim());
        if (!name) throw new ParseError("type requires a name", lineNo);
        const decl: TypeDeclNode = { name, fields: [], line: lineNo };
        const after = remainder.slice(braceAt + 1);
        const closeAt = after.indexOf("}");
        const inner = closeAt >= 0 ? after.slice(0, closeAt) : after;
        decl.fields.push(...parseInlineFields(inner));
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
  const noteMatch = rest.match(/(?:^|\s)note\s+"([^"]*)"/i);
  if (noteMatch && noteMatch.index !== undefined) {
    node.note = noteMatch[1];
    rest = (rest.slice(0, noteMatch.index) + rest.slice(noteMatch.index + noteMatch[0].length)).trim();
  }

  // `issue "text"` clause (valid on any element): an open question flagged red on
  // the diagram, distinct from `note`'s file link. Extracted the same way, before
  // `from`, for the same reason.
  const issueMatch = rest.match(/(?:^|\s)issue\s+"([^"]*)"/i);
  if (issueMatch && issueMatch.index !== undefined) {
    node.issue = issueMatch[1];
    rest = (rest.slice(0, issueMatch.index) + rest.slice(issueMatch.index + issueMatch[0].length)).trim();
  }

  // `divergence "text"` clause (valid on any element): a reasoned, ratified
  // deviation between this element and its implementation — the *resolved*
  // sibling of `issue`'s open question. Extracted the same way, before
  // `from`, for the same reason.
  const divergenceMatch = rest.match(/(?:^|\s)divergence\s+"([^"]*)"/i);
  if (divergenceMatch && divergenceMatch.index !== undefined) {
    node.divergence = divergenceMatch[1];
    rest = (
      rest.slice(0, divergenceMatch.index) + rest.slice(divergenceMatch.index + divergenceMatch[0].length)
    ).trim();
  }

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

/** Parse one field spec: `name` or `name: Type`. Returns null for blanks. */
function parseFieldSpec(raw: string): Field | null {
  const s = raw.trim();
  if (!s) return null;
  const colon = s.indexOf(":");
  if (colon >= 0) {
    const name = unquote(s.slice(0, colon).trim());
    const type = unquote(s.slice(colon + 1).trim());
    return name ? { name, ...(type ? { type } : {}) } : null;
  }
  const name = unquote(s);
  return name ? { name } : null;
}

/** Parse comma-separated field specs from the inner text of a `{ … }` block (or a single
 *  line inside an already-open one). Shared by element field blocks and `type` blocks —
 *  every field-bearing `{ … }` block in the grammar splits and parses fields the same way. */
function parseInlineFields(inner: string): Field[] {
  const fields: Field[] = [];
  for (const spec of inner.split(",")) {
    const f = parseFieldSpec(spec);
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