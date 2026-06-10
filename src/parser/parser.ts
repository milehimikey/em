// Line-oriented parser for the `.em` slice-first DSL.
//
// Grammar (whitespace-tolerant, `#` starts a comment):
//
//   model "Name"
//   persona Name
//   context Name
//   slice "Name" {
//     ui    <free text> [@Persona]
//     command <free text>
//     view  <free text> [from "Event"[, "Event2" ...]]
//     event <free text> [@Context]
//     automation|processor|saga|translation <free text>
//   }
//   arrow <From Element> -> <To Element>

import {
  ArrowNode,
  ElementKind,
  ElementNode,
  ModelNode,
  SliceNode,
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
  };

  const rawLines = source.split(/\r?\n/);
  let currentSlice: SliceNode | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(rawLines[i]).trim();
    if (line.length === 0) continue;

    // End of a slice block.
    if (line === "}") {
      if (!currentSlice) throw new ParseError("unexpected '}'", lineNo);
      model.slices.push(currentSlice);
      currentSlice = null;
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
        const name = unquote(remainder.slice(0, open).trim());
        if (!name) throw new ParseError("slice requires a name", lineNo);
        currentSlice = { name, elements: [], line: lineNo };
        break;
      }
      case "arrow":
        model.arrows.push(parseArrow(remainder, lineNo));
        break;
      default:
        throw new ParseError(`unknown keyword '${keyword}'`, lineNo);
    }
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
  let rest = raw;
  const node: ElementNode = { kind, name: "", line };

  // `note "path.md"` clause (valid on any element). Pulled off first because
  // the `from` clause below greedily consumes to end-of-line.
  const noteMatch = rest.match(/\snote\s+"([^"]*)"/i);
  if (noteMatch && noteMatch.index !== undefined) {
    node.note = noteMatch[1];
    rest = (rest.slice(0, noteMatch.index) + rest.slice(noteMatch.index + noteMatch[0].length)).trim();
  }

  // `from "A", "B"` clause (view only, but parsed wherever present).
  const fromMatch = rest.match(/\sfrom\s+(.+)$/i);
  if (fromMatch && fromMatch.index !== undefined) {
    node.from = splitQuotedList(fromMatch[1]);
    rest = rest.slice(0, fromMatch.index).trim();
  }

  // Trailing `@Tag` (persona for ui, context for event).
  const tagMatch = rest.match(/(?:^|\s)@(\S+)\s*$/);
  if (tagMatch && tagMatch.index !== undefined) {
    const tag = tagMatch[1];
    if (kind === "ui") node.persona = tag;
    else if (kind === "event") node.context = tag;
    else
      throw new ParseError(
        `'@${tag}' tag is only valid on ui (persona) or event (context)`,
        line,
      );
    rest = rest.slice(0, tagMatch.index).trim();
  }

  node.name = unquote(rest);
  if (!node.name) throw new ParseError(`${kind} requires a name`, line);
  return node;
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
