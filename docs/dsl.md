<!-- DSL behavior change? Update BOTH docs/dsl.md and .claude/skills/event-modeling/reference/em-dsl.md -->

# DSL reference

A `.em` file is a model title, a set of row declarations, and a list of slices. Each slice
is one vertical time step on the diagram; the elements inside it land in swimlane rows.

```
model "Name"                     # diagram title

persona Name                     # a UI swimlane row (one per actor)
context Name                     # an event swimlane row (one per bounded context)

slice "Name" {                   # one column; time runs left -> right
  ui   Free Text @Persona        # screen; @Persona picks its row
  command Free Text              # state-changing request
  view Free Text from "Event A", "Event B"    # read model fed by event(s)
  event Free Text @Context       # recorded fact; @Context picks its row
  processor Free Text from "View"             # automation reacting to a read model
}

arrow From Element -> To Element    # explicit extra edge
```

Comments are `#` to end of line, anywhere outside quotes.

## Element keywords

There are 8 keywords and nothing else. Four of the automation spellings are aliases for the
same element kind.

| Keyword | Band | Meaning | Tag | Clauses |
|---|---|---|---|---|
| `ui` | persona rows | screen / interface | `@Persona` | `note`, `{ fields }` |
| `command` | API | state-changing request (imperative name) | — | `note`, `{ fields }` |
| `view` | API | read model / projection | — | `from`, `again`, `note`, `{ fields }` |
| `event` | context rows | recorded fact (past-tense name) | `@Context` | `note`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / boundary adapter | — | `from`, `note`, `{ fields }` |

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
untagged `event` defaults to a "Domain" context.

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

### `view … again`

`view <Name> again [from "Event", …]` declares a later instance of an already-declared read
model. This is the Event Modeling device for a view that keeps evolving as the timeline
advances: instead of pointing a late event backward at an early view (forbidden), the view
reappears where the event lands.

Instances are one logical view. The first declaration owns the `note` doc; each later
instance lists only the new events that reach it at that point; instances are linked left to
right with a continuity arrow; and a reaction reading the view connects to the nearest
instance at or before its own slice. `again` on a name with no earlier declaration is a
validation error, and `again` on anything but a `view` is a parse error.

### `arrow`

`arrow A -> B` draws an explicit edge for anything the patterns don't infer, such as a read
model feeding a second screen. Both endpoints must match an element name, and the arrow must
point forward in time.

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

## Colors

For orientation when reading a render: UI boxes are white, commands blue, events
amber/orange, read models green, automations gray.
