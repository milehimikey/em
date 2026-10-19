# PRD/spec triage rubric — version 1.0

The shipped classification rubric for the PRD/spec path (`prd-spec-path.md`, step 2). It is data:
`em discover triage-check` rejects a `discovery/prd-triage.json` whose `rubricVersion` is not the
version below. Do not edit it per project; a changed rubric ships with a new `rubricVersion` in a
new `em` release.

## The independent check

Run on every statement in addition to its category: **"Is this about the business, independent of
how it is built?"** Record the answer as `aboutBusiness` (true/false), answering it separately from
the category. The table's `aboutBusiness` column is what the category *expects*.

## Categories

| Category id | What it is | aboutBusiness expected | Allowed outcomes |
|---|---|---|---|
| `business-fact` | Something that happens or is true in the business; candidate event or field. | true | modeled, rewritten, parked, question |
| `user-intent` | What an actor wants to accomplish; candidate command with its trigger. | true | modeled, rewritten, parked, question |
| `information-need` | What an actor needs to see or know to act; candidate read model. | true | modeled, rewritten, parked, question |
| `actor` | A person, role or calling system; candidate persona. | true | modeled, parked, question |
| `business-rule` | A constraint the business imposes; candidate invariant or scenario. | true | modeled, rewritten, parked, question |
| `external-system` | A system outside the boundary; candidate translation slice or constraint. | either | modeled, rewritten, constraint, parked, question |
| `implementation-detail` | How it is built. Rewritten in business language when it implies a business fact; a real tech choice goes to the constraints list. | false | rewritten, constraint, parked, question |
| `nfr` | Performance, availability, security, compliance: feeds the constitution, never a slice. | either | constraint, parked, question |
| `goal-background` | Why the product exists; context for the main storyline, not a slice. | true | parked, rewritten, question |
| `question` | An open question in the source; becomes a Socratic question, never an invented answer. | either | question, parked |
| `resource-or-endpoint` | Describes an API resource or endpoint. Rewritten to the intent it serves (one endpoint may carry several); never promoted to a command as-is. | false | rewritten, parked, question |

## Outcomes

`modeled` (joins a slice group as stated), `rewritten` (joins a group in business language, the
original linked through `quote`), `constraint` (constraints list), `parked` (a `reason`; also a
Decisions-log entry), `question` (a Socratic `question` for the human). `question` and `parked`
are allowed for every category: a doubt can always be asked, and an explicitly deferred intent is
legitimate when its `reason` says so.

## Rules the checker enforces

All of these are checked by `em discover triage-check`; write the record so they hold.

1. **Disagreement is a question.** If `aboutBusiness` contradicts the category's expectation
   (a `business-fact` that names a table; an `implementation-detail` that states a business
   fact), the outcome MUST be `question`. Put the proposed rewrite in the question text
   ("Is this a business fact? proposed: Stock is decremented when a pick is confirmed."); the
   human resolves it and a later pass records `rewritten`.
2. **Low confidence is a question.** `confidence: low` means outcome `question`, whatever the category.
3. **An endpoint is never modeled as-is.** `resource-or-endpoint` is `rewritten` (to the intent it
   serves), `parked` or `question` — never `modeled`.
4. **Only modeled and rewritten statements join a slice group.** They carry a declared `group` and
   the `storyline` of that group. Every other outcome has `group: null` (and `storyline: null`),
   except that a `question` may name the group it would join once answered (with that group's
   storyline).
5. `rewritten` needs `rewrite`; `parked` needs `reason`; `question` needs `question`; every
   `constraint` appears in `constraints[]`.
6. **Provenance is checked, not declared.** Every statement says whether it came from a
   `walkthrough` or from the `reference` (resource/endpoint reference, operational notes). A
   `walkthrough` statement's quote must lie inside some storyline's span; a `reference`
   statement's quote must lie outside every storyline span.
7. **A group is either anchored or reference-only.** An anchored group names a storyline and has at
   least one `walkthrough` statement whose quote lies inside that storyline's span. A **reference-only
   group** has only `reference` statements and **no storyline**: `storyline: null` on the group and
   on its statements. It never joins a walkthrough storyline. The report lists reference-only
   groups outside every storyline — operations no walkthrough touches; check these are not CRUD fill.
8. **One statement per claim.** A statement's quote (normalised) may appear in only one statement.
9. **Quotes are verbatim** (Markdown emphasis marks, smart quotes and whitespace aside) and at
   least 12 characters. A storyline `quote` is the **full** walkthrough span, start to finish.

## Rubric decisions

- `nfr` expects `aboutBusiness: either`: a retention or audit rule is a business NFR, so the check
  must not force a disagreement on it.
- `external-system` also stays `either`: a system outside the boundary can be named in business
  terms (the payment provider) or technical ones (a queue broker).

The checker cannot judge whether a classification is right, nor whether every claim in the
walkthrough has a statement; that is what the human review is for.

## Machine-readable copy

The same data as JSON. The checker's built-in copy is asserted identical to this block, and the
table above is asserted to match it, by `test/prdTriage.test.ts`.

```json
{
  "rubricVersion": "1.0",
  "independentCheck": "Is this about the business, independent of how it is built?",
  "categories": [
    { "id": "business-fact", "aboutBusiness": true, "outcomes": ["modeled", "rewritten", "parked", "question"], "meaning": "Something that happens or is true in the business; candidate event or field." },
    { "id": "user-intent", "aboutBusiness": true, "outcomes": ["modeled", "rewritten", "parked", "question"], "meaning": "What an actor wants to accomplish; candidate command with its trigger." },
    { "id": "information-need", "aboutBusiness": true, "outcomes": ["modeled", "rewritten", "parked", "question"], "meaning": "What an actor needs to see or know to act; candidate read model." },
    { "id": "actor", "aboutBusiness": true, "outcomes": ["modeled", "parked", "question"], "meaning": "A person, role or calling system; candidate persona." },
    { "id": "business-rule", "aboutBusiness": true, "outcomes": ["modeled", "rewritten", "parked", "question"], "meaning": "A constraint the business imposes; candidate invariant or scenario." },
    { "id": "external-system", "aboutBusiness": "either", "outcomes": ["modeled", "rewritten", "constraint", "parked", "question"], "meaning": "A system outside the boundary; candidate translation slice or constraint." },
    { "id": "implementation-detail", "aboutBusiness": false, "outcomes": ["rewritten", "constraint", "parked", "question"], "meaning": "How it is built. Rewritten in business language when it implies a business fact; a real tech choice goes to the constraints list." },
    { "id": "nfr", "aboutBusiness": "either", "outcomes": ["constraint", "parked", "question"], "meaning": "Performance, availability, security, compliance: feeds the constitution, never a slice." },
    { "id": "goal-background", "aboutBusiness": true, "outcomes": ["parked", "rewritten", "question"], "meaning": "Why the product exists; context for the main storyline, not a slice." },
    { "id": "question", "aboutBusiness": "either", "outcomes": ["question", "parked"], "meaning": "An open question in the source; becomes a Socratic question, never an invented answer." },
    { "id": "resource-or-endpoint", "aboutBusiness": false, "outcomes": ["rewritten", "parked", "question"], "meaning": "Describes an API resource or endpoint. Rewritten to the intent it serves (one endpoint may carry several); never promoted to a command as-is." }
  ]
}
```
