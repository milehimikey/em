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
| A composite `tag` naming a field the event doesn't declare (`tag-composite-unknown-field`) | Fix the field name, or add it to the event's fields — see [dsl.md](dsl.md#event-tags) |
| An event declaring the same tag key twice — inline identity and element-level keys share one namespace (`tag-duplicate-key`) | Rename one of the tags so every key on the event is unique — see [dsl.md](dsl.md#event-tags) |
| A lineage ref (`split-from`/`merged-from`/`superseded-by`) that doesn't match the `<slice-key>@v<N>` grammar (`lineage-ref-malformed`) | Fix the value to `<slice-key>@v<N>`, or remove it |
| A lineage ref that names its own slice, or that closes a cycle with another slice's lineage ref (`lineage-ref-cycle`) | Break the cycle — a slice can't be its own ancestor |
| `superseded-by` naming a slice absent from the current model (`lineage-forward-dangling`) | Fix the key, or remove the stale successor |
| A lineage ref naming a version higher than the target slice's own current `version:` (`lineage-version-impossible`) | Fix the version number, or ratify the pending delta on the target slice first (bumping its `version:`) |

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

This is one place this table's checks aren't a pure function of the `.em` source: resolving a
`split-from`/`merged-from`/`superseded-by` ref means also reading `slices/*.md` frontmatter
(see [slice-doc-schema.md](slice-doc-schema.md#lineage-grammar-and-cardinality)). It is one of
three fs-aware rule families in `em validate`, alongside
[frontmatter coherence](#frontmatter-coherence) and the opt-in
[slice readiness](#slice-readiness) gate; every other rule reads only the `.em`.

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

That "separate CI-recipe-tier" concern is exactly what `em ledger` (MIL-89) is: a two-revision
check of a different invariant (does a slice doc's `version:` field agree with its content?),
opt-in and never folded into `em validate` for the same reason — it needs git history this
command deliberately never touches. See [cli.md#em-ledger-file](cli.md#em-ledger-file) and
[ci.md#em-ledger-opt-in](ci.md#em-ledger-opt-in).

## Warnings

| Rule | Fix |
|---|---|
| A `processor`/`translation` triggers no command | Add the command it issues, in this same slice, or an explicit `arrow` to one elsewhere |
| A `ui` shares a slice with a `processor`/`translation` | `ui` only wires to a `command` a person issues; move it to the slice that displays the read model, or drop it |
| A command nothing triggers | Add the screen it's issued from, or the reaction that issues it, both in this slice |
| A command that records no event | Add the event, or reconsider the command |
| An event with no producing command | Add the command that records it, or an explicit `arrow` from one |
| An event no read model reads | Project it into a view, or reconsider recording it |
| A read model with no source | Add `from "Event"`, or place it in a slice with an event |
| A read model nothing consumes | Add the screen that displays it or the reaction that watches it, or drop the instance |
| A `ui` with no read model backing it and no command it issues | Add a `view` it displays, or the command it triggers, or reconsider the screen |
| Two `translation`s sharing a name but reading from different producers | Rename one; a shared name for two unrelated external messages reads as one and confuses whoever reads the model next |
| A name defined more than once and referenced by a `from` or `arrow` | Rename; references resolve to the first occurrence |
| An event marked `public` that no read model reads (unconditional variant of "An event no read model reads") | Mark it `public` only if its consumer is outside this model; otherwise add the view |
| A view marked `public` with no consumer (unconditional variant of "A read model nothing consumes") | Mark it `public` only if its consumer is outside this model; otherwise add the screen or reaction |
| A declared `type` name defined more than once — unconditional, unlike the element check above (there's no legitimate unreferenced-duplicate case for a named type) | Rename; references resolve to the first occurrence |
| An element carries an open `issue "text"` | Resolve the question, then remove the clause |
| A `view` field with no matching field on any source event | Add the field to the event, or drop it from the view |
| An `event` field not provided by any command in its slice | Add the field to the command, or drop it from the event |
| A slice doc's `status: implemented` with no `implementedIn` link (`frontmatter-coherence-implemented-without-link`) | Add the `implementedIn` link, or move `status` back if it hasn't actually shipped |

Rendering also warns (without failing) when a `note "path.md"` points at a file that
doesn't exist.

### Both ends of a flow

Seven warnings guard the chain that runs screen/reaction → command → event → read model →
screen/reaction. Read in order they say: something starts the write, the write records
something, someone projects it, and someone looks at the projection. Every element in that
chain has a link in and a link out, and each warning is one link missing.

Put another way: they enforce that every slice is a **complete** instance of one of the
[four patterns](patterns.md), not a half-slice. A State Change is `ui → command → event`; a State
View is `event → read model → ui`. A slice holding only part of one is unfinished.

- **A command nothing triggers** is a write nobody can start. A command is issued by a person
  on a screen or by a reaction acting on their behalf — it doesn't fire itself. It counts as
  triggered when a `ui` sits in its slice, when an automation/processor/saga/translation sits
  in that **same** slice, or when an explicit `arrow` points to it from a screen or reaction
  elsewhere.
- **A reaction that triggers no command** is the mirror case: a decision the system never acts
  on. A `processor`/`automation`/`saga`/`translation` never records an event itself — it counts
  as triggering when a `command` sits in its own slice, or via an explicit `arrow` from it to a
  command elsewhere.
- **A command that records no event** is a write that changes nothing.
- **An event with no producing command** is a fact with no traceable cause — the record side
  can't happen on its own. It counts as produced when a `command` sits in its slice (either
  order), or via an explicit `arrow` into it from a command.
- **An event no read model reads** is a write nobody can see. There is no point recording a
  fact nothing projects. It counts as read when a `view` names it in `from`, when a `view` with
  no `from` sits in its slice, or when an explicit `arrow` points from it to a read model. Any
  instance of a repeated read model counts, so `view X again from "Event"` satisfies it.
  A reaction consuming it does **not** count — reactions read read models, not events.
  **Exemption:** An event marked `public` is part of the published integration surface — its
  reader is outside this model, possibly outside this system. The warning is suppressed; record
  the fact and let downstream contracts govern consumption.
- **A read model nothing consumes** is information projected out of the system and then dropped.
  It counts as consumed when a `ui` sits in its slice (State View), when a reaction sits in its
  slice or reads it by name from a later slice (Automation/Translation), or via an explicit
  `arrow` out of it. In a headless model the consumer is the `ui` tagged to the API-caller
  persona — same rule, no special case. Each instance of a repeated read model needs its own
  consumer, but a reaction's isn't limited to the single instance nearest it (MIL-75): em's
  span-1/wire-once DSL rules force an accumulating read model across several instances, each
  re-declaring it with `from` naming only the newly adjacent event, and the consuming reaction
  legitimately sits only at the last one — so every instance at-or-before a consuming reaction
  counts as consumed, not just the nearest. (Rendering still draws the reaction's arrow to the
  nearest instance at-or-before it — that resolution is unchanged; only which instances count as
  *consumed* broadens.) An instance strictly after the last consuming reaction still needs its
  own consumer: nothing later reads what it accumulates. If you repeat a view next to an event
  purely to keep the arrow short, and no reaction ever reads that far, bring its screen along or
  don't add the instance.
  **Exemption:** A view marked `public` is a published read API or webhook response shape for
  an external consumer — its reader is outside this model. The warning is suppressed; document
  it as part of the integration surface.
- **A `ui` with no read model backing it and no command it issues** is a screen with nothing
  driving it — often a GET endpoint quietly dropped during extraction, since it doesn't fit the
  "each endpoint is a command" framing that fits the write side. It counts as backed when a
  `view` sits in its slice (State View), it issues a command when one sits in its slice (State
  Change), or via an explicit `arrow` in either direction. A `ui` sharing a reaction's slice
  with no view present gets the more specific "renders disconnected here" warning instead
  (above), not this one — whether or not that slice also has the reaction's own command.

All seven are warnings rather than errors on purpose. A model under construction spends most of
its life with one end of a flow ahead of the other, and errors block rendering — `em watch`
would stop redrawing mid-session exactly when you most want to see the diagram.

### Translation naming

A `translation` reading from two different producers under the same name is a different kind
of duplicate than the "name defined more than once" check above: that check only fires when
something else references the ambiguous name via `from` or `arrow`, since the confusion it
guards against is *which* declaration a reference resolves to. A translation is itself a
producer, not typically something else's target, so two same-named translations reading from
different sources would otherwise pass silently — this check fires unconditionally, because
the confusion is in reading the model, not in resolving a reference. Two translations that
read from the *same* producer (e.g. repeated next to it for clarity) are not a collision and
stay quiet.

### Fields completeness

This is the payoff of the `{ fields }` block for slicing rigor: once you bother writing down
what data an element actually carries, `em validate` can check that data flows forward
consistently instead of trusting it by eye.

- **View ← events** — every field on a `view` should trace back to a field on one of its
  source events (any instance of each named event, unioned). A view field with no matching
  event field gets a warning.
- **Event ← command** — every field on an `event` should trace back to a field on a command
  in the same slice (unioned across commands, in the rare case a slice has more than one).
  An event field the command never mentions gets a warning — unless the field carries a
  trailing `assigned` clause (below).

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

**`assigned` — mark a system-assigned event field (MIL-148).** An identifier the server
mints, an `…At` timestamp taken at decision time — these legitimately appear on an event
without appearing on the command that triggered it, because the client never supplied them;
the handler did. Mark such a field with a trailing `assigned` clause (event fields only,
same trailing-clause family as `tag` and `renamed from`) and it's excluded from the event ←
command check entirely — no warning, and (unlike a warning) it no longer counts against
`em validate --slice-ready` either:

```
event Order Placed {
  orderId assigned
  customerId
  total: Money
  placedAt: Instant assigned
}
```

An `assigned` field stays fully visible to view ← event tracing — the marker narrows only
the event ← command check, not what a downstream view is allowed to read.

**Everything else in this section is still just a warning, and some of it will be correct
and permanent.** A read-model field a view *derives* rather than copies straight from a
single source event (a computed status, an aggregate) has no field-level escape hatch today
— the rule can't tell "the view legitimately derives this" from "somebody forgot this", so
it reports both and leaves the judgment to you: confirm it's intentional and move on, or add
the field where it was genuinely missing. These warnings never block a render or a merge —
but note that unlike an `assigned` field, an un-marked warning **does** still count against
`--slice-ready` if it's scoped to that slice (see [cli.md](cli.md)).

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

Requires usable frontmatter — a closed fence with every required key present
(`hasUsableFrontmatter()`, `src/catalog/sliceDoc.ts`), the exact same predicate `em export`'s
`frontmatter-invalid` gate uses, so the two can't silently disagree on what counts as a readable
doc. A legacy body-label-dialect doc (MIL-86's accepted-input form, no `---` fence) never
carries `implementedIn` at all, since that key has no legacy form; a doc with a fence but a
missing required key (e.g. no `version`) is equally unreadable for this purpose. Either way this
rule stays silent rather than flag an unreadable doc as incoherent.

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

### Slice readiness

`em validate --slice-ready <key>` (MIL-87) is the one rule family that never runs
unconditionally — it's opt-in, scoped to a single named slice, and exists to answer one
question: is this slice safe to hand to an implementer? Native `em` form of the check that used
to live only in em-sdd-bridge's `assertReadyToImplement`. See
[cli.md#--slice-ready-key-mil-87](cli.md#--slice-ready-key-mil-87) for usage and exit-code
semantics. Add `--json` (MIL-128) for a machine verdict naming each of the 4 gates below
individually (`docBound`/`frontmatterUsable`/`statusReady`/`noUncheckedOpenQuestions`) plus the
overall `ready` boolean, instead of scraping this table's codes out of stderr prose — see
[cli.md#--json-mil-128](cli.md#--json-mil-128).

| Code | Severity | Meaning |
|---|---|---|
| `slice-ready-unknown-slice` | error | The given key names no slice in this model — a bad argument, not a model-quality finding |
| `slice-ready-no-doc-bound` | warning | No element declares `note "slices/<key>.md"` (or a ratified `covers` cross-binding to a different slice's doc, MIL-121 — see below) — the note-binding gate `em export`'s doc join (MIL-91) also uses |
| `binding-missing-file` / `frontmatter-invalid` | warning | Reused verbatim from `em export`'s doc join (see [slice-doc-schema.md](slice-doc-schema.md)) — the note names a path with no file there, or the file exists but its frontmatter isn't usable |
| `slice-ready-status-not-ready` | warning | The doc's `status` isn't `ready-to-implement` |
| `slice-ready-open-questions-unchecked` | warning | The doc's `## Open Questions` section has one or more unchecked (`- [ ]`) items |

**Cross-slice binding (MIL-121):** since the two-slice Automation/Translation shape means a
bare `view` slice can have nothing of its own to document, an element in it may instead
`note "slices/<other-key>.md"` — a *different* slice's canonical doc path — and that other
doc's frontmatter `covers` list can ratify the borrow by naming this slice's key back. When
ratified, every check above (status, Open Questions) reads the **covering** doc, exactly as if
it were this slice's own; when NOT ratified (missing file, unusable frontmatter, or no matching
`covers` entry), the slice is silently `slice-ready-no-doc-bound` — same as no note at all, from
*this* check's point of view. The mismatch itself — why that cross-note didn't ratify, or an
extra note doing nothing in an already-bound slice — gets its own diagnostic below
([Note-binding mismatch](#note-binding-mismatch), MIL-126), and folds into `--slice-ready`'s
output the same way frontmatter coherence does (next paragraph), since it's part of the same
unconditional `allDiagnostics` set the scoped filter draws from. See
[slice-doc-schema.md#cross-slice-coverage-covers](slice-doc-schema.md#cross-slice-coverage-covers).

Also folds in any [frontmatter coherence](#frontmatter-coherence) and
[note-binding mismatch](#note-binding-mismatch) finding already scoped to the same slice — not
re-derived, just surfaced alongside the above when present. `--slice-ready` exits non-zero if
any diagnostic (warning or error) concerns this slice — either the bare slice key (every code
above, plus frontmatter coherence and note-binding mismatch) or an element ref inside it
(`<key>/<kind>.<name>`, e.g. an unrelated model rule tripping on an element within the slice
itself). Diagnostics from **other** slices never block this check — the gate is deliberately
single-slice-scoped, matching the ticket's own scenario of checking one slice while the rest of
a large, actively-evolving model is still WIP.

### Note-binding mismatch

`em validate`'s third fs-aware rule (MIL-126), alongside lineage and frontmatter coherence
above: a `note` shaped like `slices/<key>.md` (the doc-binding convention, case-insensitively)
that doesn't actually participate in the slice's resolved doc binding no longer vanishes
silently. Follow-on to [cross-slice binding](#slice-readiness) above — MIL-121
deliberately left every non-ratifying cross-note silent; this is where that silence ends. A
`note` pointing at anything else — a freeform annotation, a path outside `slices/`, any file at
all — is never this rule's business; `note` remains a general-purpose annotation mechanism
rendered on diagrams (see [dsl.md](dsl.md)), not exclusively a doc-binding declaration.

| Code | Meaning |
|---|---|
| `note-binding-extra` | The slice is already bound (canonically, or via a ratified MIL-121 cross-binding) and this note names a *different* doc path — ignored. Also covers a second, later cross-note that would itself have ratified, losing to an earlier one under MIL-121's "first wins" rule — from that note's own point of view, the slice is simply already bound elsewhere. |
| `note-binding-dangling` | The slice is unbound, and this cross-note names a `slices/<key>.md` path with no file there. |
| `note-binding-unusable` | The slice is unbound, and this cross-note's target doc exists but its frontmatter isn't usable (same gate as `frontmatter-invalid`), so it can't ratify anything. |
| `note-binding-unratified` | The slice is unbound, and this cross-note's target doc exists and is usable, but its `covers:` list doesn't name this slice — add `covers: <this-key>` to that doc, or correct the note's path. |

Never warns on: a canonical note (`note "slices/<own-key>.md"`) whose file is missing or whose
frontmatter is unusable — `binding-missing-file`/`frontmatter-invalid` already cover that, and
duplicating them here would be noise; multiple elements carrying the same winning note (canonical
or cross); or a note whose `slices/<key>.md`-shaped target happens to name this slice's own key
in the wrong case — an existing, unrelated case-sensitivity quirk of the exact-match canonical
check, not something this ticket set out to police.

### Doc-model consistency

`em validate`'s fourth fs-aware rule (MIL-124), alongside lineage, frontmatter coherence, and
note-binding mismatch above: the conform phase's "internal surface" check — does a bound slice
doc's structured claims still agree with the `.em` model? — used to be entirely a matter of
agent judgment. This rule makes the mechanically-checkable core of that judgment deterministic.
It only looks at a slice's **resolved** doc binding (`docJoin.ts`'s `resolveSliceDocJoin`, the
same MIL-91/MIL-121-aware resolution `em export` and `--slice-ready` use) with usable
frontmatter — an unbound slice, a dangling/unratified note, or a doc with unusable frontmatter
are all silent here (already covered by `binding-missing-file`/`frontmatter-invalid`/note-binding
mismatch above).

Every check is **declare-gated**: a doc that says nothing structured about a given kind or field
stays silent for it. Partial/draft docs are the normal case; disagreement between what a doc
*does* declare and what the model actually has is the genuine anomaly this rule exists to catch.

| Code | Meaning |
|---|---|
| `doc-model-pattern-mismatch` | The doc's frontmatter `pattern:` doesn't match `classify.ts`'s `classifySlicePattern()` for the doc's owning slice — the same classification `em export` publishes as `slice.pattern`. Silent when the slice classifies as unclassified (nothing to compare against). |
| `doc-model-element-not-in-model` | The doc declares a `**Command:**`/`**Event:**`/`- **View:**` marker naming a command/event/view the model doesn't have — checked only for kinds the doc declares at least one marker of. |
| `doc-model-element-not-in-doc` | The model has a command/event/view the doc never mentions — checked only for kinds the doc declares at least one marker of (a kind with zero markers is silent entirely, not "the doc is missing everything"). |
| `doc-model-field-mismatch` | A matched Command/Event's field table (first column = field name) disagrees with the model element's `{ fields }` block — a field name on one side but not the other, or a type declared on both sides that differs (case-insensitive). Checked only when *both* sides declare at least one field. |

**Name comparison** uses `model.ts`'s own `normalizeName()` — the same case/spacing-insensitive
comparison the DSL itself uses to resolve names — for element names and field names alike, never
a second, independently-invented comparison.

**Body markers** are the slice.md template's own stable shapes:
`` **Command:** `Name` ``, `` **Event:** `Name` `` (optionally followed by `` → context `Ctx` ``),
and `` - **View:** `Name` ... ``. A field table is the markdown table (`| Field | Type | ... |`)
found between a Command/Event marker and the next `##` heading or marker. Parsing is tolerant by
construction: only these exact shapes are recognized at all — prose, a differently-shaped table,
an unfilled `{{field}}` placeholder row — is simply not matched, never a parse error.

**Out of scope, deliberately:** GWT scenarios, invariants (`INV-*`), status coherence (already
[frontmatter coherence](#frontmatter-coherence)), swimlane, the `Read by:`/`Consumed by:` prose
lines, and comparing a doc's `` → context `Ctx` `` against the model's `@Context` tag — all of
these need judgment (or, for `@Context`, were judged not worth a first cut) rather than a
mechanical name/shape comparison, and stay part of the agent-judgment side of the conform phase.

**MIL-121 cross-covered docs:** a doc bound to more than one slice (its own canonical slice, plus
any slice whose ratified `covers:` cross-note points at it) is checked **once**, against the
union of elements across every slice it's the resolved binding for — not once per slice, which
would double-report the same disagreement. A finding with a specific model element to point at
(`doc-model-element-not-in-doc`, field mismatches) anchors there; a finding with nothing model-side
to point at (`doc-model-pattern-mismatch`, `doc-model-element-not-in-model`) anchors at the doc's
*owning* slice — the one canonically bound to the doc's own path.

`--slice-ready` folds these findings in for free, same as frontmatter coherence and note-binding
mismatch — every diagnostic here tags `refs` with the bare slice key (or `<sliceKey>/<kind>.<name>`
element refs), so the existing ref filter picks them up without this module re-deriving anything.

### Orphaned slice doc

`em validate`'s fifth fs-aware rule (MIL-183, the fragility half of
[GitHub #128](https://github.com/milehimikey/em/issues/128)), alongside lineage, frontmatter
coherence, note-binding mismatch, and doc-model consistency above: every one of those four rules
starts from a *slice* and asks "is its doc/note okay?" — none of them ever looked the other way
and asked "does every file in `slices/` still belong to something?" A doc left behind after its
slice is renamed or removed used to just quietly stop applying, with nothing pointing at the
orphaned file itself.

Two doc-join mechanisms coexist in `em`: `docJoin.ts`'s `resolveSliceDocJoin`, gated on an
explicit `note "slices/<key>.md"` binding, drives `em export`/`em status`/the MCP tools; `em
catalog` instead reads `slices/<sliceKey>.md` by bare filename convention, ignoring `note`
entirely (a deliberate, tested invariant — see `src/catalog/build.ts`). The "matched by name,
silently stops applying" experience GH #128 described is `em catalog`'s convention path, so this
rule judges orphan-ness the same way: by filename key (and, for a MIL-121 covering doc, by its
`covers:` list) — never by whether some element happens to carry a `note`.

Only files with **usable frontmatter** (`hasUsableFrontmatter()`, the same gate every fs-aware
rule above uses) are considered slice docs at all — this is what keeps a README, a scratch note,
or an unfinished draft in `slices/` from ever being flagged.

| Code | Meaning |
|---|---|
| `orphaned-slice-doc` | A `slices/*.md` file with usable frontmatter whose own key names no current slice, and whose `covers:` list (if any) doesn't ratify a current slice either. |

**Never warns on:** a file whose key matches a current slice by name, whether or not any note
currently binds it (matching `em catalog`'s own filename-convention lookup); a file with no
usable frontmatter at all (a README, a scratch note, an unfinished draft missing a required
frontmatter key); or a MIL-121 covering doc whose own canonical slice is gone but whose
`covers:` still names a slice currently in the model — the two-slice Automation/Translation
shape's shared-doc case. The `covers:` check only requires the *declaration* to still name a
live slice, not that some note currently wins the binding race for it — a stricter check would
reintroduce exactly the false positive this rule exists to avoid.

### Seam manifest

Raised by [`em system <manifest>`](cli.md#em-system-manifest) (MIL-194), never by `em validate`:
the cross-model half of [Both ends of a flow](#both-ends-of-a-flow), checked over the models'
export documents against a declared seam manifest (which model's `public` event/view feeds
which other model's reaction).

| Code | Severity | Rule | Fix |
|---|---|---|---|
| `system-manifest-invalid` | error | The manifest's shape is wrong — missing/unknown keys, unsupported `systemSchemaVersion`, a seam ref that isn't `<modelKey>:`-qualified or names an undeclared model, an unreadable/unparseable `source` | Fix the manifest; `source` must be a `.em` file or an `em export --json` document (schema ≥ 1.10) |
| `system-model-key-mismatch` | error | A `models:` key differs from that export's `model.key` | Rename the manifest entry to the computed key the message prints |
| `seam-endpoint-unresolved` | error | A seam's `from`/`to` doesn't resolve in the named model | Fix the ref (`em export` lists every ref), or re-declare the seam after a rename |
| `seam-source-not-public` | error | The `from` element exists but isn't a `public` event/view | Mark it `public` in its model, or point the seam at the element that is |
| `seam-consumer-not-reaction` | error | The `to` element isn't a `translation`/`automation`/`processor`/`saga` — or a bare slice ref holds zero or several | Point `to` at the reaction element (or a slice containing exactly one) |
| `seam-duplicate` | warning | The same resolved `(from, to)` pair is declared twice | Remove the repeat |
| `dangling-public-event` | warning | A `public` event/view no seam names as `from` — a published surface nobody consumes | Declare the seam that reads it, or drop `public` if nothing outside the model does |
| `unbound-translation` | warning | An externally fed reaction (no incoming edge inside its own model) that no seam names as `to` | Declare the seam whose `to` is this reaction, or give it an in-model `from` |
| `undeclared-seam-candidate` | warning | A `public` event/view in one model shares its name with a reaction or event in another, with no seam between them — the old name-matching heuristic, demoted to a lint | Declare the seam, or rename one side so the match stops looking like a link |

`em validate` itself deliberately stays quiet on both halves of a seam: a `public` event with no
reader in its own model, and a reaction with no `from`, are each a legitimate single-model shape
(the reader/producer is outside the model). `em system` is where the system-level claim is
checked.

## What the validator can't catch

Connection legality is checked on `arrow` statements, which is where an illegal connection
can be written down — it can't be checked on slice *shape*, because shape is what em reads to
infer arrows in the first place. A `translation` or `processor` sharing a slice with an `event`
but no `command` — a reaction wired straight to an event — is exactly what the "a reaction that
triggers no command" warning above catches: any reaction with no `command` in its own slice,
and no explicit arrow to one, is flagged. Still route every reaction through a real command by
construction (`reaction → command → event`, all in one slice) rather than an explicit
`arrow "Reaction" -> "Event"` — that shape is its own connection-legality error (a reaction
never records an event itself). The [patterns](patterns.md) doc covers why.

`em validate` is also single-model by design: a name reused across kinds *within* one file is
flagged ("ambiguous names", above), but the same term used inconsistently *across* files is
not — that's `em glossary`'s job, not the validator's (see [cli.md](cli.md#em-glossary-files)).
One specific cross-model case — two `.em` files sharing a directory whose slice keys collide,
so both would read/write the same `slices/<key>.md` doc (MIL-160) — isn't caught by `em
validate` either, but IS caught by `em status`/`em catalog` (the `cross-model-slice-doc-collision`
warning), the only two commands that ever compile more than one model in the same run; see
[cli.md, "Multi-model projects"](cli.md#multi-model-projects).
