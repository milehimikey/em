# Outstanding items before publication

Tracking list of things to resolve before promoting `em` for wider use. None of
these block the current edge-rendering work (PR #1); they are readiness items.

Status legend: 🔴 not started · 🟡 in progress · 🟢 decided/done

---

## 1. Output format: SVG by default, PNG opt-in 🟢 (decided)

Arrows are drawn into the SVG by the renderer, so non-SVG output (PNG, PDF, …)
is produced by converting the SVG with **`rsvg-convert`** (librsvg). SVG output
needs only Graphviz.

**Decision:** default to **SVG** (already the case — `em render` with no format
produces `.svg`); PNG/PDF remain available for those who want them via
`-o file.png` / `-T png`. SVG is the better default anyway (scalable, smaller,
embeds in docs/wikis, diff-able-ish).

**Remaining:**
- Onboarding/docs should lead with SVG and present PNG as "if you need a raster,
  install librsvg". (README install note added.)
- Consider a friendlier message when `rsvg-convert` is missing and a non-SVG
  format is requested (currently throws a clear error — verify the wording
  points users to `brew install librsvg` / distro equivalent).
- Future option: bundle a pure-JS rasterizer (e.g. `@resvg/resvg-js`) so PNG
  works with zero external setup. Adds a dependency; evaluate before doing.

## 2. Multi-word persona / context tags 🔴

`@Persona` / `@Context` tags must be a single token: `@CustomerService` works,
`@Customer Service` does not (the parser captures one word, see
`src/parser/parser.ts` `tagMatch = /(?:^|\s)@(\S+)\s*$/`). Large teams will want
swimlanes like "Customer Service" or "Claims Ops".

**Proposed:** support quoted tags, e.g. `ui Inbox @"Customer Service"`, and match
them to `persona "Customer Service"`. Update parser + a couple of tests.

## 3. Fixed-size cells clip long labels 🔴

Element cells are a fixed 2.0in × 0.62in (`CELL_W`/`CELL_H` in
`src/emit/dot.ts`). Long names wrap (`wrapLabel`, ~18 chars/line) but the box
height is fixed, so a 3+ line label overflows/clips.

**Options:** auto-grow row height to the tallest label, shrink font for long
labels, or enforce a max name length with a validation warning. Auto-height is
the most robust but interacts with the rigid-grid row locking — needs care.

## 4. No end-to-end render test 🔴

Tests are unit-level (parser, layout, emit DOT, edge geometry, SVG parsing).
Nothing shells out to `dot`/`rsvg-convert` to assert a real render succeeds.

**Proposed:** add an integration test that renders an example to SVG (skipped if
`dot` is unavailable) and asserts the edge overlay is present and well-formed
(e.g. one `marker-end` per `<path>`), plus the box-intersection invariant used
during manual QA.

## 5. Build / packaging verification 🔴

Confirm `npm run build` produces a working `dist/` and the `em` bin runs from
the built output (not just `tsx` dev mode) before any publish/promotion.

## 6. Cross-slice curve aesthetics (low priority) 🟡

Long cross-slice curves (8+ columns) render as smooth, shallow arcs through the
channel and currently pass the no-box-intersection check on all examples. If a
denser model ever produces a curve that grazes a box, `drawEdges.ts` can route
long spans through an explicit mid-channel waypoint (two joined cubics). Revisit
only if a real model needs it.
