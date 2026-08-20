<!-- DSL behavior change? Update BOTH docs/dsl.md and .claude/skills/event-modeling/reference/em-dsl.md -->

# DSL reference

A `.em` file is a model title, a set of row declarations, and a list of slices. Each slice
is one vertical time step on the diagram; the elements inside it land in swimlane rows.

```
model "Name"                     # diagram title

persona Name                     # a UI swimlane row (one per actor)
context Name                     # an event swimlane row (one per bounded context)

slice "Name" [source "url"] {    # one column; time runs left -> right; source is optional
  ui   Free Text @Persona        # screen; @Persona picks its row
  command Free Text              # state-changing request
  view Free Text from "Event A", "Event B"    # read model fed by event(s)
  event Free Text @Context       # recorded fact; @Context picks its row
  event Free Text @Context public   # marks it part of the public integration surface
  processor Free Text from "View"             # automation reacting to a read model
}

arrow From Element -> To Element    # explicit extra edge
```

Comments are `#` to end of line, anywhere outside quotes.

### Quoted strings

Everything between a `"` and its matching `"` is literal content — `{`, `}`, and `#`
included — never re-interpreted as a field block or a comment. That makes REST
path-template placeholders safe to write exactly as OpenAPI/READMEs do:

```
command Suspend Widget issue "PUT v3/widgets/{widgetId}/suspend"
```

To put a literal `"` or `\` inside a quoted string, escape it: `\"` and `\\`. No other
backslash sequence is special, so ordinary backslashes (e.g. in a Windows-style path)
pass through untouched:

```
event Order Placed issue "does \"pending\" include cancelled orders?"
note "C:\paths\work.md"    # not an escape sequence — \p and \w aren't recognized
```

A string left unterminated by end of line (a missing closing `"`) is a parse error
naming the clause it broke in, not a downstream "unrecognized trailing text" error.

## Element keywords

There are 8 keywords and nothing else. Four of the automation spellings are aliases for the
same element kind.

| Keyword | Band | Meaning | Tag | Clauses |
|---|---|---|---|---|
| `ui` | persona rows | screen / interface | `@Persona` | `note`, `issue`, `divergence`, `{ fields }` |
| `command` | API | state-changing request (imperative name) | — | `note`, `issue`, `divergence`, `{ fields }` |
| `view` | API | read model / projection | — | `from`, `again`, `public`, `note`, `issue`, `divergence`, `{ fields }` |
| `event` | context rows | recorded fact (past-tense name) | `@Context` | `note`, `issue`, `divergence`, `public`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / boundary adapter | — | `from`, `note`, `issue`, `divergence`, `{ fields }` |

### Swimlane bands, top to bottom

1. Header row — each slice name renders as a title cell.
2. Automation band — only present if the model uses a reaction keyword.
3. Persona rows — one per `persona`, in declared order.
4. API row — commands and read models share this single lane, so a slice holds either a
   command or a read model, not both. When a model has neither, the empty lane is dropped;
   pass `--keep-empty-lanes` to keep it.
5. Context rows — one per `context`, in declared order.

`@Persona` is valid only on `ui`; `@Context` only on `event`. An undeclared tag creates a
new row on first use. An untagged `ui` defaults to the first persona (or "User"); an
untagged `event` defaults to a "Domain" context. Multi-word tags need no quoting — the tag
captures everything after `@` to the end of the line (`ui Ticket Queue @Customer Service`
matches `persona Customer Service`), since every other trailing clause is stripped before
the tag is read.

## Wiring data flow

Arrows within a slice are inferred from the pattern (see [patterns.md](patterns.md)), so
most models never write an explicit arrow. Three clauses control cross-slice flow:

### `from`

`view X from "Event A", "Event B"` declares which events feed a read model and draws the
data-flow arrows. On a reaction (`processor`/`automation`/`saga`/`translation`),
`from "View"` names the read model it watches. Names are quoted and comma-separated;
matching is case-insensitive and whitespace-normalized. A `from` may only point backward or
sideways in time — sourcing an event or view that first appears in a later slice is a
validation error (see [timeline.md](timeline.md)).

The two directions never cross: a view's `from` resolves only to **events**, and a
reaction's `from` resolves only to **read models**. Naming an event on a reaction is a
validation error even when the event exists — reactions don't watch the event stream
directly. To feed an event into a reaction, project it into a view first
(`view Payments To Process from "Payment Requested"`) and point the reaction at that view:
the view is the automation's to-do list, and it lives in the slice *before* the reaction's own
— the reaction shares its slice with the command it triggers instead (see the Automation
pattern in [patterns.md](patterns.md)).

### `view … again`

`view <Name> again [from "Event", …]` declares a later instance of an already-declared read
model. This is the Event Modeling device for a view that keeps evolving as the timeline
advances: instead of pointing a late event backward at an early view (forbidden), the view
reappears where the event lands.

Instances are one logical view. The first declaration owns the `note` doc; each later
instance lists only the new events that reach it at that point; and a reaction reading the
view connects to the nearest instance at or before its own slice. `again` on a name with no
earlier declaration is a validation error, and `again` on anything but a `view` is a parse
error.

Instances are never connected to one another — continuity is implied by the shared name, and
the events reaching each instance are what show the view changing over time. See
[timeline.md](timeline.md).

A `ui` only ever wires to a `command` (the State Change pattern) — no pattern has a `ui`
triggering a `processor`/`automation`/`saga`/`translation`; reactions are triggered by reading a
read model, or by an external input, never by a person on a screen. A `ui` sharing a reaction's
slice renders with no outgoing edge at all — a floating box — whether or not that slice also
has the reaction's own command; the `ui`/command pairing that would normally wire it is
suppressed there, since a `ui` and a reaction never legitimately share one trigger. And
[`em validate` warns](validation.md#warnings) on it.

### `arrow`

`arrow A -> B` draws an explicit edge for anything the patterns don't infer, such as a read
model feeding a second screen. Both endpoints must match an element name, and the arrow must
point forward in time.

An arrow is the one place an illegal connection can be written down, so the kinds it joins
are checked against the four patterns: `ui → command`, `command → event`,
`event → read model`, `read model → ui`, `read model → reaction`, `reaction → command`.
Anything else — a command straight to a read model, an event straight to a command — is a
[validation error](validation.md#connection-legality).

## Fields

Any element can declare data fields in a `{ … }` block: the data a command accepts, an event
records, a read model projects, or a UI shows. Each field is a `name` with an optional
`: Type`. Types are free text with no semantic checking. Write fields one per line or inline,
comma-separated:

```
command Place Order {            # one per line
  customerId
  items: List<LineItem>
  total: Money
}

event Payment Requested @Payment { orderId, amount: Money }   # inline
```

Fields render inside the box, UML-style: the name, a divider rule, then the field rows. The
box grows vertically to fit (width stays fixed, so columns stay aligned) and arrows re-anchor
to the real box edges. A field block coexists with `note` and `from` clauses on the same
element.

Once two connected elements both declare fields, `em validate` traces them — a view field
with no matching source-event field, or an event field no same-slice command provides, gets
a warning. See [validation.md](validation.md).

## Event tags

**Events only.** A `tag` declares a DCB (Dynamic Consistency Boundary) tag key on an event —
metadata a consistency-boundary-aware event store (Axon Framework's `@EventTag`, etc.) uses to
decide which events belong to one consistency check. Writing `tag` on a command, view, `ui`, or
`type` field — or an element-level `tag` clause on a non-event element — is a parse error.

There are three forms:

```
event Selling Price Designated {
  priceId: UUID tag                          # identity: inline field clause
  productId: UUID
  currency: string
}
tag productCurrency from productId, currency  # composite: element-level, standalone line
tag productRuleTriple external "hash of kind+source+target, order-independent"  # external
```

- **Identity** — a trailing `tag` keyword on a field line inside the event's `{ … }` block
  (`priceId: UUID tag`, or on a typeless field, `priceId tag`) marks that field itself as a tag
  key; the key defaults to the field's own name. A field whose entire text is just `tag` (no
  type, nothing before it) is a field literally NAMED `tag`, not a clause — the keyword only
  counts as a clause when something trails behind it.
- **Composite** — `tag <key> from <field1>, <field2>, ...` declares a new tag key formed from
  ≥2 of the event's own fields, named bare (unquoted, unlike a view's `from "Event"`).
- **External** — `tag <key> external "text"` declares a tag key that's computed some other way;
  the string is documentation only, describing the intended computation, and is never parsed.

An event may carry any combination — an inline identity tag plus one or more composite/external
clauses — and multiple element-level `tag` clauses accumulate.

Element-level `tag` clauses (composite/external) can be written two ways: as a trailing clause
on the event (its header line, after an inline `{ … }` block, or on a multi-line block's closing
`}` line — same family as `note`/`issue`), or as one or more **standalone `tag ...` lines**
immediately following the event inside the slice body (the form shown above) — the latter
attaches to the most recently declared element in the slice, which must be an event.

`em export` carries every tag key forward under each event's `tags` array — see
[cli.md](cli.md). `em validate` catches a composite tag naming a field the event doesn't
declare, and a duplicate tag key on one event (inline identity and element-level keys share one
namespace) — see [validation.md](validation.md).

## Renames

**Event and command only.** A `renamed from "Old1", "Old2"` clause records the prior name(s) an
element, or one of its fields, was known as — metadata a codegen tool uses to convert
already-stored payloads written under the old name(s) to the current shape, without an
upcaster chain. Writing it on a `ui`, `view`, an automation kind, or a `type` field is a parse
error, the same posture as `tag`.

```
event PaymentRecorded renamed from "PaymentRegistered" @Payment {
  paymentId: UUID
  amountCents: long renamed from "amount"          # a field renamed too
}

command PlaceOrder renamed from "SubmitOrder"
```

- **Element-level** — `renamed from "Old1", "Old2"` trails the element's own name (its header
  line, or wherever another trailing clause like `@Context`/`public` may go): the element
  itself was renamed one or more times. Valid on `event` and `command` only — the two kinds
  with a wire/API identity a consumer decodes against.
- **Field-level** — `renamed from "Old1", "Old2"` trails a single field spec, after its type
  (`amountCents: long renamed from "amount"`) or after the bare name of a typeless field
  (`total renamed from "amount"`). Valid only on fields of an `event` or `command` — a parse
  error inside a `view`/`ui`/automation-kind field block or a `type` declaration.
- The list is quoted and comma-separated, most-recent-old-name first when a name changed more
  than once, the same convention as a view's `from "A", "B"` list.
- **Inline lists and field ambiguity.** Inside one `{ … }` field block written inline, a bare
  quoted field name immediately after a `renamed from` field is read as a CONTINUATION of that
  list, not a new field — `{ a: X renamed from "A", "B", c: Y }` is two fields (`a`, renamed
  from both `"A"` and `"B"`, then `c`), not three. To declare an actual field with a quoted
  name right after a renamed field, either give it a type (`"B": Type` — a bare quoted string
  is only read as a continuation) or write the fields one per line in a multi-line block, which
  has no such ambiguity at all.

`em export` carries every renamed-from list forward as `renamedFrom: string[] | null` — on
each element and on each field — see [cli.md](cli.md). **`em diff` does not read this clause at
all**: a rename is still reported as a removal plus an addition, same as before this clause
existed. `renamed from` is codegen/export metadata for payload conversion, not diff input —
diff's no-inference philosophy is unchanged; a consumer that wants "this old name became this
new name" reads it from the export, not from a diff run.

## Named types

A top-level `type Name { field: Type, ... }` declaration names a reusable structured shape —
the one exception to "types are free text with no semantic checking" above. Declare it once,
then reference it from any field anywhere in the model, bare for a single nested object or
`Name[]` for an array of it:

```
type QuoteAcceptedLine {
  lineId: UUID
  productId: UUID
  quantity: int
  unitPrice: Money
  discountIds: UUID[]
}

slice "Accept Quote" {
  command Accept Quote
  event Quote Accepted {
    quoteId: UUID
    lines: QuoteAcceptedLine[]
  }
}
```

`type` declarations take no clauses in v1 — just a name and a `{ fields }` block — and may
appear anywhere at the top level, in any order relative to `persona`/`context`/`slice`.

**Resolution is opportunistic, not a closed world.** A field's type string resolves to a
structured reference only when it names a declared type (bare or `[]`-suffixed), matched
case- and whitespace-insensitively the same way element names are. Every other type string —
`Money`, `UUID`, `List<LineItem>`, anything undeclared — stays exactly as free-text and
unchecked as it always has been. There's no primitive whitelist and no "unknown type" error:
a model that declares no `type` blocks sees zero behavior change.

**Recursion is allowed as a DAG; a bare cycle is rejected.** A declared type may reference
another declared type, including transitively (`Order` referencing `Address` twice is a
legitimate diamond, not a problem). But a type nesting itself with no array to terminate it —
`type Node { child: Node }` — can never be satisfied and is a validation error. The same shape
through an array, `type Node { children: Node[] }`, is legal: the array can terminate at
runtime (empty array), which is exactly how tree-shaped data (categories, org charts, comment
threads, bills of materials) gets expressed. See [validation.md](validation.md).

`em export` carries every declared type under `model.types[]`, each with its own stable `ref`
(`types/<slug>`), and adds an additive `typeRef` key to every field — on both a declared
type's own fields and ordinary element fields — resolving to `{ name, ref, array }` when the
field's type names a declared type, `null` otherwise. `em diff` tracks types being
added/removed and their fields changing, the same shape as element field changes. See
[cli.md](cli.md).

## Notes

Any element can carry `note "path.md"`. The prose lives in the markdown file, keeping the
diagram uncluttered; the box gets a small numbered folded-corner marker in its top-right
corner, and a legend below the diagram maps each number to its element and note file. Paths
are relative to the `.em` file.

In SVG output the markers and legend rows are hyperlinks that open the markdown file. Links
resolve relative to the output SVG's location, so they keep working when the SVG is rendered
into another folder, as long as the notes travel with it. Open the SVG in a web browser to
use them; image viewers like macOS Preview show the markers but ignore SVG hyperlinks.
Raster output (PNG/PDF) can't carry links, which is what the numbered legend is for.

## Issues

Any element can carry `issue "text"` — a short, inline open question, the diagram-visible
equivalent of a red sticky note in a physical Event Modeling session. Unlike `note`, there's
no separate file: write the question directly in the DSL. The box gets a small numbered
folded-corner marker in its top-left corner, red instead of the note marker's amber, with a
tooltip carrying the full text; the legend below the diagram lists every open issue in its own
"Issues" section. An element can carry both `note` and `issue` at once — the two markers sit on
opposite top corners, so they never overlap.

Use `note` for durable documentation you want linked from the diagram; use `issue` for a
question that's still open. `em validate` emits a warning for every element with an open issue
(see [validation.md](validation.md)), and `em validate --list-issues` lists just those, which is
useful for a quick open-questions sweep or a CI check (`--fail-on-issues`, opt-in — see
[cli.md](cli.md)).

## Accepted divergence

Any element can also carry `divergence "text"` — a reasoned, ratified deviation between this
element and its implementation, recorded on the model instead of only in prose. It's the
*resolved* sibling of `issue`: where `issue` flags a question still open, `divergence` records
one that's already been answered and accepted (lint-suppression-with-rationale for the
conformance loop — see [ai-workflow.md](ai-workflow.md) for the `conform` phase). The box gets
a small numbered folded-corner marker in its bottom-right corner, teal instead of `issue`'s red
or `note`'s amber, with a tooltip carrying the full text; the legend below the diagram lists
every accepted divergence in its own "Accepted Divergences" section. An element can carry a
note, an issue, and a divergence all at once — the markers occupy three different corners, so
none of them overlap.

Unlike `issue`, `divergence` raises **no** warning from `em validate` — recording it is the
point of not having it re-reported as drift on every run (see
[validation.md](validation.md)). `em validate --list-divergences` lists every accepted
divergence for auditing (slice, element, line, text); there's no `--fail-on` counterpart since
an accepted divergence should never block a build. `em diff --json` also carries the
annotation forward: a structural change or removal involving an annotated element's
`acceptedDivergence` field is non-null, citing the reason rather than hiding the finding — see
[cli.md](cli.md).

## Slice provenance

A slice can carry `source "url"` on its header line, before or after the quoted name:

```
slice "Checkout" source "https://linear.app/team/issue/MIL-60" {
  ui   Checkout Page @Customer
  command Submit Order
  event Order Submitted
}
```

This is the only slice-level clause — everything above (`note`, `issue`, `divergence`, `from`,
`{ fields }`, `@Tag`, `again`) is per-element. `source` links a slice back to the ticket or
conversation it traces to, so an intake loop (requirement → model → slice → spec → PR) stays
machine-traversable through `em export` (`model.slices[].source`) instead of relying on prose
in slice docs. It's purely metadata: no visual marker, no legend entry, and `em validate`
doesn't require or check it. Optional — omit it and the field exports as `null`.

Don't confuse this with an element's `note "path.md"`, which links a markdown file, not a URL.

## Integration surface

An `event` or `view` can carry a `public` clause, marking it as part of the model's published
integration surface — for an event, a recorded fact meant for consumers (AsyncAPI contract
style); for a view, a published read API or webhook response shape another service consumes —
as opposed to internal-only facts and read models local to this context.
It carries no free text and no diagram marker (unlike `note`/`issue`): it's a plain structural
flag, the same posture as `again`, not an annotation.

```
event Order Placed public @Order          # event public before the tag
event Order Placed @Order public          # event public after the tag — also valid
event Internal Retry Scheduled @Order      # no `public` — internal-only fact

view Order Summary public                 # view public (no consumers in this model)
view Order History public from "Order Placed"  # public before from — required order
view Public Orders public again           # both public and again allowed
```

`public` is valid on `event` or `view` only; writing it on other element kinds is a parse
error. For an event, it's written flexibly: before or after any trailing `@Context` tag, or
as the line's final token. For a view, `public` must come before `from` (writing `public`
after a quoted list causes it to be swallowed into the tail and mangled — use
`view Name public from "Event"`, not `view Name from "Event" public`). With `again`, both
orders work: `view Name public again` and `view Name again public` are equivalent. Written
anywhere else on the line, a bare `public` isn't recognized as the clause and folds into the
free-text name instead, the same as any other unrecognized trailing word.

`em export` carries the flag forward as `public: true`/`false` on every event and view — the
field a downstream contract generator (e.g. an AsyncAPI generator) filters on to promote only
the events and views actually meant for consumers, instead of every fact and read model by
default. `em diff` tracks a flagged element flipping public↔private as its own change
(`event marked public` / `view marked public` / etc.), so a promotion or demotion to the
integration surface is a visible, diffable event. `em validate` exempts public elements from
warnings about unread events and unconsumed views, since their readers/consumers exist outside
this model (see [validation.md](validation.md)). See [cli.md](cli.md) for both.

## Colors

For orientation when reading a render: UI boxes are white, commands blue, events
amber/orange, read models green, automations gray.
