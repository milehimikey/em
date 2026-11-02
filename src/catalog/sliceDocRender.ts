// SPDX-License-Identifier: MIT
// GH #402: section-aware HTML rendering for a slice doc's body — the same `marked` dependency
// already bundled for `em catalog` (docs/dependencies.md), driven through three custom renderer
// extensions instead of marked's flat default output. No new dependency, and no change to the
// body markdown a doc author writes — only how it renders to HTML. A fresh `Marked` instance is
// built per call (the package's own guidance, see marked's `Marked` class doc comment: "create a
// separate Marked instance and use Marked#use" for per-call configuration) so the per-doc
// invariant-anchor bookkeeping below never leaks across two docs rendered in the same `em
// catalog`/`em watch` run.
//
//  - Given/When/Then scenario cards: a `### Scenario: <title>` heading immediately followed by a
//    well-formed Given/When/Then bullet list (the exact shape scenarios.ts's strict grammar
//    requires) is merged, at the token level (`hooks.processAllTokens`), into one synthetic
//    `scenarioCard` token and rendered as a single bordered card. A malformed pair (no list
//    right after, or a list that isn't Given/When/Then) is left untouched — the same flat
//    heading+list output as before, so a block `slice-doc/structured-section-malformed` already
//    flags never looks silently fixed by presentation.
//  - INV-* chips: every `INV-<mnemonic>-<n>`-shaped token (the grammar cli/coverage.ts's
//    `INV_TOKEN_RE` already matches) becomes a chip. The first one that lands inside this doc's
//    own Invariants/Delta ownership section (`extractInvariantIds` — the same scan `em
//    coverage`/`em validate` already trust as "this doc owns this ID") becomes the anchor; every
//    later mention of that ID anywhere in the doc becomes a link to it. An ID this doc never
//    declares (a narrative citation of a sibling slice's rule) renders as a plain, unlinked chip.
//  - Field tables: every markdown table (the GENERATED command/event/view tables, MIL-266,
//    included) gets a `field-table` class, and its Type / Notes-or-Rules / Required-or-
//    Immutable-Fact column (matched by header text, position-independent since the three
//    REGION_TABLE_HEADERS shapes don't share a column order) gets a `col-type`/`col-notes`/
//    `col-flag` class — same table, just styled.
//
// Pure: markdown text in, HTML string out. No frontmatter, no SliceDoc, no drift
// classification — those live one level up (catalog/docBadge.ts), kept out of this module on
// purpose so it never has to depend on catalog/sliceDoc.ts or catalog/driftSignal.ts.

import { Marked, RendererThis, Tokens, Token } from "marked";
import { extractInvariantIds } from "../cli/coverage.js";

const INV_CHIP_RE = /^INV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;
const SCENARIO_HEADING_RE = /^Scenario:\s*/i;
const GWT_LABEL_RE = /^(Given|When|Then):$/i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------------------------
// Given/When/Then scenario cards.

interface ScenarioCardToken extends Tokens.Generic {
  type: "scenarioCard";
  titleTokens: Token[];
  list: Tokens.List;
}

/** The Given/When/Then label a scenario list item's bullet opens with, or null when its first
 *  child isn't a bold `**Given:**`/`**When:**`/`**Then:**` label — scenarios.ts's own grammar,
 *  read off the already-lexed token tree instead of the raw text. */
function itemLabel(item: Tokens.ListItem): "given" | "when" | "then" | null {
  const first = item.tokens[0] as Token | undefined;
  if (!first || (first.type !== "text" && first.type !== "paragraph")) return null;
  const inline = first.tokens;
  const strong = inline?.[0];
  if (!strong || strong.type !== "strong") return null;
  const m = GWT_LABEL_RE.exec(strong.text);
  return m ? (m[1].toLowerCase() as "given" | "when" | "then") : null;
}

/** True when every item of a bullet list is Given/When/Then-labelled — the shape a `###
 *  Scenario:` heading's list must have to become a card. */
function isScenarioList(list: Token | undefined): list is Tokens.List {
  if (!list || list.type !== "list") return false;
  const items = (list as Tokens.List).items;
  return items.length > 0 && items.every((it: Tokens.ListItem) => itemLabel(it) !== null);
}

/** The heading's own inline tokens, with the literal `Scenario: ` prefix stripped off the first
 *  text token — so the title's own inline formatting (an INV-* mention included) still renders. */
function stripScenarioPrefix(heading: Tokens.Heading): Token[] {
  const [first, ...rest] = heading.tokens;
  if (!first || first.type !== "text") return heading.tokens;
  const stripped = first.text.replace(SCENARIO_HEADING_RE, "");
  if (stripped === first.text) return heading.tokens;
  return [{ ...first, text: stripped, raw: stripped }, ...rest];
}

/** Merges each `### Scenario: <title>` heading with the Given/When/Then list right after it into
 *  one `scenarioCard` token, so the two render as a single card instead of a heading followed by
 *  a loose bullet list. Any other heading/list pair — including a malformed scenario block —
 *  passes through untouched. Runs once, over the top-level token array, via
 *  `hooks.processAllTokens` (after lexing, before rendering). */
function mergeScenarioCards(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading" && t.depth === 3 && SCENARIO_HEADING_RE.test(t.text)) {
      const heading = t as Tokens.Heading;
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === "space") j++;
      const list = tokens[j];
      if (isScenarioList(list)) {
        const card: ScenarioCardToken = { type: "scenarioCard", raw: heading.raw + list.raw, titleTokens: stripScenarioPrefix(heading), list };
        out.push(card);
        i = j;
        continue;
      }
    }
    out.push(t);
  }
  const links = (tokens as Token[] & { links?: unknown }).links;
  if (links !== undefined) (out as Token[] & { links?: unknown }).links = links;
  return out;
}

function scenarioStepBodyHtml(parser: RendererThis["parser"], item: Tokens.ListItem): string {
  const first = item.tokens[0] as Tokens.Text | Tokens.Paragraph;
  const inlineRest = (first.tokens ?? []).slice(1);
  const inlineHtml = parser.parseInline(inlineRest).trim();
  const blockRest = item.tokens.slice(1);
  const blockHtml = blockRest.length > 0 ? parser.parse(blockRest) : "";
  return inlineHtml + blockHtml;
}

function renderScenarioCard(this: RendererThis, token: Tokens.Generic): string {
  const { titleTokens, list } = token as ScenarioCardToken;
  const titleHtml = this.parser.parseInline(titleTokens);
  const steps = list.items
    .map((item) => {
      const label = itemLabel(item) ?? "then";
      const name = label[0].toUpperCase() + label.slice(1);
      const body = scenarioStepBodyHtml(this.parser, item);
      return (
        `<div class="scenario-step scenario-step--${label}">` +
        `<span class="scenario-step-label">${name}</span>` +
        `<div class="scenario-step-body">${body}</div></div>`
      );
    })
    .join("");
  return `<div class="scenario-card"><h3 class="scenario-card-title">${titleHtml}</h3>${steps}</div>`;
}

// ---------------------------------------------------------------------------------------------
// INV-* chips.

interface InvChipToken extends Tokens.Generic {
  type: "invChip";
  id: string;
}

/** A fresh inline extension per render call: `claimed` is per-doc state (which IDs have already
 *  been given their one anchor), so two docs rendered back to back in the same `em catalog` run
 *  never share it — see the file header comment on why a fresh `Marked` instance is built per
 *  call. `definingIds` is this doc's own `extractInvariantIds(body)` result: the IDs it declares
 *  in its Invariants/Delta ownership section, in first-occurrence order (cli/coverage.ts). */
function invChipExtension(definingIds: Set<string>) {
  const claimed = new Set<string>();
  return {
    name: "invChip",
    level: "inline" as const,
    start(src: string) {
      const i = src.indexOf("INV-");
      return i < 0 ? undefined : i;
    },
    tokenizer(src: string): InvChipToken | undefined {
      const m = INV_CHIP_RE.exec(src);
      return m ? { type: "invChip" as const, raw: m[0], id: m[0] } : undefined;
    },
    renderer(token: Tokens.Generic): string {
      const { id } = token as InvChipToken;
      const anchor = `inv-${id.toLowerCase()}`;
      if (!definingIds.has(id)) return `<span class="inv-chip inv-chip--external">${escapeHtml(id)}</span>`;
      if (claimed.has(id)) return `<a class="inv-chip inv-chip--ref" href="#${anchor}">${escapeHtml(id)}</a>`;
      claimed.add(id);
      return `<span class="inv-chip inv-chip--def" id="${anchor}">${escapeHtml(id)}</span>`;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Field tables.

/** Which styling class a generated region's table column gets, by header text — position-
 *  independent since REGION_TABLE_HEADERS' three shapes (command/event/view) don't share a
 *  column order (sliceSections.ts). */
function fieldColumnClass(header: string): string {
  if (/^type$/i.test(header)) return "col-type";
  if (/notes|rules|validation/i.test(header)) return "col-notes";
  if (/^(required|immutable fact\?)$/i.test(header)) return "col-flag";
  return "";
}

function renderFieldTable(this: RendererThis, token: Tokens.Table): string {
  const headerHtml = token.header
    .map((cell) => {
      const cls = fieldColumnClass(cell.text);
      return `<th${cls ? ` class="${cls}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`;
    })
    .join("");
  const bodyHtml = token.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => {
            const cls = fieldColumnClass(token.header[i]?.text ?? "");
            return `<td${cls ? ` class="${cls}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="field-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------

/** The full `html` a slice doc's body renders to — `catalog/sliceDoc.ts`'s only caller. Replaces
 *  the plain `marked.parse(body)` this used to be with the section-aware rendering above. */
export function renderSliceDocBodyHtml(body: string): string {
  const definingIds = new Set(extractInvariantIds(body));
  const m = new Marked();
  m.use({
    hooks: { processAllTokens: mergeScenarioCards },
    extensions: [{ name: "scenarioCard", renderer: renderScenarioCard }, invChipExtension(definingIds)],
    renderer: { table: renderFieldTable },
  });
  return m.parse(body, { async: false }) as string;
}
