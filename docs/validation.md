# Validation rules

`em validate` checks a model against the rules of Event Modeling. Errors block rendering
(`em render` refuses, `em watch` skips the save); warnings print but don't. The same checks
run on every command that reads a model.

Every rule below has a stable `code` in `em export`/`em diff --json`'s `diagnostics[]` (added
in schema `1.4`/`1.5`, MIL-91) — e.g. the "read model with no consumer" row is
`both-ends-of-a-flow/view-unconsumed`. Terminal output (what's shown here in prose) never
changes; `code` is the CI-matchable contract for consumers that want to gate or bucket
findings without parsing message text. See [cli.md](cli.md#em-export-file).

## Errors

| Rule | Fix |
|---|---|
| Two elements of the same band in one slice (a collision — e.g. two commands, or two `ui`s in the same persona row) | Split them into separate slices |
| `view X from "Event"` where no such event exists | Fix the name, or add the missing event |
| An event feeding a view instance that sits earlier on the timeline | Add `view X again` at the point where the event lands, and move the source there (see [timeline.md](timeline.md)) |
| A reaction's `from "View"` where no such read model exists | Fix the name, or add the missing view |
| A reaction reading a view before any instance of it exists | Declare the view in or before the reaction's slice |
| `view X again` with no earlier declaration of `X` | Declare the view plainly the first time it appears |
| An `arrow` endpoint that matches no element | Fix the name |
| An `arrow` that points backward in time | Restructure so the target comes later |
| An `arrow` between element kinds the four patterns don't connect | Add the missing step — the message names it |
| A declared `type` nesting itself with no array to terminate it (directly or through other declared types) | Break the cycle, or route the self/mutual reference through an array (`children: Node[]`) if the data is genuinely tree-shaped — see [dsl.md](dsl.md#named-types) |
| A lineage ref (`split-from`/`merged-from`/`superseded-by`) that doesn't match the `<slice-key>@v<N>` grammar (`lineage-ref-malformed`) | Fix the value to `<slice-key>@v<N>`, or remove it |
| A lineage ref that names its own slice, or that closes a cycle with another slice's lineage ref (`lineage-ref-cycle`) | Break the cycle — a slice can't be its own ancestor |
| `superseded-by` naming a slice absent from the current model (`lineage-forward-dangling`) | Fix the key, or remove the stale successor |
| A lineage ref naming a version higher than the target slice's own current `version:` (`lineage-version-impossible`) | Fix the version number, or ratify the target slice first |

The timeline rules ("time flows left to right") are the Two Laws in action;
[timeline.md](timeline.md) explains them with examples.

### Connection legality

em infers a slice's arrows from its shape, and only ever infers legal ones, so a
hand-written `arrow` is the single way an illegal connection can get into a model. Those are
checked against the [four patterns](patterns.md): the only pairs allowed are
`ui → command`, `command → event`, `event → read model`, `read model → ui`,
`read model → reaction`, and `reaction → command`.

Everything else is an error, reported with the step that's missing:

```
error:39 arrow "Open Ticket" -> "Ticket Queue" connects a command directly to a read
         model: an event has to sit between them (command -> event -> read model)
```

That one is the CQRS violation — a write is only ever visible to a reader through the event
it recorded. The same check catches `read model → command` (a reaction belongs between
them), `event → command`, `event → event` (Law 1), and an arrow between two instances of one
read model (see [timeline.md](timeline.md)).
[examples/timeline-rules-invalid.em](../examples/timeline-rules-invalid.em) collects one of
each; run `em validate` on it to see all five.

### Lineage

`em validate` is the one place this table's checks aren't a pure function of the `.em` source:
resolving a `split-from`/`merged-from`/`superseded-by` ref means also reading `slices/*.md`
frontmatter (see [slice-doc-schema.md](slice-doc-schema.md#lineage-grammar-and-cardinality)) —
the first, and so far only, `em validate` rule that touches the filesystem.

The rigor boundary is deliberate (ratified MIL-84, 2026-08-13): **validate checks what the
current tree can falsify, and stays silent about what it can't.** `split-from`/`merged-from`
are claims about history — for a rename, merge, or removal, the predecessor is *supposed* to
be absent from the current tree afterward. `merged-from: cart@v3` on a doc whose predecessor
was legitimately removed references an absent key **forever**; that's the steady state a real
merge leaves behind, not a defect, so it gets no diagnostic at all — not even a warning. Only
what's actually checkable against the present gets flagged: malformed grammar, a
self-reference or cycle, a `superseded-by` pointing at nothing (a *forward* ref — it names the
present, so absence there is a real broken link), and version arithmetic that names a future
that hasn't happened when the target does resolve.

Deep historical verification — did `slice@vN` really, once, exist? — never happens in core
validate; a same-commit authoring convention substitutes for it instead. The lineage ref is
written in the same ratification commit that performs the operation it records, so the PR diff
already contains both sides of the claim, and the reviewer's read of that diff *is* the history
check, at the moment history was still the present. If a deeper audit (walk git, prove every
ref) is ever wanted, that's a separate CI-recipe-tier or conformance-walker concern — never
this fast, current-tree-only rule.

## Warnings

| Rule | Fix |
|---|---|
| A `processor`/`translation` shares a slice with a command | Reactions trigger commands; put the triggered command in the next slice |
| A `ui` shares a slice with a `processor`/`translation` and no command | `ui` only wires to `command`; move it to the read-model slice, or to the slice with the command it should trigger |
| A command nothing triggers | Add the screen it's issued from, or the reaction that issues it |
| A command that records no event | Add the event, or reconsider the command |
| An event no read model reads | Project it into a view, or reconsider recording it |
| A read model with no source | Add `from "Event"`, or place it in a slice with an event |
| A read model nothing consumes | Add the screen that displays it or the reaction that watches it, or drop the instance |
| A name defined more than once and referenced by a `from` or `arrow` | Rename; references resolve to the first occurrence |
| A declared `type` name defined more than once — unconditional, unlike the element check above (there's no legitimate unreferenced-duplicate case for a named type) | Rename; references resolve to the first occurrence |
| An element carries an open `issue "text"` | Resolve the question, then remove the clause |
| A `view` field with no matching field on any source event | Add the field to the event, or drop it from the view |
| An `event` field not provided by any command in its slice | Add the field to the command, or drop it from the event |
| A slice doc's `status: implemented` with no `implementedIn` link (`frontmatter-coherence-implemented-without-link`) | Add the `implementedIn` link, or move `status` back if it hasn't actually shipped |

Rendering also warns (without failing) when a `note "path.md"` points at a file that
doesn't exist.

### Both ends of a flow

Four warnings guard the chain that runs screen → command → event → read model → screen. Read in
order they say: something starts the write, the write records something, someone projects it, and
someone looks at the projection. Every element in that chain has a link in and a link out, and
each warning is one link missing.

Put another way: they enforce that every slice is a **complete** instance of one of the
[four patterns](patterns.md), not a half-slice. A State Change is `ui → command → event`; a State
View is `event → read model → ui`. A slice holding only part of one is unfinished.

- **A command nothing triggers** is a write nobody can start. A command is issued by a person
  on a screen or by a reaction acting on their behalf — it doesn't fire itself. It counts as
  triggered when a `ui` sits in its slice, when an automation/processor/saga/translation sits
  in the **previous** slice (the two-slice reaction split), or when an explicit `arrow` points
  to it from a screen or reaction.
- **A command that records no event** is a write that changes nothing.
- **An event no read model reads** is a write nobody can see. There is no point recording a
  fact nothing projects. It counts as read when a `view` names it in `from`, when a `view` with
  no `from` sits in its slice, or when an explicit `arrow` points from it to a read model. Any
  instance of a repeated read model counts, so `view X again from "Event"` satisfies it.
  A reaction consuming it does **not** count — reactions read read models, not events.
- **A read model nothing consumes** is information projected out of the system and then dropped.
  It counts as consumed when a `ui` sits in its slice (State View), when a reaction sits in its
  slice or reads it by name from a later slice (Automation/Translation), or via an explicit
  `arrow` out of it. In a headless model the consumer is the `ui` tagged to the API-caller
  persona — same rule, no special case. Each instance of a repeated read model needs its own
  consumer: if you repeat a view next to an event purely to keep the arrow short, bring its screen
  along, or don't add the instance.

All four are warnings rather than errors on purpose. A model under construction spends most of
its life with one end of a flow ahead of the other, and errors block rendering — `em watch`
would stop redrawing mid-session exactly when you most want to see the diagram.

### Fields completeness

This is the payoff of the `{ fields }` block for slicing rigor: once you bother writing down
what data an element actually carries, `em validate` can check that data flows forward
consistently instead of trusting it by eye.

- **View ← events** — every field on a `view` should trace back to a field on one of its
  source events (any instance of each named event, unioned). A view field with no matching
  event field gets a warning.
- **Event ← command** — every field on an `event` should trace back to a field on a command
  in the same slice (unioned across commands, in the rare case a slice has more than one).
  An event field the command never mentions gets a warning.

Both checks only fire when **both sides declare `{ fields }`** — the view/event being
checked, and *every* element on the contributing side (every source event of the view;
every command in the slice). A model that never uses fields produces zero completeness
warnings, a view/event that hasn't gotten a fields block yet is silently skipped rather
than flagged, and a mixed contributing side (say, `from "A", "B"` where only `A` declares
fields) is also skipped — a fieldless `B` may well be the field's provider, so a warning
there could flag a legitimate field. Field names are matched with the same
normalization as `from`/`arrow` references (trim, lowercase, collapse whitespace); types are
not compared. UI fields, cross-slice/automation tracing, and rename detection are out of
scope for now.

**Expect some of these warnings to be correct and permanent.** System-generated data —
identifiers the server mints, `…At` timestamps taken at decision time, values a read model
derives rather than copies — legitimately appears on an event or view without appearing on
the command that triggered it. The example model shipped with `em` warns for exactly this
reason. The rule can't tell "the system supplies this" from "somebody forgot this", so it
reports both and leaves the judgment to you: confirm it's intentional and move on, or add
the field where it was genuinely missing. That's also why these are warnings and never
block a render or a merge.

An `issue` warning never blocks by default, same as every other warning — `em render`,
`em watch`, and `em validate` all still succeed on a model with open issues. Use
`em validate --list-issues` to print just the open issues (slice, element, line, text), and
`em validate --fail-on-issues` (opt-in) to make CI fail while any remain — see
[cli.md](cli.md).

`divergence "text"` (see [dsl.md](dsl.md#accepted-divergence)) deliberately raises **no**
warning — unlike `issue`, it records a deviation that's already been reasoned about and
ratified, and the entire point of the annotation is that it stops re-firing on every run. Use
`em validate --list-divergences` to audit them on demand; there's no `--fail-on` flag for it
since an accepted divergence should never fail a build.

### Frontmatter coherence

`em validate`'s second fs-aware rule (MIL-85), alongside lineage above: it reads a slice doc's
`status`/`implementedIn` frontmatter and flags exactly one combination as broken —
`status: implemented` with no `implementedIn` link at all. Everything else is silent, including
the one combination that looks the most like drift at a glance.

Requires a well-formed frontmatter fence, same as `em export`'s `frontmatter-invalid` gate — a
legacy body-label-dialect doc (MIL-86's accepted-input form, no `---` fence) never carries
`implementedIn` at all, since that key has no legacy form, so this rule stays silent on such a
doc rather than flag its absence as incoherence.

**The non-obvious case, and the one this rule must never flag:** re-ratifying a shipped slice
(bumping `version`, drafting a new delta) correctly flips `status` back off `implemented` —
typically to `ready-to-implement` — while `implementedIn` keeps naming the *prior* version's PR
until the new version ships. That mismatch (`status` no longer `implemented`, `implementedIn`
still set) is the expected signature of a ratified-but-unshipped delta, not incoherence — see
[slice-doc-schema.md#status-under-re-ratification](slice-doc-schema.md#status-under-re-ratification).
Flagging it would train people to ignore the warning, which is worse than not having the rule at
all. `em export`'s `slice.doc.driftSignal` (schema `1.5`) carries the same classification
(`in-sync` / `never-implemented` / `unpropagated-delta` / `implemented-without-link`) for
consumers — like the event-modeling skill's `conform` phase — that need to distinguish "known,
unpropagated delta" from "real drift" without re-deriving this rule's logic themselves.

## What the validator can't catch

Connection legality is checked on `arrow` statements, which is where an illegal connection
can be written down. It can't be checked on slice *shape*, because shape is what em reads to
infer arrows in the first place: a `translation` or `processor` sharing a slice with an
`event` but no `command` is a reaction wired straight to an event, and nothing flags it. em
only warns when a reaction shares a slice with a command. Reactions must always go through a
command (`reaction → command → event`, split across two slices); enforce that by
construction. The [patterns](patterns.md) doc covers why.

`em validate` is also single-model by design: a name reused across kinds *within* one file is
flagged ("ambiguous names", above), but the same term used inconsistently *across* files is
not — that's `em glossary`'s job, not the validator's (see [cli.md](cli.md#em-glossary-files)).
