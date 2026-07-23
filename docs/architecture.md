# Architecture: why DOT, not PlantUML

`em` needs a truly rigid grid: swimlane rows and time-ordered slice columns that stay
perfectly aligned no matter how sparse or dense the model is. That requirement drove the
choice of Graphviz over PlantUML.

## PlantUML can't express a strict grid

PlantUML's component/deployment diagrams have no equivalent of Graphviz's `rank=same`. To
force a grid there you end up estimating pixel widths and nudging boxes by hand, which
drifts the moment the model changes. `em` instead generates Graphviz **DOT** directly and
uses the [grid technique](https://graphviz.org/Gallery/undirected/grid.html): a full
*rows × columns* matrix where every empty cell is an invisible placeholder.
Heavily-weighted invisible vertical edge chains lock the columns; a `rank=same` group per
row locks and orders each row. The result has no manual offsets and no alignment drift.

## Graphviz lays out the grid; `em` draws the arrows

There's a catch: Graphviz's `splines` setting is graph-global, so it can't give you
straight within-slice verticals *and* clean cross-slice curves at the same time. Every
approach that relied on Graphviz's edge router traded one defect for another (sideways
bulges, off-graph sweeps, hairline gaps).

So `em` stops using Graphviz's edge router entirely. Graphviz does two jobs only:

1. lay out the strict grid, and
2. render the boxes/labels (including the UML-style field tables).

Then `em` reads each box's rectangle back out of the rendered SVG
(`src/render/svgGeometry.ts`) and draws the arrows itself (`src/render/drawEdges.ts`):

- **within a slice** (same column): a straight, centred vertical line, edge to edge;
- **across slices**: a smooth cubic bezier that leaves/enters perpendicular to the box
  faces and arcs through the channel between rows.

Because arrows are computed from the *actual* rendered rectangles, they stay correct even
when boxes grow to fit fields — the lines re-anchor to wherever the edges really are. Note
markers and the notes legend are injected into the SVG the same way
(`src/render/drawNotes.ts`).

This "Graphviz for layout, `em` for routing" split is the core architectural decision
behind the tool's clean, stable diagrams.

## How a render flows

1. `.em` → AST → normalized model → strict-grid **DOT** (`src/emit/dot.ts`).
2. WASM Graphviz lays out the grid and renders boxes/labels → **SVG**.
3. `em` reads each box rectangle from the SVG and injects self-drawn arrows and note
   markers/legend (`src/render/{svgGeometry,drawEdges,drawNotes}.ts`).
4. Output: write the SVG directly, rasterize to PNG with resvg, or convert to PDF/other
   via an optional system `rsvg-convert`.

Everything in steps 1–3 is bundled with the npm package; see
[dependencies.md](dependencies.md) for what's in-process versus optional.
