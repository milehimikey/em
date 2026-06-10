# Outstanding items before publication

Tracking list of things to resolve before promoting `em` for wider use. None of
these block the current edge-rendering work (PR #1); they are readiness items.

Status legend: 🔴 not started · 🟡 in progress · 🟢 decided/done

---

## 1. Output format + self-contained rendering 🟢 (done)

Default is **SVG** (`em render` with no format → `.svg`). Rendering is now
**self-contained**: Graphviz runs as bundled WebAssembly (`@hpcc-js/wasm-graphviz`)
and PNG is rasterized in-process (`@resvg/resvg-js`) — no system `dot`/`librsvg`
for SVG or PNG. PDF/other formats use an optional system `rsvg-convert` if present,
otherwise a clear error points to `librsvg` (see `docs/dependencies.md`). README
leads with `npm install -g @milehimikey/em`.

## 2. Multi-word persona / context tags 🔴

`@Persona` / `@Context` tags must be a single token: `@CustomerService` works,
`@Customer Service` does not (the parser captures one word, see
`src/parser/parser.ts` `tagMatch = /(?:^|\s)@(\S+)\s*$/`). Large teams will want
swimlanes like "Customer Service" or "Claims Ops".

**Proposed:** support quoted tags, e.g. `ui Inbox @"Customer Service"`, and match
them to `persona "Customer Service"`. Update parser + a couple of tests.

## 2b. Element notes 🟢 (shipped)

Any element can carry `note "path.md"`; the box shows a numbered folded-corner
marker and a legend is appended below the diagram mapping number → element → note
file (so raster exports, which can't carry links, are still self-describing). In
SVG the markers and legend rows link to the markdown. See README → DSL → Notes.
Parser (`note` clause), `Element.note`, and `src/render/drawNotes.ts` (marker +
legend injected into the SVG). `em render`/`watch` warn on a missing note file
without failing. Note links are rewritten relative to the output SVG's location
(see `noteHref` in `render.ts`), so they survive rendering into a separate folder
as long as the notes travel with the SVG. Caveats: neither PNG nor our PDF path
(librsvg) preserves links — SVG only; and image viewers (macOS Preview/Quick
Look) ignore SVG hyperlinks, so links only work in a browser.

## 2c. Element fields 🟢 (shipped — rendering) / 🔴 (validation: next)

Structured data attributes on elements — critical to the later event-modeling
phases (information completeness / slicing).

Shipped:
- **Syntax:** `{ … }` block on the element, one field per line or inline
  comma-separated; each field is `name` with optional `: Type`. Parser tracks a
  second brace level (`currentElement`). Coexists with `note`/`from` clauses.
- **Model:** `fields?: Field[]` (`{ name, type? }`) on `ElementNode`/`Element`.
- **Display:** rendered **in the box**, UML-style (title, `<HR/>` divider, field
  rows) via a Graphviz HTML-table label. Boxes auto-grow in height (width fixed,
  so columns stay aligned); arrows still anchor to box edges so lines stay stable.
  Row alignment is Graphviz-default **center** (tops drift slightly when field
  counts differ a lot within a lane — acceptable; could switch to uniform-per-lane
  height later if needed).

Next (separate PR): **information-completeness validation** — every field shown
by a read model / UI should trace to a field on a source event, and every event
field to a field on the command that produced it. Warn on gaps.

## 3. Fixed-size cells clip long labels 🔴

Element cells are a fixed 2.0in × 0.62in (`CELL_W`/`CELL_H` in
`src/emit/dot.ts`). Long names wrap (`wrapLabel`, ~18 chars/line) but the box
height is fixed, so a 3+ line label overflows/clips.

**Options:** auto-grow row height to the tallest label, shrink font for long
labels, or enforce a max name length with a validation warning. Auto-height is
the most robust but interacts with the rigid-grid row locking — needs care.

## 4. End-to-end render test 🟢 (done)

`test/render.e2e.test.ts` renders `examples/order-fulfillment.em` through the full
pipeline (WASM Graphviz + overlays + resvg) and asserts the edge group, note
markers, legend, working note link, and field text are present and the SVG is
well-formed; plus a PNG smoke test (valid PNG magic bytes). No system deps needed,
so it runs everywhere.

## 5. Build / packaging 🟢 (done)

`npm run build` produces a working `dist/` and `node dist/cli.js render …` renders
SVG + PNG with `dot`/`rsvg-convert` shadowed off PATH. `package.json` is publish-
ready (`@milehimikey/em`, `files`, `publishConfig`, `prepublishOnly`); release
steps are in `docs/publishing.md` (not yet executed).

## 6. Cross-slice curve aesthetics (low priority) 🟡

Long cross-slice curves (8+ columns) render as smooth, shallow arcs through the
channel and currently pass the no-box-intersection check on all examples. If a
denser model ever produces a curve that grazes a box, `drawEdges.ts` can route
long spans through an explicit mid-channel waypoint (two joined cubics). Revisit
only if a real model needs it.
