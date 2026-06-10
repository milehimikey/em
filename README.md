# `em` — CLI Event Modeling with a strict Graphviz grid

A command-line tool for [Event Modeling](https://eventmodeling.org/) (Adam Dymitruk's
method). You write a model in a small **slice-first** text DSL (`.em`); `em` transpiles
it to **Graphviz DOT** and renders an image. Layout is a **rigid grid** — swimlane rows
and time-ordered slice columns are locked with Graphviz `rank=same` groups and weighted
invisible edges, so there are **no manual offsets and no alignment drift**.

```
                example: examples/order-fulfillment.em  ->  em render  ->  SVG/PNG
```

## Why DOT, not PlantUML

PlantUML's component diagrams cannot express `rank=same`, so a truly strict grid is
impossible there — you end up estimating pixel widths and nudging boxes by hand. `em`
generates DOT directly and uses the
[Graphviz grid technique](https://graphviz.org/Gallery/undirected/grid.html): a full
*rows × columns* matrix where every empty cell is an invisible placeholder, so columns
stay perfectly aligned regardless of how sparse the model is.

Graphviz lays out the grid and renders the boxes/labels, but it does **not** route the
arrows: a global spline mode can't give straight within-slice verticals *and* clean
cross-slice curves at once. Instead `em` reads each box's rectangle back out of the
rendered SVG and draws the arrows itself — straight, centred lines within a slice and
smooth curves into another slice — so routing is exact and never disturbs the grid.

## Install / run

Requires **Node ≥ 18** and **Graphviz** (`dot` on your `PATH`). Rendering to formats
other than SVG (PNG, PDF, …) also needs **librsvg** (`rsvg-convert` on your `PATH`) —
the arrows are drawn into the SVG, so raster/PDF output is converted from it. SVG output
needs only Graphviz.

```bash
npm install
npm run build          # produces dist/, exposes the `em` bin
# during development, run straight from source:
npx tsx src/cli.ts <command> ...
```

## Commands

```bash
em init [file]                 # scaffold a starter model (default: model.em)
em render <file> [-o out.svg]  # transpile + render (format from -o extension or -T)
em render <file> --emit-dot    # print the generated DOT instead of rendering
em render <file> --keep-empty-lanes   # don't collapse the API lane when empty
em watch <file> [-o out.svg]   # re-render on every save
em validate <file>             # check event-modeling rules (non-zero exit on errors)
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
model (a "todo list") or a timer/cron and *issue* a command when done. The automation slice
contains **only** the read model it reads and the processor/translation; the command it
triggers (and that command's event) is the **next** slice.

## DSL

```
model "Order Fulfillment"

persona Customer          # UI swimlanes (top band), one row each
persona Manager
context Order              # event swimlanes (bottom band), one row each
context Payment

slice "Browse Catalog" {           # each slice is one column (time, left -> right)
  ui Product Catalog @Customer     # @Persona places the screen in a persona row
  command Place Order
  event Order Placed @Order note "notes/order-placed.md"   # note "…" links docs
}

slice "View Open Orders" {
  view Open Orders from "Order Placed"   # from "<event>" wires the data flow
  ui Order List @Customer
}

slice "Payments To Process" {       # automation slice: read model + processor only
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

slice "Capture Payment" {           # next slice: the command the automation triggers + its event
  command Capture Payment
  event Payment Captured @Payment
}

arrow Receipts -> Receipt Screen    # optional explicit arrow (overrides inference)
```

### Element keywords → swimlane bands (top → bottom)

0. *(header)* — each slice name is rendered as a title cell in the top row
1. `automation` / `processor` / `saga` / `translation` — **Automation** band (only shown if used)
2. `ui` — **persona** rows (one per `persona`)
3. `command` + `view` — the **API** row (commands and read models share one lane — they
   form the system's API)
4. `event` — **context/concept** rows (one per `context`)

Commands and read models share the **API** row, so a single slice holds *either* a command
*or* a read model (a command slice vs a view slice). The empty API lane is dropped when a
model has neither; pass `--keep-empty-lanes` to keep it. A fixed-width title cell per slice
anchors uniform column widths; elements float in their columns and arrows route between them.

`@Persona` / `@Context` choose the row within a band (undeclared tags create a new row).
`view … from "Event"[, "Event2"]` declares which events feed a read model and draws the
data-flow arrow. Arrows between elements in a slice are inferred from the pattern; use
`arrow A -> B` for anything extra (e.g. a read model feeding a different screen).

### Notes

Any element can carry `note "path.md"` (valid on every keyword). The prose lives in the
markdown file — keeping the diagram uncluttered — and the box gets a small **numbered
folded-corner marker** in its top-right corner showing it has notes. A **legend** is
appended below the diagram mapping each number to its element and note file, so even in a
static export you can tell which note belongs to which box.

In **SVG** output the markers and legend rows are links: clicking one opens the markdown
file (paths resolve relative to the `.em` file, so keep the notes directory beside the
diagram). Raster output (PNG/PDF) can't carry links — that's what the footnote numbers and
legend are for. `em render`/`em watch` warn (without failing) if a note file can't be found.

## Validation rules (`em validate`)

- two same-band elements in one slice (collision) → **error** (split into separate slices;
  e.g. a command and a read model both land in the API row)
- a read model whose `from "Event"` doesn't exist → **error**
- an automation/translation whose `from "<read model>"` doesn't exist → **error**
- an `arrow` endpoint that matches no element → **error**
- an automation/translation slice that also holds the command it triggers → **warning**
  (move the command to the next slice)
- a command that records no event → **warning**
- a read model with no source event → **warning**
- a name defined more than once and referenced → **warning** (resolves to first)

## Project layout

```
src/
  parser/   lexer.ts, parser.ts, ast.ts        # .em -> AST
  model/    model.ts, edges.ts, validate.ts    # normalized model, semantic edges, rule checks
  layout/   grid.ts                            # bands -> rows, slices -> cols, R×C matrix
  emit/     dot.ts, theme.ts                   # grid-only DOT + EM colours
  render/   render.ts, svgGeometry.ts,         # run dot -> read box rects -> draw arrows
            drawEdges.ts, drawNotes.ts,        #   + note markers -> inject SVG;
            watch.ts                           #   rsvg-convert; chokidar watcher
  pipeline.ts                                  # source -> { model, grid, diagnostics, dot }
  cli.ts                                        # init | render | watch | validate
examples/   order-fulfillment.em               # the canonical walkthrough (+ a linked note)
            notes/order-placed.md              # markdown a note marker links to
            ecommerce-fulfillment.em           # wide: all 4 patterns, 4 personas, 4 contexts
            insurance-claim.em                 # mid: all 4 patterns, 3 personas, 3 contexts
test/       parser / layout / emit / edges / svgGeometry / drawNotes + validation tests (vitest)
```
