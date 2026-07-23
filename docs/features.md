# Features & roadmap

## Current features

**Modeling**
- Slice-first plain-text DSL (`.em`) — one column per slice, time ordered left → right.
- All four Event Modeling patterns: **Input**, **Output**, **Automation**, **Translation**.
- Swimlane bands: Automation, persona UI rows, the shared command/read-model **API** row,
  and context/concept event rows. `@Persona` / `@Context` tags pick the row.
- `view … from "Event"` wires data flow; pattern-based arrow inference plus explicit
  `arrow A -> B`.

**Element detail**
- **Fields** — `{ … }` blocks (one per line or inline; `name` with optional `: Type`),
  rendered in-box UML-style (title, divider rule, field rows). Boxes auto-grow; columns stay
  aligned; arrows stay anchored.
- **Notes** — `note "path.md"` on any element; a numbered folded-corner marker on the box
  plus a legend below the diagram. In SVG the marker and legend rows link to the markdown
  (resolved relative to the output SVG).

**Rendering**
- **Strict grid** via Graphviz `rank=same` + weighted invisible column chains — no manual
  offsets, no drift.
- **Self-drawn edges** — straight within a slice, smooth curves across slices, computed from
  the boxes' real rectangles (see [why-dot-not-plantuml.md](why-dot-not-plantuml.md)).
- **Self-contained output** — Graphviz as bundled WebAssembly, PNG via in-process resvg; no
  system installs for SVG/PNG. PDF/other formats use an optional system `rsvg-convert`.
- `em init | render | watch | validate`, `--emit-dot`, `--keep-empty-lanes`.

**Validation** (`em validate`) — lane collisions, unknown `from` events / read models,
dangling `arrow` endpoints, automation-slice command placement, commands with no event, read
models with no source, ambiguous duplicate names.

**AI assistant** — a bundled Claude Code skill (`em skill install`) for guided greenfield
modeling *and* current-state extraction from existing systems (event-driven or procedural) —
see the README's "AI Assistant" section.

## Roadmap / potential future features

- **Information-completeness validation** — trace every read-model/UI field back to a field
  on a source event, and every event field back to a field on the command that produced it;
  warn on gaps. This is the payoff of the fields feature for the slicing process.
- **Multi-word `@tags`** — quoted persona/context tags (`@"Customer Service"`).
- **Uniform-per-lane box height** — optional rigid alignment when field counts differ a lot
  within a lane (current default is Graphviz center alignment).
- **Theming / palette options** and additional export niceties.
- **Pure-JS PDF** so PDF needs no system dependency either.

See [outstanding-items.md](outstanding-items.md) for the working pre-publication tracker.
