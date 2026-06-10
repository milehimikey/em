// Abstract syntax tree produced by the parser.

export type ElementKind =
  | "ui"
  | "command"
  | "view"
  | "event"
  | "automation"
  | "processor"
  | "saga"
  | "translation";

/** Element keywords that live in the automation band (top). */
export const AUTOMATION_KINDS: ReadonlySet<ElementKind> = new Set([
  "automation",
  "processor",
  "saga",
  "translation",
]);

export interface ElementNode {
  kind: ElementKind;
  name: string;
  /** @Persona tag — only meaningful for `ui`. */
  persona?: string;
  /** @Context tag — only meaningful for `event`. */
  context?: string;
  /** `from "Event", "Event2"` — only meaningful for `view`. */
  from?: string[];
  /** `note "path.md"` — markdown file holding this element's notes. */
  note?: string;
  line: number;
}

export interface SliceNode {
  name: string;
  elements: ElementNode[];
  line: number;
}

export interface ArrowNode {
  from: string;
  to: string;
  line: number;
}

export interface ModelNode {
  name: string;
  /** Declared persona lanes, in order. */
  personas: string[];
  /** Declared context/concept lanes, in order. */
  contexts: string[];
  slices: SliceNode[];
  /** Explicit top-level arrows (e.g. read-model feedback to a UI). */
  arrows: ArrowNode[];
}
