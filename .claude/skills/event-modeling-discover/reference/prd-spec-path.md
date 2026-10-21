# PRD/spec path — a document is the input

Read this **before doing any work on a PRD, requirements document or API spec**, together with
`prd-rubric.md` (the shipped classification rubric).

**Entry:** `/em:discover` (plugin) or `/event-modeling discover` (repo skills), with the opening
message **`Discover from this PRD/spec: <path>`**. This is the exact entry the eval protocol's
arm C cites. The path is a **triage**: a document
describes the system its authors imagined (resources, endpoints, stack, quality targets). Handed
one cold, the failure modes are over-decomposition along control flow, implementation flavour,
and CRUD-per-entity models shaped like the resource reference. The steps below prevent all three
by making every claim in the document earn its place in the model, visibly.

**Stance.** You are still extracting the domain from people, not inventing it. The document is
evidence. Anything it does not say, or says ambiguously, is a question (step 6), never a guess.

Setup: run the shared preconditions (`../../event-modeling-shared/reference/operating-principles.md`),
agree the input path with the user, and create `discovery/` next to the model. Record the input
path in the state file's Session inputs.

## Step 0 — Walkthroughs become storylines

Before splitting anything, find the document's **walkthroughs**: a PRD's user stories and
journeys, an API spec's Walkthroughs / use-case / "getting started" section.

- The **end-to-end journey** is the **main storyline** — the happy path, on a timeline, with no
  branching ("a story of what success looks like"). Every other walkthrough is a **secondary
  storyline** (retire, extend, reorganize...). Exactly one is main.
- The timeline is built from these. The resource/endpoint reference is consulted **last**, only to
  fill operations no walkthrough touches.
- No walkthrough at all? Ask: *"what does success look like, start to finish?"* and have the
  human first add the answer to the source document (or to a `discovery/walkthroughs.md` companion
  that then becomes the triage `source`); a quote that is not in the source is rejected by design.
  Do not synthesize a journey from the endpoint list.
- Record each storyline in `storylines[]` with its `id`, `name`, `main`, and `quote` — the **full**
  walkthrough span, start to finish success story, verbatim (not its first sentence: the checker
  anchors every group to this span). These become the design phase's `storyline` blocks, so the provenance travels
  (`../../event-modeling-design/SKILL.md`, step 5; syntax in `../../event-modeling-shared/reference/em-dsl.md`).

## Step 1 — Split into single-claim statements

Split the input into **single-claim statements** — one fact, rule, need or description each. A
sentence with "and" usually holds two. Number them `S1`, `S2`, ... in source order. Each carries a
`quote` copied **verbatim** from the document (whitespace, Markdown emphasis marks and smart
quotes may differ; words may not; at least 12 characters). You may reword later (step 4) but never
in `quote`: the checker searches the document for it, and a quote it cannot find is an invented
claim. Every statement also records `provenance`: `walkthrough` for a claim made inside a
walkthrough span, `reference` for one from the resource/endpoint reference or operational notes.
**Every claim in a walkthrough gets a statement** — the carrier collecting, the delivery being
confirmed, the return before the due date — so nothing in the story is silently dropped; the
checker cannot see a missing one, so walk each walkthrough sentence by sentence.

## Step 2 — Classify

For each statement set:

- `category` — one id from `prd-rubric.md`.
- `aboutBusiness` — the independent check: *"is this about the business, independent of how it is
  built?"* Answer it separately from the category, without looking at the category.
- `confidence` — `high` or `low`. Any doubt: `low` (a low-confidence statement is always a question).

When `aboutBusiness` contradicts what the category expects (the rubric's `aboutBusiness expected`
column), that disagreement is data, not judgement: the outcome MUST be `question` (step 4, step 6).

A `resource-or-endpoint` statement is **never promoted to a command as-is**: ask which intent(s)
the resource serves (one endpoint may carry several intents) and rewrite to those (step 4).

## Step 3 — Group by reaction

A **group** is one future slice. Statements sharing a **trigger** and an **acting system** are one
group (`groups[]`: `id`, `name`, `trigger`, `actor`, `storyline`). Follow the merged reaction
shape (`../../event-modeling-shared/reference/methodology.md`): a reaction, its command and its
event share one slice.

- **Failure, retry and timeout statements are not new slices.** They become outcome events and
  Given/When/Then scenarios of the slice whose trigger they belong to; set `scenarioOf` to that
  group's id.
- **Storyline check.** A statement joins the storyline whose **journey it advances**, not the
  entity it mentions. A "Product" sentence in the retire walkthrough belongs to "Retire a
  product", not to a Product lifecycle.
- One group per trigger-and-actor; never one group per entity or per endpoint.
- **A group is anchored or reference-only, never both.** An anchored group names a storyline and
  holds at least one `walkthrough` statement quoted from inside that storyline's span. A group
  built only from `reference` statements (operations no walkthrough touches) is reference-only:
  `storyline: null` on the group and on its statements. It never joins a walkthrough storyline,
  and the report lists it outside every storyline for the human to inspect.
- A claim is quoted once: no statement's quote may equal, contain, be contained in, or partially overlap by character range in the normalised source another's. Only `modeled`/`rewritten` walkthrough statements anchor a group; a `question` never does.

## Step 4 — Rewrite, don't drop

Nothing is silently discarded.

- An **implementation detail that implies a business fact** (*"the service writes a row to
  `stock_levels` when a pick is confirmed"*): classify it `implementation-detail` with
  `aboutBusiness: false` — they agree, so it is `rewritten`, with the business-language form in
  `rewrite` (*"Stock is decremented when a pick is confirmed"*); the original stays in `quote`,
  which is the link to its source. If you classified the same sentence `business-fact` but the
  independent check says `false`, they **disagree**: the outcome is `question`, with the proposed
  rewrite in the question text (*"Is this a business fact? proposed: Stock is decremented when a
  pick is confirmed."*). The human resolves it and a later pass records `rewritten`.
- A **real technology choice or NFR** (*"must run on Postgres"*, *"p95 under 300 ms"*) gets outcome
  `constraint` and an entry in `constraints[]` listing its statement ids. That list feeds the
  project's constitution: hand it to the constitution's owner (the skills read the constitution,
  never write it); it never becomes a slice.
- Anything else you set aside is `parked` with a `reason`, **and** recorded in the state file's
  Decisions log with why (the same rule as rejected events in `discover` step 1), so it is not
  re-proposed later.

## Step 5 — Record

Write `discovery/prd-triage.json` (UTF-8, 2-space indent):

```json
{
  "prdTriageSchemaVersion": "1.0",
  "rubricVersion": "1.0",
  "source": "prd.md",
  "storylines": [{ "id": "L1", "name": "Order to delivery", "main": true, "quote": "A customer places an order. We pick and ship it, and they get a tracking link." }],
  "groups": [{ "id": "G1", "name": "Place Order", "trigger": "customer submits checkout", "actor": "Storefront", "storyline": "L1" }],
  "statements": [
    { "id": "S1", "quote": "A customer places an order.", "category": "user-intent", "aboutBusiness": true, "confidence": "high", "provenance": "walkthrough", "outcome": "modeled", "group": "G1", "storyline": "L1" },
    { "id": "S2", "quote": "must respond within 300 ms", "category": "nfr", "aboutBusiness": false, "confidence": "high", "provenance": "reference", "outcome": "constraint", "group": null, "storyline": null },
    { "id": "S3", "quote": "writes a row to stock_levels", "category": "business-fact", "aboutBusiness": false, "confidence": "high", "provenance": "reference", "outcome": "question", "group": null, "storyline": null, "question": "Is this a business fact? proposed: Stock is decremented when a pick is confirmed." }
  ],
  "constraints": [{ "id": "C1", "text": "Checkout responds within 300 ms", "statements": ["S2"] }]
}
```

Per statement: `id`, `quote`, `category`, `aboutBusiness`, `confidence`, `provenance`, `outcome`
(`modeled | rewritten | constraint | parked | question`), `group` and `storyline` (set for
`modeled`/`rewritten`, otherwise `null`), plus `rewrite` / `reason` / `question` /
`scenarioOf` where the outcome needs them. **Every statement has a category and an outcome;
every modeled or rewritten statement has a group.** The rules the checker enforces are listed in
`prd-rubric.md` ("Rules the checker enforces"): disagreement and low confidence are questions, an
endpoint is never modeled, group and storyline only for modeled/rewritten (otherwise `null`),
provenance verified against the storyline spans (a `walkthrough` quote lies inside one, a
`reference` quote outside all), no shared quotes, and every group either anchored by a walkthrough
statement inside its storyline's span or reference-only (`"storyline": null` on the group and its
statements, listed in the report outside every storyline).

Then run, and fix until it passes:

```
em discover triage-check discovery/prd-triage.json        # MCP: discover_triage_check
em discover triage-check discovery/prd-triage.json --markdown > discovery/prd-triage.md
```

`--markdown` prints the human-readable view (storylines, slice groups with their statements,
constraints, parked, questions); save it next to the JSON. The checker verifies shape, the rubric
version, verbatim quotes, and the outcome rules; **it cannot judge whether your classification is
right**, whether every walkthrough claim has a statement, or whether the Decisions-log entry for
each parked or rejected statement was actually written (that entry is prose-only and unchecked) —
that is what the human review is for. Read the report's **reference-only groups** list: those
are operations no walkthrough touches; check they are not CRUD fill. Also confirm each
**storyline quote really is a walkthrough span**: storyline spans are self-declared and the
checker cannot know which sections of the document are walkthroughs. The `--markdown` view lists
the storylines with their quotes for exactly this review.

## Step 6 — Questions, never inventions

Every `low` confidence statement, every statement where `aboutBusiness` contradicts the
category's expectation, and every `question` category statement gets outcome `question` and a
Socratic `question` (a disagreement's question carries the proposed rewrite). Ask them one concern at a time, in the story's words. Record each answer in the state
file and update the record (the statement is re-classified; re-run the checker). If the document
and the human disagree, the human wins and the disagreement is a Decisions-log entry.

## Hand-off

Continue with `discover` steps 1-4 (`../SKILL.md`) on the surviving groups: the storylines are the
timeline's spine, each group seeds one slice, and the constraints list goes to the project
constitution. `discovery/prd-triage.json` stays in the repo as provenance for the model.
