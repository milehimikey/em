# em — AI friendly event modeling

`em` is a command-line tool for [Event Modeling](https://eventmodeling.org/). You write a
model in a small, **plain-text, slice-first DSL** (`.em`) and `em` renders it to a clean,
deterministic diagram (SVG by default, PNG on request). Because the source is just text —
diff-able, reviewable, and unambiguous — it's as easy for an LLM to generate and edit as it
is for a person to write by hand. Layout is a **strict grid**: swimlane rows and
time-ordered slice columns stay perfectly aligned with no manual offsets.

```
examples/order-fulfillment.em  ->  em render  ->  order-fulfillment.svg
```

Rendering is **self-contained** — Graphviz runs as bundled WebAssembly and PNG is
rasterized in-process, so there's nothing to `apt`/`brew` install for SVG or PNG output.

## Install

```bash
npm install -g @milehimikey/em     # then `em` is on your PATH
```

Requires **Node ≥ 18**. SVG and PNG need no other tools. PDF (and other Graphviz raster
formats) are optional and use a system `rsvg-convert` (librsvg) if one is installed.

Run without installing:

```bash
npx @milehimikey/em init model.em
npx @milehimikey/em render model.em
```

## Quickstart

```bash
em init model.em          # scaffold a starter model
em render model.em        # -> model.svg  (open it in a browser)
em watch model.em         # re-render on every save
em validate model.em      # check event-modeling rules
```

A `.em` model is a list of **slices** (vertical time steps), each holding elements that fall
into swimlane rows:

```
model "Order Fulfillment"

persona Customer           # UI swimlanes (top), one row per persona
context Order              # event swimlanes (bottom), one row per context
context Payment

slice "Browse Catalog" {           # each slice is one column (time, left -> right)
  ui Product Catalog @Customer     # @Persona places the screen in a persona row
  command Place Order {            # a `{ … }` block declares the element's fields
    customerId
    total: Money                   # optional `: Type` annotation
  }
  event Order Placed @Order note "notes/order-placed.md" {   # note "…" links docs
    orderId
    total: Money
  }
}

slice "View Open Orders" {
  view Open Orders from "Order Placed"   # from "<event>" wires the data flow
  ui Order List @Customer
}
```

## The four patterns

Event Modeling is built from four patterns, all expressible as slices:

| Pattern | Flow | DSL elements |
|---|---|---|
| **Input** (state change) | UI → command → event | `ui`, `command`, `event` |
| **Output** (state view) | event → read model → UI | `event`, `view from "…"`, `ui` |
| **Automation** | read model (todo) → processor → command → event | `view from "…"` + `processor`, then `command` + `event` |
| **Translation** | external read model → translation → command → event | `view from "…"` + `translation`, then `command` + `event` |

Automation/translation slices are **not** triggered by a command — they react to a read
model (a "todo list") or a timer and *issue* a command when done. The automation slice
contains **only** the read model it reads and the processor/translation; the command it
triggers (and that command's event) is the **next** slice.

## DSL reference

### Element keywords → swimlane bands (top → bottom)

0. *(header)* — each slice name is rendered as a title cell in the top row
1. `automation` / `processor` / `saga` / `translation` — **Automation** band (only shown if used)
2. `ui` — **persona** rows (one per `persona`)
3. `command` + `view` — the **API** row (commands and read models share one lane)
4. `event` — **context/concept** rows (one per `context`)

Commands and read models share the **API** row, so a slice holds *either* a command *or* a
read model. The empty API lane is dropped when a model has neither; pass `--keep-empty-lanes`
to keep it.

`@Persona` / `@Context` choose the row within a band (undeclared tags create a new row).
`view <Name> again [from "Event", …]` declares a LATER INSTANCE of an already-declared read
model — the Event Modeling device for keeping the timeline forward-only as a view evolves.
Instances are one logical view: the first declaration owns the `note` doc; each instance lists
the events that reach it there; instances are linked left-to-right with a continuity arrow, and
reactions (`processor … from "View"`) read the nearest instance at-or-before their slice.

`view … from "Event"[, "Event2"]` declares which events feed a read model and draws the
data-flow arrow. Arrows within a slice are inferred from the pattern; use `arrow A -> B` for
anything extra (e.g. a read model feeding a different screen).

### Fields

Any element can declare **data fields** in a `{ … }` block — the data it accepts (command),
records (event), projects (read model), or shows (UI). Each field is `name` with an optional
`: Type`; write one per line, or inline and comma-separated:

```
command Place Order {            # one per line
  customerId
  items: List<LineItem>
  total: Money
}

event Payment Requested @Payment { orderId, amount: Money }   # inline
```

Fields render **in the box**, UML-style: the name, a divider rule, then the fields. The box
grows to fit them (width stays fixed, so columns stay aligned), and arrows still anchor to
the box edges so the lines stay stable. A field block coexists with `note`/`from` clauses on
the same element. Fields are the foundation of the later event-modeling phases (the slicing /
information-completeness process); field-level validation across slices is planned.

### Notes

Any element can carry `note "path.md"` (valid on every keyword). The prose lives in the
markdown file — keeping the diagram uncluttered — and the box gets a small **numbered
folded-corner marker** in its top-right corner. A **legend** is appended below the diagram
mapping each number to its element and note file, so even a static export tells you which
note belongs to which box.

In **SVG** output the markers and legend rows are links; clicking one opens the markdown
file. Links resolve relative to the **output SVG's location**, so they keep working whether
the SVG is rendered beside the model or into another folder (as long as the notes travel
with it). Open the SVG in a **web browser** to use the links — image viewers like macOS
Preview/Quick Look show the markers but ignore SVG hyperlinks. Raster output (PNG/PDF) can't
carry links — that's what the footnote numbers + legend are for.

## Commands

```bash
em init [file]                        # scaffold a starter model (default: model.em)
em render <file> [-o out.svg]         # render (format from -o extension or -T)
em render <file> -o out.png           # PNG (in-process, no system deps)
em render <file> --emit-dot           # print the generated DOT instead of rendering
em render <file> --keep-empty-lanes   # don't collapse the API lane when empty
em watch <file> [-o out.svg]          # re-render on every save
em validate <file>                    # check event-modeling rules (non-zero exit on errors)
```

## Validation rules (`em validate`)

- two same-band elements in one slice (collision) → **error** (split into separate slices)
- a read model whose `from "Event"` doesn't exist → **error**
- **time flows left to right** (the Two Laws): an event feeding an EARLIER view instance,
  a reaction reading a view that only exists later, or an explicit backward `arrow` → **error**
  (fix: add `view X again` at the point on the timeline where the event lands)
- `again` on a view with no earlier declaration → **error**; `again` on non-views → parse error
- multi-event slices always render as a FAN from the command (never event→event); fanned
  arrows route around the column gutter so they cannot read as a chain
- an automation/translation whose `from "<read model>"` doesn't exist → **error**
- an `arrow` endpoint that matches no element → **error**
- an automation/translation slice that also holds the command it triggers → **warning**
- a command that records no event → **warning**
- a read model with no source event → **warning**
- a name defined more than once and referenced → **warning** (resolves to first)

## Documentation

- [docs/timeline-model.md](docs/timeline-model.md) — the Two Laws of the Timeline (forward-only
  validation, `view … again`)
- [docs/why-dot-not-plantuml.md](docs/why-dot-not-plantuml.md) — why DOT + the strict-grid /
  self-drawn-edges architecture
- [docs/features.md](docs/features.md) — full feature list and roadmap
- [docs/dependencies.md](docs/dependencies.md) — how rendering works with no system deps

## Development

```bash
npm install
npm run build          # produces dist/, exposes the `em` bin
npm test               # vitest
npx tsx src/cli.ts <command> ...   # run straight from source
```

## AI Assistant (Claude Code)

`em` ships a **Claude Code skill** that guides you and your team through Event Modeling using the 7-step process and 4 design patterns, producing implementation-ready slice specifications. The AI drives the model — asking focused questions, never guessing domain facts — while `em validate` keeps the diagram honest.

**Install the skill into your project:**

```bash
em skill install          # copies the skill into .claude/skills/event-modeling/
em skill install --force  # overwrite an existing installation
```

Then, in Claude Code, run:

```
/event-modeling           # start (or resume) a guided session
/event-modeling discover  # steps 1–4: brainstorm events, timeline, commands, read models
/event-modeling model     # steps 5–7: swimlanes, patterns, completeness check
/event-modeling slice     # deep implementation specs, one per slice
/event-modeling watch     # open a live browser view for team modeling sessions
/event-modeling validate  # run em validate and resolve all diagnostics
```

Sessions are **resumable** — the skill checkpoints progress in `.event-modeling.md` so you can continue across conversations.

For a complete worked example (a headless CPQ system with ~50 slices), see the [em-with-ai repository](https://github.com/milehimikey/em-with-ai).

## License

[MIT](LICENSE) © milehimikey
