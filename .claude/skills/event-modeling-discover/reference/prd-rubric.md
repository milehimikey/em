# PRD/spec triage rubric — version 1.0

The shipped classification rubric for the PRD/spec path (`prd-spec-path.md`, step 2). It is data:
`em discover triage-check` rejects a `discovery/prd-triage.json` whose `rubricVersion` is not the
version below, and rejects an `outcome` the category does not allow. Do not edit it per project;
a changed rubric ships with a new `rubricVersion` in a new `em` release.

The independent check, run on every statement in addition to its category:
**"Is this about the business, independent of how it is built?"** (`aboutBusiness` true/false).
If the check and the category disagree (a "business rule" that names a table; an
"implementation detail" that states a business fact), the statement is low confidence and becomes
a question for the human.

| Category id | What it is | Becomes | Allowed outcomes |
|---|---|---|---|
| `business-fact` | Something that happens or is true in the business | Candidate event or field | modeled, rewritten, parked |
| `user-intent` | What an actor wants to accomplish | Candidate command, with its trigger | modeled, rewritten |
| `information-need` | What an actor needs to see to act | Candidate read model | modeled, rewritten |
| `actor` | A person, role or calling system | Candidate persona | modeled, parked |
| `business-rule` | A constraint the business imposes | Invariant or scenario of a slice | modeled, rewritten |
| `external-system` | A system outside the boundary | Translation slice, or a constraint | modeled, rewritten, constraint |
| `implementation-detail` | How it is built | Rewritten to the business fact it implies, or a constraint | rewritten, constraint, parked |
| `nfr` | Performance, availability, security, compliance | Constraint feeding the constitution | constraint, parked |
| `goal-background` | Why the product exists | Context for the main storyline | parked, rewritten |
| `question` | An open question in the source | A Socratic question | question |
| `resource-or-endpoint` | Describes an API resource or endpoint | Rewritten to the intent it serves; one endpoint may carry several intents; never a command as-is | rewritten, question, parked |

Outcomes: `modeled` (joins a slice group as stated), `rewritten` (joins a group in business
language, with the original linked), `constraint` (constraints list), `parked` (a reason, and a
Decisions-log entry), `question` (a Socratic question for the human).

The same data, machine-readable (the checker's copy is asserted identical to this block by
`test/prdTriage.test.ts`):

```json
{
  "rubricVersion": "1.0",
  "independentCheck": "Is this about the business, independent of how it is built?",
  "categories": [
    { "id": "business-fact", "label": "Business fact", "outcomes": ["modeled", "rewritten", "parked"], "meaning": "Something that happens or is true in the business; candidate event or field." },
    { "id": "user-intent", "label": "User intent", "outcomes": ["modeled", "rewritten"], "meaning": "What an actor wants to accomplish; candidate command with its trigger." },
    { "id": "information-need", "label": "Information need", "outcomes": ["modeled", "rewritten"], "meaning": "What an actor needs to see or know to act; candidate read model." },
    { "id": "actor", "label": "Actor", "outcomes": ["modeled", "parked"], "meaning": "A person, role or calling system; candidate persona." },
    { "id": "business-rule", "label": "Business rule", "outcomes": ["modeled", "rewritten"], "meaning": "A constraint the business imposes; candidate invariant or scenario." },
    { "id": "external-system", "label": "External system", "outcomes": ["modeled", "rewritten", "constraint"], "meaning": "A system outside the boundary; candidate translation slice or constraint." },
    { "id": "implementation-detail", "label": "Implementation detail", "outcomes": ["rewritten", "constraint", "parked"], "meaning": "How it is built. Rewritten in business language when it implies a business fact; a real tech choice goes to the constraints list." },
    { "id": "nfr", "label": "Non-functional requirement", "outcomes": ["constraint", "parked"], "meaning": "Performance, availability, security, compliance: feeds the constitution, never a slice." },
    { "id": "goal-background", "label": "Goal or background", "outcomes": ["parked", "rewritten"], "meaning": "Why the product exists; context for the main storyline, not a slice." },
    { "id": "question", "label": "Question", "outcomes": ["question"], "meaning": "An open question in the source; becomes a Socratic question, never an invented answer." },
    { "id": "resource-or-endpoint", "label": "Resource or endpoint description", "outcomes": ["rewritten", "question", "parked"], "meaning": "Describes an API resource or endpoint. Rewritten to the intent it serves (one endpoint may carry several); never promoted to a command as-is." }
  ]
}
```
