// SPDX-License-Identifier: MIT
// Starter model used by `em init`.

export const STARTER_EM = `model "Order Fulfillment"

persona Customer
persona Manager

context Order
context Payment

# --- Command pattern: UI -> command -> event ---
slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}

# --- View pattern: event -> read model -> UI ---
slice "View Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Payment
  event Payment Requested @Payment
}

# --- View pattern: a human view of pending payments ---
slice "Manager Review" {
  view Pending Payments from "Payment Requested"
  ui Payment Dashboard @Manager
}

# --- Read model the automation watches, in its own slice ---
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}

# --- Automation slice: the processor, the command it triggers, and that command's event ---
slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}

slice "Show Receipt" {
  view Receipts from "Payment Captured"
  ui Receipt Screen @Customer
}
`;

// ---- Templates for `em scaffold` (MIL-97 item 2) ----
//
// Embedded verbatim (backticks escaped) from the bundled skill's own templates/ directory,
// mirroring STARTER_EM above — the compiled CLI never reads .claude/skills/ at runtime to
// produce these, so `em scaffold` behaves identically whether em is run from a checkout or
// installed from npm. test/scaffoldTemplatesSync.test.ts asserts each constant below stays
// byte-identical to its source file in .claude/skills/event-modeling-shared/templates/, so the
// two copies can't silently drift — regenerate by hand (or re-run the one-off script noted
// there) whenever a template file changes.

/** Raw copy of templates/model-readme.md, \`{{...}}\` placeholders intact — see scaffoldReadme(). */
export const MODEL_README_TEMPLATE = `# {{Model Name}}

{{One-paragraph description of the business process(es) this event model covers.}}

## Live view
While modeling, run the live view so the team can watch the diagram update:

\`\`\`bash
em watch {{model-name}}.em -o {{model-name}}.svg --serve   # re-render + instant push-reload
# then open the URL it prints (http://localhost:5173/?svg={{model-name}}.svg) and share the screen
\`\`\`

Pan/zoom to navigate the diagram (drag, scroll; **Fit** resets), and click **Review mode** in
the header for a slice-by-slice walkthrough. If a save fails to render, the viewer keeps the
last good diagram and shows an error banner until the next successful load.

Static render: \`em render {{model-name}}.em -o {{model-name}}.svg\`

## Patterns legend
- **State Change** — UI → Command → Event
- **State View** — Event(s) → Read Model → UI
- **Automation** — Read Model (slice before) → Processor + Command → Event, together
- **Translation** — External input (or Read Model, slice before) → Translation + Command → Event, together

Between them these are the only legal connections: \`ui → command\`, \`command → event\`,
\`event → read model\`, \`read model → ui\`, \`read model → reaction\`, \`reaction → command\`. A command
never reaches a read model directly — the event goes between them. Every slice is joined up at
both ends: something triggers each command (the screen it's issued from, or the reaction that
triggers it, also in this slice), and every event a command records is read by some read model — so each State
Change slice is paired with the State View slice that projects its event. A read model repeated
along the timeline (\`view X again\`) shows the same projection at a later point; the instances are
never connected to one another.

## Slices
<!-- The canonical slice index — the ONE place slices are enumerated (the state file
     points here rather than keeping its own copy). Generated — run
     \`em slice index {{model-name}}.em\` to (re)write the table below from the model and its
     slice docs; never hand-edit between the markers. -->
<!-- GENERATED:slices:start -->
| # | Slice | Pattern | Status | Reviewed by | Ratified by | Owner | Tracking | Implemented in | Design doc |
|---|-------|---------|--------|-------------|-------------|-------|----------|----------------|------------|
<!-- GENERATED:slices:end -->

## Status
See [\`.event-modeling.md\`](.event-modeling.md) for current phase, decisions, and open questions.
`;

/** Raw copy of templates/state.md, \`{{...}}\` placeholders intact — see scaffoldStateFile(). */
export const STATE_TEMPLATE = `<!--
Resumable progress state for an event model. Stored as <model>/.event-modeling.md
The skill reads this on \`/event-modeling\` (no arg) to resume where you left off.
Keep it current at the end of every working session.
-->

# Event Modeling Progress — {{Model Name}}

- **Model file:** \`{{model-name}}.em\`
- **Current phase:** {{discover | extract | model | slice | implement | conform | review | validate}}
- **Current step:** {{1–7, see methodology; or extraction round R1–R7}}
- **Last updated:** {{YYYY-MM-DD}}
- **Last conformance:** {{YYYY-MM-DD @ <target-repo revision> — report: conformance/<date>-report.md | never}}
- **Last stakeholder review:** {{YYYY-MM-DD — attendees: see Participants | never}}

## Session inputs
- **Scope line:** {{one-line description of what's in/out of bounds for this model}}
- **PRD / spec reference:** {{path, link, or "none"}}
- **Headless/API model:** {{yes | no}}
- **Source mode:** {{greenfield | extract-event-driven | extract-procedural}}
- **Existing system refs:** {{repo paths, event-schema/topic locations, docs — or "n/a"}}

## Participants
<!-- Populate at session start. Live workshop: one human proxy relays questions to the room;
     attribute every answer/decision in the Decisions log to a named participant here. -->
- {{Name}} — {{role}} — {{domain area}}

## Extraction progress (existing-system models only — delete for greenfield)
- [ ] R1. Candidate events (extracted/synthesized, filtered, confirmed)
- [ ] R2. Timeline order (as-is narrative, actors/callers, first render)
- [ ] R3. Commands / inputs
- [ ] R4. Read models / outputs (validate from here)
- [ ] R5. Boundaries & reactions (reaction shares its slice with the command it triggers)
- [ ] R6. Gap & TBD reconciliation
- [ ] R7. Convergence (render + validate clean, user confirmed as-is)

## Steps completed
- [ ] 1. Brainstorm events
- [ ] 2. Plot / storyboard (personas + UI)
- [ ] 3. Inputs (commands)
- [ ] 4. Outputs (read models)
- [ ] 5. Swimlanes & apply patterns
- [ ] 6. Elaborate scenarios
- [ ] 7. Evaluate completeness (\`em validate\` clean)

## Decisions log
<!-- Resolved choices, with the reasoning, so they aren't re-litigated. In a live workshop,
     attribute each entry to the participant who made the call (see Participants above). -->
- {{YYYY-MM-DD}}: {{decision}} — {{why}} — by {{participant, if a live workshop}}

## Usage log
<!-- The team's only usage signal today (see docs/usage-data.md) — cheap and coarse on purpose.
     One line per session: phase(s) touched, and validate diagnostic *categories* hit (one of
     the exact fixed strings in docs/usage-data.md#categories, e.g. "read model has no
     consumer" — never the full instance message or any domain content). Append, never edit
     past entries. -->
- {{YYYY-MM-DD}}: phases: {{discover | extract | model | slice | implement | conform | review | validate | watch, ...}} — validate: {{diagnostic category (docs/usage-data.md#categories), ... | none}}

## Open questions / parking lot
<!-- Unresolved items to bring back to the user. Never guess these. Metadata is optional and
     flat — add only what's known: source (ticket/conversation that spawned it), blocked on
     (who/what), revisit (when). -->
- [ ] {{question}} — source: {{ticket/conversation link, optional}} — blocked on: {{who/what, optional}} — revisit: {{when, optional}}

## Slice inventory
<!-- Deliberately NOT a table: the canonical slice index (slice, pattern, status, doc link)
     lives in README.md's "Slices" section — one source of truth, updated there. This file
     only tracks resumable session state. -->
See \`README.md\` → **Slices** for the slice index and per-slice doc status.
`;

/** Raw copy of templates/constitution.md, \`{{...}}\` placeholders intact — see
 *  scaffoldConstitution(). */
export const CONSTITUTION_TEMPLATE = `<!--
The implementation constitution: the house rules an implementing agent follows on EVERY slice —
stack, code style, testing norms, NFR baselines, review norms. It answers "how do we build things
here" once, so no slice doc has to repeat it and no agent has to invent it. Slice docs say WHAT to
build; this says HOW it gets built here.

Where this document lives:
  - No SDD tool: \`constitution.md\` beside the model — \`em scaffold\` writes it there.
  - spec-kit project (a \`.specify/\` directory exists anywhere above the model): the document IS
    \`.specify/memory/constitution.md\`. em writes no second copy; the sections below merge into
    that file under these same headings, never overwriting text already there, and ratification is
    recorded in spec-kit's own \`**Ratified**:\` footer line instead of the frontmatter below.

How it gets filled: not by an agent guessing. Each section opens with the question a short
facilitated conversation asks before the first slice is implemented — the procedure is "Before the
first slice: the constitution" in the \`event-modeling-implement\` skill's \`reference/implement.md\`
(\`em contract\` prints it). Replace each \`{{...}}\` block with the real answers; delete the guidance
comments and any row that doesn't apply.

Ratification: \`ratifiedBy:\`/\`ratifiedOn:\` are the same identity discipline slice docs use — a
NAMED human and an ISO date, hand-filled at sign-off (no \`em\` command writes this file).
**A constitution with an empty \`ratifiedBy:\` is a draft**: an implementing agent treats it as
unratified, says so, and does not proceed on unilateral style or stack decisions for a first slice.

\`em status\` reports this document as present or absent per model — existence only. em never reads
or validates its content, and nothing here is machine-parsed.
-->

---
schemaVersion: 1
ratifiedBy:
ratifiedOn:
---
# {{Project Name}} — implementation constitution

The house rules for how implementation happens in this project. They bound every "purely
technical choice" an implementing agent would otherwise make alone.

## Stack and architectural shape

> **What do we build on, what shape does the code take, and which implementation skill or
> approach does each slice pattern route to?**

- **Languages / runtimes:** {{e.g. Kotlin 2.x on JVM 21; TypeScript 5 on Node 24}}
- **Frameworks / platform:** {{web framework, persistence, messaging, build tool}}
- **Architectural pattern:** {{e.g. event-sourced CQRS with vertical slices; layered service over
  a relational store; functional core / imperative shell}}
- **Where a slice's code lives:** {{one package per slice, per context, ...}}
- **Interface conventions:** {{resource style — REST/RPC/GraphQL, etc.; error/rejection mapping;
  versioning; auth at the edge — the shape every \`ui\`-triggered command or \`ui\`-consumed view's
  endpoint follows, decided once here rather than invented per slice}}

Routing — which implementation skill or approach each of the four slice patterns uses:

| Pattern | Skill / approach |
|---|---|
| State Change | {{e.g. the \`axon-*\` skill set — axon-entity-patterns, then axon-entity-testing}} |
| State View | {{e.g. the \`axon-*\` skill set — axon-projection-patterns, then axon-projection-testing}} |
| Automation | {{e.g. the \`axon-*\` skill set — axon-policy-patterns, then axon-policy-testing}} |
| Translation | {{e.g. the \`axon-*\` skill set — axon-translation-patterns}} |

An agent implementing a slice reads the doc's \`pattern:\` frontmatter and follows that row — this
table is the only routing rule.

## Code style

> **What does "idiomatic" mean in this codebase — formatting, naming, module layout?**

- **Formatter / linter:** {{the tool and the command that runs it — never hand-format against it}}
- **Naming:** {{commands, events, handlers, files, test names}}
- **Module layout:** {{what lives in which file/package, and what may not import what}}
- **Idiomatic here means:** {{the two or three habits a new contributor most often gets wrong}}

## Testing norms

> **What must be tested for each slice pattern, where do those tests live, and how are they named
> so \`em coverage\` can trace invariant IDs?**

- **Levels required per pattern:** {{e.g. State Change — decider unit tests plus a
  given/when/then fixture test; State View — projection tests; Automation / Translation —
  reaction tests, including a negative case}}
- **Invariant tests:** {{where they live}} — every \`INV-<MNEMONIC>-n\` in a slice doc needs at least
  one test **citing that exact ID** in its name or a comment, so
  \`em coverage <model>.em --tests <dir>\` can trace it.
- **Scenario tests:** {{where they live}} — one per \`## Scenarios (Given / When / Then)\` entry,
  with rejection scenarios asserting the doc's named rejection reason.
- **Test naming convention:** {{the exact pattern, e.g. \`INV-ORD-3: rejects a second submit\`}}
- **What "green" means:** {{the command CI runs}}

## NFR baselines

> **What standing non-functional defaults does every slice inherit — authz, PII, performance,
> observability?**

- **Authorization model:** {{who may issue which commands, how it's enforced, and where}}
- **PII / data handling:** {{what is sensitive, what may be logged, retention}}
- **Performance defaults:** {{latency / throughput budgets that apply unless a slice says otherwise}}
- **Observability:** {{logging, metrics, tracing every slice is expected to emit}}

A slice doc's own \`## Non-Functional Requirements\` section overrides these for that slice; where
it is silent, these apply.

## Review and merge norms

> **Who reviews an implementation PR, what blocks a merge, and how does the slice doc's status
> flip fit in?**

- **Reviewers:** {{who — a team, a CODEOWNERS rule, the slice's ratifier}}
- **What blocks a merge:** {{e.g. a failing suite, an uncovered invariant, a gap that belongs back
  at the model}}
- **Branch / commit conventions:** {{...}} — name only branch naming and commit-message style
  here. **One slice doc = one PR is the implement contract's rule, not this document's to
  amend** — a \`covers:\` doc ships as one PR for both keys; a read model is one doc, so a later
  \`again\` instance is a continuation of the doc that first declared it, not a PR of its own. See
  the agent guide's §5/§10.
- **At merge:** run \`em slice mark-implemented <model>.em <slice-key> <pr-url>\` — the one edit an
  implementing agent makes to a ratified slice doc, run by {{the PR author | CI}}. Never bump
  \`version:\`; that moves only when a delta is ratified.
`;

/** Same STARTER_EM content `em init` writes, titled from an arbitrary display name — used by
 *  `em scaffold`, which (unlike `em init`) knows a name to title the model with. */
export function starterEmFor(title: string): string {
  // Replacer function, not a string pattern — a string replacement would let `$&`/`$$`/etc.
  // in `title` expand against the match instead of being inserted literally (the CLI layer
  // separately rejects a `"` in the name, since that would break the .em string literal here).
  return STARTER_EM.replace('model "Order Fulfillment"', () => `model "${title}"`);
}

/** Fill MODEL_README_TEMPLATE's Model Name / model-name placeholders from `em scaffold`'s
 *  arguments. The still-unknown one-paragraph description drops to a guidance comment rather
 *  than a fabricated sentence — never leaves \`{{...}}\` in the result. The GENERATED:slices
 *  marker block is untouched: it's already header-only in the template (MIL-98), so there's
 *  nothing to fill and no placeholder row to hand-write. */
export function scaffoldReadme(displayName: string, slugName: string): string {
  // Replacer functions, not string patterns — a string replacement would let `$&`/`$$`/etc. in
  // displayName expand against the match instead of being inserted literally.
  return MODEL_README_TEMPLATE.replace(/\{\{Model Name\}\}/g, () => displayName)
    .replace(/\{\{model-name\}\}/g, () => slugName)
    .replace(
      "{{One-paragraph description of the business process(es) this event model covers.}}",
      "<!-- One-paragraph description of the business process(es) this event model covers. -->",
    );
}

/** Fill STATE_TEMPLATE's mechanical fields (model path, phase, step, dates) with real values.
 *  Every judgment section's placeholder bullet (Session inputs, Participants, Decisions log,
 *  Usage log, Open questions) is dropped rather than filled, leaving a real empty heading with
 *  the template's own guidance comment intact where it has one — per the skill's "don't guess,
 *  park it" principle, never a fabricated example. Never leaves \`{{...}}\` in the result. */
export function scaffoldStateFile(displayName: string, slugName: string, today: string): string {
  // Replacer functions for the display-name/slug fills, not string patterns — a string
  // replacement would let `$&`/`$$`/etc. in the value expand against the match instead of
  // being inserted literally.
  const filled = STATE_TEMPLATE.replace("{{Model Name}}", () => displayName)
    .replace("{{model-name}}", () => slugName)
    .replace("{{discover | extract | model | slice | implement | conform | review | validate}}", "discover")
    .replace("{{1\u20137, see methodology; or extraction round R1\u2013R7}}", "1")
    .replace("{{YYYY-MM-DD}}", today) // "Last updated" — the first occurrence; later ones belong to
    // judgment-section placeholder bullets and are dropped whole below.
    .replace("{{YYYY-MM-DD @ <target-repo revision> \u2014 report: conformance/<date>-report.md | never}}", "never")
    .replace("{{YYYY-MM-DD \u2014 attendees: see Participants | never}}", "never");

  return filled
    .split("\n")
    .filter((line) => !line.includes("{{"))
    .join("\n");
}

/** Fill CONSTITUTION_TEMPLATE's project-name placeholder for `em scaffold` (MIL-202).
 *
 *  Unlike `scaffoldReadme`/`scaffoldStateFile`, this one **deliberately leaves every other
 *  \`{{...}}\` block intact**: they are the unanswered questions of the elicitation conversation
 *  the implement skill runs before the first slice ("Before the first slice: the constitution"),
 *  not mechanical fields em could fill. An unanswered constitution must read as unanswered — the
 *  placeholders are the todo list, and the empty `ratifiedBy:` frontmatter says it's still a
 *  draft. Nothing in `em` ever parses this file's body; only its existence is reported
 *  (`em status`'s `constitution` field). */
export function scaffoldConstitution(displayName: string): string {
  // Replacer function, not a string pattern — a string replacement would let `$&`/`$$`/etc. in
  // displayName expand against the match instead of being inserted literally (the CLI layer
  // separately rejects `{{` in the name).
  return CONSTITUTION_TEMPLATE.replace("{{Project Name}}", () => displayName);
}
