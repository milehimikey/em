// SPDX-License-Identifier: MIT
// GH #402: section-aware HTML rendering for a slice doc's body — the same `marked` dependency
// already bundled for `em catalog` (docs/dependencies.md), driven through custom renderer
// extensions instead of marked's flat default output. No new dependency, and no change to the
// body markdown a doc author writes — only how it renders to HTML. A fresh `Marked` instance is
// built per call (the package's own guidance, see marked's `Marked` class doc comment: "create a
// separate Marked instance and use Marked#use" for per-call configuration) so the per-doc
// invariant-anchor bookkeeping below never leaks across two docs rendered in the same `em
// catalog`/`em watch` run.
//
//  - Given/When/Then scenario cards: a `### Scenario: <title>` heading immediately followed by a
//    Given/When/Then bullet list, inside a `## Scenarios…` section, merges — at the token level
//    (`hooks.processAllTokens`) — into one synthetic `scenarioCard` token rendered as a single
//    bordered card. Acceptance is EXACTLY the strict grammar's (catalog/scenarios.ts): the
//    candidate block's own raw text is run through `parseScenarios`, and only a block it accepts
//    (all three beats present and non-empty, labels case-sensitive, column-0) becomes a card.
//    Anything it would flag `slice-doc/structured-section-malformed` — a missing or empty beat, a
//    lowercase label — and anything it ignores — a block outside a `## Scenarios…` section —
//    renders exactly as flat markdown did before, so a diagnostic-worthy block never looks
//    silently fixed by presentation.
//  - INV-* chips: every `INV-<mnemonic>-<n>`-shaped token (the grammar catalog/invTokens.ts's
//    `INV_TOKEN_RE` defines, `\b`-bounded on both sides) becomes a chip. An ID this doc declares
//    in its own Invariants/Delta ownership section (`extractInvariantIds` — the same scan `em
//    coverage`/`em validate` already trust as "this doc owns this ID") gets its anchor at its
//    first rendered occurrence INSIDE that ownership section — not at an earlier passing citation
//    (the template's canonical order puts the Command field table, whose Rules column cites ids,
//    before `## Invariants`); every other mention, before or after, links to the anchor. Only
//    when the ownership section has no chip-renderable occurrence of the id (e.g. the declaring
//    bullet backticks it, which renders as a codespan marked's inline extensions never enter)
//    does the anchor fall back to the id's first rendered mention anywhere. An ID this doc never
//    declares (a narrative citation of a sibling slice's rule) renders as a plain, unlinked chip.
//  - Field tables: every markdown table (the GENERATED command/event/view tables, MIL-266,
//    included) gets a `field-table` class, and its Type / Notes-or-Rules / Required-or-
//    Immutable-Fact column (matched by header text, position-independent since the three
//    REGION_TABLE_HEADERS shapes don't share a column order) gets a `col-type`/`col-notes`/
//    `col-flag` class — same table, just styled.
//
// Pure: markdown text in, HTML string out. No frontmatter, no SliceDoc, no drift
// classification — those live one level up (catalog/docBadge.ts), kept out of this module on
// purpose so it never has to depend on catalog/sliceDoc.ts or catalog/driftSignal.ts. The INV
// grammar comes from catalog/invTokens.ts (a leaf), NOT cli/coverage.ts, which imports
// catalog/docJoin.ts → catalog/sliceDoc.ts → this module — an import cycle invTokens.ts exists
// to break.

import { Marked, RendererThis, Tokens, Token } from "marked";
import { extractInvariantIds, INV_TOKEN_RE, OWNERSHIP_HEADING_RE } from "./invTokens.js";
import { parseScenarios, SCENARIOS_SECTION_RE } from "./scenarios.js";

/** INV_TOKEN_RE's token run, anchored at the current inline-lexer position; the `\b` on each
 *  side is enforced by the tokenizer below (the preceding character lives in the already-lexed
 *  tokens, outside what a `^`-anchored regex can see). */
const INV_CHIP_RE = /^INV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;
/** The strict grammar's heading prefix (scenarios.ts `SCENARIO_HEADING_RE`), case-sensitive, as
 *  it appears in a heading token's inner text. */
const SCENARIO_PREFIX_RE = /^Scenario:\s*/;
/** The strict grammar's beat labels (scenarios.ts `LABEL_RE`), case-sensitive. */
const GWT_LABEL_RE = /^(Given|When|Then):$/;

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
 *  child isn't a bold `**Given:**`/`**When:**`/`**Then:**` label (exact case — the strict
 *  grammar's) — scenarios.ts's shape, read off the already-lexed token tree. */
function itemLabel(item: Tokens.ListItem): "given" | "when" | "then" | null {
  const first = item.tokens[0] as Token | undefined;
  if (!first || (first.type !== "text" && first.type !== "paragraph")) return null;
  const inline = first.tokens;
  const strong = inline?.[0];
  if (!strong || strong.type !== "strong") return null;
  const m = GWT_LABEL_RE.exec(strong.text);
  return m ? (m[1].toLowerCase() as "given" | "when" | "then") : null;
}

/** True when every item of a bullet list is Given/When/Then-labelled — the card layout can only
 *  label steps it recognizes, so a list with any stray unlabelled bullet stays a plain list even
 *  when the strict grammar would accept the block (it ignores such bullets; a card would have to
 *  mislabel them). */
function isScenarioList(list: Token | undefined): list is Tokens.List {
  if (!list || list.type !== "list") return false;
  const items = (list as Tokens.List).items;
  return items.length > 0 && items.every((it: Tokens.ListItem) => itemLabel(it) !== null);
}

/** The strict grammar's verdict on a candidate heading+list pair, by parsing the pair's OWN raw
 *  text (under a synthetic `## Scenarios` opener, since section membership was already checked
 *  against the doc's real headings). Accepted means `parseScenarios` yields exactly this one
 *  scenario and no problems — the exact acceptance `slice-doc/structured-section-malformed` and
 *  `em export`'s `doc.scenarios` use, not a re-implementation of it. A block the full-doc parse
 *  would flag can never pass here: the snippet is a subset of the block's lines, and beats only
 *  accumulate, so snippet-accepted implies full-doc-accepted. */
function strictGrammarAccepts(heading: Tokens.Heading, list: Tokens.List): boolean {
  const snippet = `## Scenarios\n${heading.raw.trimEnd()}\n${list.raw}`;
  const parsed = parseScenarios(snippet);
  return parsed.problems.length === 0 && parsed.scenarios.length === 1;
}

/** The heading's own inline tokens, with the literal `Scenario: ` prefix stripped off the first
 *  text token — so the title's own inline formatting (an INV-* mention included) still renders. */
function stripScenarioPrefix(heading: Tokens.Heading): Token[] {
  const [first, ...rest] = heading.tokens;
  if (!first || first.type !== "text") return heading.tokens;
  const stripped = first.text.replace(SCENARIO_PREFIX_RE, "");
  if (stripped === first.text) return heading.tokens;
  return [{ ...first, text: stripped, raw: stripped }, ...rest];
}

/** Merges each strict-grammar-accepted `### Scenario: <title>` heading + Given/When/Then list
 *  pair inside a `## Scenarios…` section into one `scenarioCard` token, so the two render as a
 *  single card instead of a heading followed by a loose bullet list. Section tracking mirrors
 *  `parseScenarios`' own raw-line rule: a literal `## Scenarios…` ATX heading opens the section,
 *  any other `#`/`##` ATX heading closes it. Everything else — a block outside the section, a
 *  missing or empty beat, a lowercase label — passes through untouched and renders as plain
 *  markdown. Runs once, over the top-level token array, via `hooks.processAllTokens`. */
function mergeScenarioCards(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let inScenarios = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading") {
      // Same boundary rule as parseScenarios, applied to the heading's raw first line: only a
      // `#`/`##` line toggles the section; `###` and deeper never do.
      const rawLine = (t.raw as string).split(/\r?\n/)[0];
      if (/^#{1,2}\s/.test(rawLine)) inScenarios = SCENARIOS_SECTION_RE.test(rawLine);
    }
    if (inScenarios && t.type === "heading" && t.depth === 3 && SCENARIO_PREFIX_RE.test(t.text)) {
      const heading = t as Tokens.Heading;
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === "space") j++;
      const list = tokens[j];
      if (isScenarioList(list) && strictGrammarAccepts(heading, list)) {
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
      // itemLabel() is non-null for every item — isScenarioList() gated the merge on that.
      const label = itemLabel(item)!;
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

/** Rendering-order state the heading renderer writes and the chip renderer reads: is the block
 *  currently being rendered inside the doc's Invariants/Delta ownership section? Sound because
 *  marked renders top-level tokens strictly in document order — a heading's renderer runs before
 *  any later block's inline content is parsed. */
interface ChipState {
  inOwnership: boolean;
}

/** The defining ids that will actually RENDER as a chip somewhere inside the ownership section —
 *  where the definition anchor belongs. Scanned from the raw body with code spans stripped,
 *  because a backticked id renders as a codespan, which marked's inline extensions never enter:
 *  such an id still *defines* (extractInvariantIds reads raw text), but its anchor has to fall
 *  back to the first rendered mention anywhere. */
function ownershipRenderableIds(body: string, definingIds: Set<string>): Set<string> {
  const out = new Set<string>();
  let inOwnership = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      inOwnership = OWNERSHIP_HEADING_RE.test(line);
      continue;
    }
    if (!inOwnership) continue;
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(INV_TOKEN_RE)) if (definingIds.has(m[0])) out.add(m[0]);
  }
  return out;
}

const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** A fresh inline extension per render call: `claimed` is per-doc state (which IDs have already
 *  been given their one anchor), so two docs rendered back to back in the same `em catalog` run
 *  never share it — see the file header comment on why a fresh `Marked` instance is built per
 *  call. `definingIds` is this doc's own `extractInvariantIds(body)` result; `anchorInOwnership`
 *  the subset whose anchor must wait for the ownership section (`ownershipRenderableIds`);
 *  `state.inOwnership` is kept current by the heading renderer in `renderSliceDocBodyHtml`. */
function invChipExtension(definingIds: Set<string>, anchorInOwnership: Set<string>, state: ChipState) {
  const claimed = new Set<string>();
  return {
    name: "invChip",
    level: "inline" as const,
    start(src: string) {
      const i = src.indexOf("INV-");
      return i < 0 ? undefined : i;
    },
    tokenizer(src: string, tokens: Token[]): InvChipToken | undefined {
      const m = INV_CHIP_RE.exec(src);
      if (!m) return undefined;
      // INV_TOKEN_RE's \b on both sides: a run glued to a preceding word character (`XINV-1`,
      // the preceding text is the last already-lexed inline token) or followed by one (only `_`
      // can follow the greedy alphanumeric run and still be a word character) is not a token.
      const prev = tokens[tokens.length - 1];
      const prevChar = typeof prev?.raw === "string" ? prev.raw.slice(-1) : "";
      if (WORD_CHAR_RE.test(prevChar)) return undefined;
      if (src.charAt(m[0].length) === "_") return undefined;
      return { type: "invChip" as const, raw: m[0], id: m[0] };
    },
    renderer(token: Tokens.Generic): string {
      const { id } = token as InvChipToken;
      if (!definingIds.has(id)) return `<span class="inv-chip inv-chip--external">${escapeHtml(id)}</span>`;
      const anchor = `inv-${id.toLowerCase()}`;
      if (claimed.has(id)) return `<a class="inv-chip inv-chip--ref" href="#${anchor}">${escapeHtml(id)}</a>`;
      // The definition anchor belongs to the occurrence inside the ownership section; a passing
      // citation rendered before it (the template puts the Command field table first) is a link.
      if (anchorInOwnership.has(id) && !state.inOwnership) {
        return `<a class="inv-chip inv-chip--ref" href="#${anchor}">${escapeHtml(id)}</a>`;
      }
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
  const anchorInOwnership = ownershipRenderableIds(body, definingIds);
  const state: ChipState = { inOwnership: false };
  const m = new Marked();
  m.use({
    hooks: { processAllTokens: mergeScenarioCards },
    extensions: [{ name: "scenarioCard", renderer: renderScenarioCard }, invChipExtension(definingIds, anchorInOwnership, state)],
    renderer: {
      // Tracks which section rendering is currently inside (same raw-line boundary rule the
      // ownership scanners use), then falls through (`false`) to the default heading HTML.
      heading(token: Tokens.Heading): false {
        const rawLine = token.raw.split(/\r?\n/)[0];
        if (/^#{1,2}\s/.test(rawLine)) state.inOwnership = OWNERSHIP_HEADING_RE.test(rawLine);
        return false;
      },
      table: renderFieldTable,
    },
  });
  return m.parse(body, { async: false }) as string;
}
