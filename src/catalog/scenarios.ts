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
