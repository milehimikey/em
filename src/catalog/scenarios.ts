// SPDX-License-Identifier: MIT
// The constrained, authored Scenario grammar of a slice doc (MIL-266). Scenarios stay authored —
// nothing generates them — but in a shape a machine can read back, so `em export --json` can
// hand each slice's Given/When/Then to a test generator (`SliceDocExport.scenarios`) and
// `em validate` can say when a block is missing a beat (`slice-doc/structured-section-malformed`).
//
// Grammar, inside the doc's `## Scenarios …` section only (any `##` heading whose text starts
// with "Scenarios"):
//
//   ### Scenario: <title>
//   - **Given:** <optional inline text>
//     - <item>
//   - **When:**
//     - <item>
//   - **Then:**
//     - <item>
//
// A block runs from its `### Scenario:` heading to the next `#`/`##`/`###` heading. Each label is
// a column-0 bullet; its items are the inline text after the label (when non-empty) followed by
// every nested bullet (`  - item`, any indent ≥ 1 space) up to the next column-0 line. A label may
// repeat — its items append. Anything else in the block (prose, an HTML comment) is ignored.
//
// Free-prose 1.13 docs are untouched by construction: a doc with no `### Scenario:` heading in
// its Scenarios section yields no scenarios (`null` on export) and no problems — the template's
// older case-label bullet shape (`- **Happy path**` with nested Given/When/Then) is simply not
// this grammar, never a malformed instance of it.
//
// Pure — text in, data out; CRLF tolerated.

export interface Scenario {
  title: string;
  given: string[];
  when: string[];
  then: string[];
}

export interface ScenarioParseResult {
  /** Every well-formed block, in document order. */
  scenarios: Scenario[];
  /** One human sentence per malformed block (missing or empty Given/When/Then), in order. */
  problems: string[];
}

const SCENARIOS_SECTION_RE = /^##\s+Scenarios\b/;
const SCENARIO_HEADING_RE = /^###\s+Scenario:\s*(.*?)\s*$/;
const HEADING_RE = /^#{1,3}\s/;
const LABEL_RE = /^[-*]\s+\*\*(Given|When|Then):\*\*\s*(.*?)\s*$/;
const NESTED_ITEM_RE = /^\s+[-*]\s+(.*?)\s*$/;

type Beat = "given" | "when" | "then";

interface Block {
  title: string;
  beats: Record<Beat, string[] | null>;
}

/** Parse every `### Scenario:` block of a slice doc's body (or whole text — the frontmatter
 *  never holds a `## Scenarios` heading). */
export function parseScenarios(body: string): ScenarioParseResult {
  const lines = body.split(/\r?\n/);
  const blocks: Block[] = [];
  let inSection = false;
  let current: Block | null = null;
  let beat: Beat | null = null;

  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      inSection = SCENARIOS_SECTION_RE.test(line);
      current = null;
      beat = null;
      continue;
    }
    if (!inSection) continue;
    const heading = SCENARIO_HEADING_RE.exec(line);
    if (heading) {
      current = { title: heading[1], beats: { given: null, when: null, then: null } };
      blocks.push(current);
      beat = null;
      continue;
    }
    if (HEADING_RE.test(line)) {
      current = null;
      beat = null;
      continue;
    }
    if (!current) continue;
    const label = LABEL_RE.exec(line);
    if (label) {
      beat = label[1].toLowerCase() as Beat;
      const items = current.beats[beat] ?? [];
      if (label[2] !== "") items.push(label[2]);
      current.beats[beat] = items;
      continue;
    }
    const nested = NESTED_ITEM_RE.exec(line);
    if (nested && beat) {
      if (nested[1] !== "") current.beats[beat]!.push(nested[1]);
      continue;
    }
    // Any other column-0 line ends the current beat's nested items.
    if (line.trim() !== "" && !/^\s/.test(line)) beat = null;
  }

  const scenarios: Scenario[] = [];
  const problems: string[] = [];
  for (const block of blocks) {
    const missing = (["given", "when", "then"] as const).filter((b) => (block.beats[b] ?? []).length === 0);
    if (missing.length > 0) {
      const names = missing.map((b) => `**${b[0].toUpperCase()}${b.slice(1)}:**`).join(", ");
      problems.push(`scenario "${block.title}" has no ${names} — every \`### Scenario:\` block needs Given, When and Then bullets`);
      continue;
    }
    scenarios.push({ title: block.title, given: block.beats.given!, when: block.beats.when!, then: block.beats.then! });
  }
  return { scenarios, problems };
}

// ---------------------------------------------------------------------------------------------
// GH #293: the lenient reader. `parseScenarios` above is the strict, published grammar (export,
// `structured-section-malformed`); real estates still carry the older bullet format and
// `##### Scenario:` blocks under `## Delta`. `parseScenariosLenient` reads ALL of them for the
// scenario-quality advisories (catalog/scenarioQualityValidate.ts) — and any later reader that
// must apply to a real estate — without changing what `parseScenarios` exports or flags:
//
//   1. `### Scenario: <title>` (any `#{3,6}`) in the `## Scenarios…` section or the `## Delta`
//      section (Delta's are `##### Scenario:`), with `- **Given:**` / `When` / `Then` bullets;
//   2. the older bullet shape in `## Scenarios…`: a column-0 `- **Title**` bullet whose nested
//      bullets are `- **Given:** …`, `- **When:** …`, `- **Then:** …`, with indented lines
//      continuing the previous item.
//
// A block with no Given/When/Then at all is not a scenario and is dropped. Never reports
// problems — malformed-ness stays `parseScenarios`' business. Pure; CRLF tolerated.

export interface LenientScenario extends Scenario {
  /** 1-based line of the block's heading / title bullet within the text that was parsed. */
  line: number;
}

const ANY_SCENARIO_HEADING_RE = /^#{3,6}\s+Scenario:\s*(.*?)\s*$/;
const TITLE_BULLET_RE = /^[-*]\s+\*\*([^*]+?)\*\*\s*$/;
const ANY_LABEL_RE = /^(\s*)[-*]\s+\*\*(Given|When|Then):\*\*\s*(.*?)\s*$/;
const ANY_BULLET_RE = /^(\s*)[-*]\s+(.*?)\s*$/;

export function parseScenariosLenient(text: string): LenientScenario[] {
  const lines = text.split(/\r?\n/);
  const out: LenientScenario[] = [];
  let section: "scenarios" | "delta" | null = null;
  let cur: { title: string; line: number; beats: Record<Beat, string[]> } | null = null;
  let beat: Beat | null = null;
  let labelIndent = 0;
  let lastItem: { arr: string[]; idx: number } | null = null;

  const flush = () => {
    if (cur && (cur.beats.given.length || cur.beats.when.length || cur.beats.then.length)) {
      out.push({ title: cur.title, line: cur.line, given: cur.beats.given, when: cur.beats.when, then: cur.beats.then });
    }
    cur = null;
    beat = null;
    lastItem = null;
  };
  const start = (title: string, line: number) => {
    flush();
    cur = { title, line, beats: { given: [], when: [], then: [] } };
  };
  const push = (b: Beat, t: string) => {
    if (!cur || t === "") return;
    cur.beats[b].push(t);
    lastItem = { arr: cur.beats[b], idx: cur.beats[b].length - 1 };
  };

  lines.forEach((line, i) => {
    if (/^#{1,2}\s/.test(line)) {
      flush();
      section = /^##\s+Scenarios\b/.test(line) ? "scenarios" : /^##\s+Delta\b/.test(line) ? "delta" : null;
      return;
    }
    if (!section) return;
    const heading = ANY_SCENARIO_HEADING_RE.exec(line);
    if (heading) {
      start(heading[1], i + 1);
      return;
    }
    if (/^#{3,6}\s/.test(line)) {
      flush();
      return;
    }
    const label = ANY_LABEL_RE.exec(line);
    if (label && cur) {
      beat = label[2].toLowerCase() as Beat;
      labelIndent = label[1].length;
      push(beat, label[3]);
      return;
    }
    if (section === "scenarios" && !/^\s/.test(line)) {
      const t = TITLE_BULLET_RE.exec(line);
      if (t) {
        start(t[1], i + 1);
        return;
      }
    }
    if (!cur) return;
    const bullet = ANY_BULLET_RE.exec(line);
    if (bullet && beat && bullet[1].length > labelIndent) {
      push(beat, bullet[2]);
      return;
    }
    if (line.trim() === "") return;
    if (/^\s/.test(line) && lastItem && !bullet) {
      lastItem.arr[lastItem.idx] += ` ${line.trim()}`; // wrapped continuation of the previous item
      return;
    }
    if (!/^\s/.test(line)) beat = null; // any other column-0 line ends the current beat
  });
  flush();
  return out;
}
