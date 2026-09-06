<!--
The implementation constitution: the house rules an implementing agent follows on EVERY slice —
stack, code style, testing norms, NFR baselines, review norms. It answers "how do we build things
here" once, so no slice doc has to repeat it and no agent has to invent it. Slice docs say WHAT to
build; this says HOW it gets built here.

Where this document lives:
  - No SDD tool: `constitution.md` beside the model — `em scaffold` writes it there.
  - spec-kit project (a `.specify/` directory exists anywhere above the model): the document IS
    `.specify/memory/constitution.md`. em writes no second copy; the sections below merge into
    that file under these same headings, never overwriting text already there, and ratification is
    recorded in spec-kit's own `**Ratified**:` footer line instead of the frontmatter below.

How it gets filled: not by an agent guessing. Each section opens with the question a short
facilitated conversation asks before the first slice is implemented — the procedure is "Before the
first slice: the constitution" in the `event-modeling-implement` skill's `reference/implement.md`
(`em contract` prints it). Replace each `{{...}}` block with the real answers; delete the guidance
comments and any row that doesn't apply.

Ratification: `ratifiedBy:`/`ratifiedOn:` are the same identity discipline slice docs use — a
NAMED human and an ISO date, hand-filled at sign-off (no `em` command writes this file).
**A constitution with an empty `ratifiedBy:` is a draft**: an implementing agent treats it as
unratified, says so, and does not proceed on unilateral style or stack decisions for a first slice.

`em status` reports this document as present or absent per model — existence only. em never reads
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

Routing — which implementation skill or approach each of the four slice patterns uses:

| Pattern | Skill / approach |
|---|---|
| State Change | {{e.g. the `axon-*` skill set — axon-entity-patterns, then axon-entity-testing}} |
| State View | {{e.g. the `axon-*` skill set — axon-projection-patterns, then axon-projection-testing}} |
| Automation | {{e.g. the `axon-*` skill set — axon-policy-patterns, then axon-policy-testing}} |
| Translation | {{e.g. the `axon-*` skill set — axon-translation-patterns}} |

An agent implementing a slice reads the doc's `pattern:` frontmatter and follows that row — this
table is the only routing rule.

## Code style

> **What does "idiomatic" mean in this codebase — formatting, naming, module layout?**

- **Formatter / linter:** {{the tool and the command that runs it — never hand-format against it}}
- **Naming:** {{commands, events, handlers, files, test names}}
- **Module layout:** {{what lives in which file/package, and what may not import what}}
- **Idiomatic here means:** {{the two or three habits a new contributor most often gets wrong}}

## Testing norms

> **What must be tested for each slice pattern, where do those tests live, and how are they named
> so `em coverage` can trace invariant IDs?**

- **Levels required per pattern:** {{e.g. State Change — decider unit tests plus a
  given/when/then fixture test; State View — projection tests; Automation / Translation —
  reaction tests, including a negative case}}
- **Invariant tests:** {{where they live}} — every `INV-<MNEMONIC>-n` in a slice doc needs at least
  one test **citing that exact ID** in its name or a comment, so
  `em coverage <model>.em --tests <dir>` can trace it.
- **Scenario tests:** {{where they live}} — one per `## Scenarios (Given / When / Then)` entry,
  with rejection scenarios asserting the doc's named rejection reason.
- **Test naming convention:** {{the exact pattern, e.g. `INV-ORD-3: rejects a second submit`}}
- **What "green" means:** {{the command CI runs}}

## NFR baselines

> **What standing non-functional defaults does every slice inherit — authz, PII, performance,
> observability?**

- **Authorization model:** {{who may issue which commands, how it's enforced, and where}}
- **PII / data handling:** {{what is sensitive, what may be logged, retention}}
- **Performance defaults:** {{latency / throughput budgets that apply unless a slice says otherwise}}
- **Observability:** {{logging, metrics, tracing every slice is expected to emit}}

A slice doc's own `## Non-Functional Requirements` section overrides these for that slice; where
it is silent, these apply.

## Review and merge norms

> **Who reviews an implementation PR, what blocks a merge, and how does the slice doc's status
> flip fit in?**

- **Reviewers:** {{who — a team, a CODEOWNERS rule, the slice's ratifier}}
- **What blocks a merge:** {{e.g. a failing suite, an uncovered invariant, a gap that belongs back
  at the model}}
- **Branch / commit conventions:** {{...}}
- **At merge:** run `em slice mark-implemented <model>.em <slice-key> <pr-url>` — the one edit an
  implementing agent makes to a ratified slice doc, run by {{the PR author | CI}}. Never bump
  `version:`; that moves only when a delta is ratified.
