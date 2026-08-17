# The model lifecycle

The other docs are organized by artifact: [dsl.md](dsl.md) is the notation, [cli.md](cli.md)
is every command, [validation.md](validation.md) is every rule. This one is organized by
**time** — what you do with a model over the months after you first write it, and which
piece of `em` belongs at each point.

The short version: a model is worth keeping only if it stays true. Everything below exists
to make staying true cheap.

| Stage | What you do | Command or phase | What it leaves behind |
|---|---|---|---|
| 1. Build | Model the process — greenfield or from an existing system | `/event-modeling discover` or `extract` | `<model>.em`, rendered diagram |
| 2. Specify | Deepen each slice into an implementable spec | `/event-modeling slice` | `slices/<name>.md`, linked via `note` |
| 3. Gate | Keep the committed model honest | `em validate` in CI | A failing check on a broken model |
| 4. Hand off | Give a slice to whoever (or whatever) builds it | the slice doc; `em export` | Working code, `status: implemented` + `implementedIn` link |
| 5. Track | Show what changed, to engineers and to the business | `em diff`, `em changelog` | Review comments, a business ledger |
| 6. Check | Ask whether the code still matches the model | `/event-modeling conform` | `conformance/<date>-report.md` |
| 7. Ratify | Decide what the drift means, and record it | you, with the report | An updated model + decisions log |

Stages 6 and 7 loop back into 1 — that's what keeps a model worth trusting a year after
somebody wrote it. Not every model needs all seven; see
[adopting this incrementally](#adopting-this-incrementally) at the end. And for the
responsibility view of the same lifecycle — which stages need humans in the room, which an
agent can carry with review — see [process.md](process.md).

## 1. Build the model

If the process is new, run `/event-modeling discover` and answer questions — the skill
facilitates, you supply the domain, and the diagram grows live in a browser
([ai-workflow.md](ai-workflow.md)). If the system already exists, run `extract` instead: it
derives a current-state model from the code and confirms each round with you, parking
anything unclear rather than guessing.

You can also just write the `.em` by hand — the [tutorial](tutorial.md) builds a complete
model from an empty file in about twenty minutes, and the DSL is small enough that most
people are productive in it the same day.

Keep a live view open while you work (`em watch <file> --serve`). On a shared screen it
turns modeling into a group activity rather than a scribe exercise.

**When something is genuinely unresolved, write it down instead of deciding it alone:**

```em
event Order Placed @Order issue "does a placed order lock the price at placement time?"
```

That renders as a red marker on the diagram with the question in a tooltip — the plain-text
equivalent of a red sticky on a workshop wall. It is the cheapest habit in this whole
document and the one most worth forming: a model with visible open questions is more
trustworthy than one that looks finished because somebody guessed.

## 2. Specify the slices

The `.em` file holds structure. Depth belongs in prose, one markdown file per slice, linked
from the diagram with `note "slices/<name>.md"`. The `slice` phase produces these: field
tables with validation rules, named invariants, Given/When/Then scenarios, error flows.

Each slice doc carries machine-read YAML frontmatter — the full contract is
[slice-doc-schema.md](slice-doc-schema.md) — whose `status` moves as the work does:

```
draft → reviewed → ready-to-implement → implemented
```

`implemented` also records where — `implementedIn`, a PR or commit link. That link looks like
bookkeeping and isn't: it's what stage 6 uses to know which slices are worth checking against
code, and what a future reader follows to find out how a business rule was actually built.
The frontmatter also carries `version:`, which bumps when a change to an already-shipped
slice is ratified — recorded in the doc's `## Delta` section as typed operation blocks — and
lineage keys (`split-from`/`merged-from`/`superseded-by`) when a slice splits, merges, or is
renamed, so its history survives the reshuffle.

Add `{ fields }` to elements as you learn them. Once both sides of a flow declare fields,
`em validate` starts checking that data traces forward — a view field with no source event,
an event field no command provides ([validation.md](validation.md#fields-completeness)).

## 3. Gate the model in CI

Commit the `.em` alongside the code and treat it like any other source file: a pull request
that breaks it should fail before merge, not after. [ci.md](ci.md) has a copy-paste GitHub
Actions workflow that runs `em validate` on every changed model.

`em validate` fails only on **errors** — structural breakage like an unresolved `from` or a
backward-pointing arrow. Warnings, including open `issue` clauses, never block, so the gate
doesn't get noisy as a model evolves. If you want open questions to block a *handoff*
specifically, that's the per-slice readiness gate — `em validate --slice-ready <key>`, run at
stage 4, not on every PR ([cli.md](cli.md#--slice-ready-key-mil-87)); `--fail-on-issues`
remains for gating a whole model on its open `issue` clauses.

## 4. Hand a slice off

A slice is a good unit of work precisely because it's bounded: one command, its event(s),
the read models involved, the invariants that must hold, and scenarios that compile to
tests. Hand the slice doc to an engineer or an agent and it is, in most cases, a complete
brief.

The handoff has a gate: a slice goes out only once it's **ratified** — a human flips its
`status` to `ready-to-implement` with every open question resolved
([process.md](process.md#what-ratified-means)). That's mechanically checkable:

```bash
em validate model.em --slice-ready <key>    # exits non-zero until the slice is safe to hand off
```

For an agent implementer, the bundled skill ships the full contract to follow —
[the agent guide](../.claude/skills/event-modeling/reference/implement.md): the readiness
gate, the read-only rule on ratified docs, propose-don't-decide for gaps, the merge-time
status flip, and the spec-kit adapter (em-sdd-bridge) where one applies.

For anything programmatic — a generator, a dashboard, an MCP server, your own scripts —
consume `em export` rather than parsing the DSL:

```bash
em export model.em -o model.json
```

The JSON is versioned (`schemaVersion`), byte-deterministic, and gives every slice and
element a **stable ref** that survives inserting and reordering slices. Build tooling
against those refs and it keeps working as the model grows ([cli.md](cli.md#em-export-file)).

When the work lands, set the slice's status to `implemented` and fill in the link.

## 5. Track what changed

`git diff` on a `.em` file shows line hunks. `em diff` shows what happened to the *model*:

```bash
em diff model.em --from HEAD~1        # what this PR did to the model
em diff model.em --from v1.0 --to v2.0
```

Slices and elements added or removed, elements moved between slices (collapsed into one
line instead of a delete here and an add there), field changes, and issue lifecycle —
opened, resolved, reworded. Add `--exit-code` to gate on "the model changed at all", or
`--json` to feed it to something else.

For the business-facing counterpart, `em changelog` renders the model's git history as the
ledger it already is — one section per commit that touched the model, newest first, with
the structural delta and, woven in by date, the decisions recorded in the state file:

```bash
em changelog model.em -o CHANGELOG.md
```

This is the artifact to bring to a stakeholder who will never open a diagram: *what did we
decide about this business process, and when*.

## 6. Check the model against the code

Over time the code drifts from the model — not through malice, just through Tuesdays. A
process model that nobody verifies eventually becomes decoration, which is how an earlier
generation of process-modeling tools died. The `conform` phase is the answer to that:

```
/event-modeling conform
```

It walks each in-scope slice, gathers evidence from the code **before** comparing anything
to the model, builds a scratch as-is model, and lets `em diff --json` decide what
structurally differs. It checks three surfaces:

| Surface | What drifts |
|---|---|
| Structural | The `.em` versus the code — slices, elements, fields, flow |
| Spec | The slice doc versus the code — field rules, named invariants, scenarios without tests |
| Internal | The slice doc versus the `.em` — the two disagreeing with each other |

Output is a report at `conformance/<date>-report.md`: every finding classified as real
drift, a model gap, an internal inconsistency, or an honest uncertainty — each with cited
file paths — plus a proposed `issue "conformance: …"` red note for the findings that
warrant one.

Three properties are deliberate. It is **advisory**: nothing fails a build, because a
false accusation of drift destroys trust in the loop faster than real drift justifies it.
It **proposes, never edits**: the report is a recommendation, and you decide. And it is
**diff-scoped by default** — after the first full run it only walks slices whose code has
changed since, which is what makes a recurring cadence affordable. [ci.md](ci.md) has a
scheduled-run recipe.

## 7. Ratify the findings

Walk the report and rule on each finding. In practice they fall into three buckets:

- **The code is right and the model is stale** — fix the model directly. No red note
  needed; the disagreement is resolved.
- **There's a real open decision** — apply the proposed red note. The question is now
  visible on the diagram, and `em validate --list-issues` will keep surfacing it until
  somebody rules.
- **The doc is stale prose** — fix the wording. Nothing structural to record.

Then write down what you decided in the state file's decisions log, with the date. That
log is what `em changelog` weaves back into stage 5, which is how a decision made in a
conformance review in July is still explaining itself to somebody in November.

Update the state file's `Last conformance:` marker and you're back at stage 1 with a model
you have fresh evidence to trust.

## Adopting this incrementally

Nothing here is all-or-nothing, and most teams should not start at stage 6.

Stages 1–3 — model it, specify it, validate it in CI — are the whole value proposition for
most teams, and plenty of models never need more than that. Stage 4 pays off as soon as
more than one person or agent is implementing from the model. Stages 5–7 start earning
their keep when the model is old enough to have drifted, which is usually months in, and
when somebody other than the author depends on it being accurate.

A fair warning about maturity: stages 1–5 are ordinary deterministic tooling, well covered
by tests, and used daily. The conformance loop in stages 6–7 is newer. Its first real
outing was a 19-slice model against a ~100-file Kotlin/Axon codebase: it produced ten
genuine findings with no false positives, which is encouraging but is one data point, not a
track record. Run it advisory, read the evidence citations rather than trusting the verdict,
and treat a finding as the start of a conversation.

## Which parts enforce, and which advise

| Behavior | Enforced | Advisory |
|---|---|---|
| Structural errors (unresolved `from`, backward arrows) | `em validate` exits non-zero | — |
| Open `issue` clauses | only with `--fail-on-issues` (opt-in) | warning by default |
| Fields completeness | — | warnings |
| Slice readiness at handoff | `em validate --slice-ready <key>` exits non-zero (opt-in, per slice) | — |
| Model changed at all | only with `em diff --exit-code` | — |
| Slice-doc `version:` ↔ content agreement | `em ledger` exits non-zero (opt-in, needs git history) | — |
| Vendored skill drift | `em skill check` exits non-zero (opt-in) | — |
| Conformance findings | never | always — you ratify |

The pattern is deliberate: `em` is strict about things that are unambiguously wrong, and
advisory about everything that requires human judgment. A model is a description of a
business, and no tool gets to overrule you about your own business.

## Where to go next

- [tutorial.md](tutorial.md) — build a model from an empty file, if you haven't yet
- [ai-workflow.md](ai-workflow.md) — the skill's phases in detail
- [cli.md](cli.md) — every command and flag referenced above
- [ci.md](ci.md) — the validate gate and the conformance cadence recipe
