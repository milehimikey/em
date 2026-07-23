# Findings: CLI Surface and Packaging

Source: Explore-agent recon over `src/`, `package.json`, `README.md`, `docs/features.md`
(2026-07-23); key claims spot-verified.

## CLI surface (`src/cli.ts`, commander@12, hand-registered)

- `init [file]` — scaffold starter `.em` (`STARTER_EM` in `src/templates.ts`); `--force`.
- `render <file>` — `.em` → SVG/PNG/PDF or `--emit-dot`; `-o`, `-T`, `--keep-empty-lanes`.
- `watch <file>` — re-render on save; `--serve` adds SSE live viewer (`--port`, default 5173).
- `validate <file>` — structural diagnostics; non-zero exit on errors.
- `skill install [--force]` — copies the bundled skill dir into `./.claude/skills/event-modeling/`
  (recursive `cp`, `cli.ts:142–161`), resolving from the installed package directory.
- There is **no** `slice` or `migrate` subcommand; `slice` exists only as a DSL keyword and a
  skill phase. Doc templates live in the skill, not `src/`.

## Packaging — distribution of skill content is already first-class

- `package.json` `files`: `["dist", "README.md", "LICENSE", ".claude/skills"]` — **the skill
  ships in the npm tarball.** Any new file under `.claude/skills/event-modeling/` (e.g. a new
  reference file) ships and installs automatically via the recursive copy; zero packaging work.
- Users get the skill via `em skill install` (README "AI Assistant" section, which also lists
  the `/event-modeling <phase>` commands).

## `em validate` rule categories (`src/model/validate.ts`)

Lane collisions (error); automation/translation slice containing a command (warn); command
with no event (warn); view with no source (warn); unknown `from` event (error); forward-only
time for views (error); reaction reading an unknown or not-yet-existing view (error);
`view … again` without earlier declaration (error); arrow endpoint errors; ambiguous duplicate
names (warn). Missing `note` files are warned about in `cli.ts`, not the validator. The
contract is **structural rules over the model** — no authoring-progress telemetry.

## Extraction-adjacent code

**None.** The pipeline is strictly `.em → parse → normalize → layout → validate → DOT → render`
(`src/pipeline.ts`). Nothing in `src/` reads external code or docs to produce a model, and the
CLI makes no LLM calls. Tests (vitest) exercise internal modules and the live server directly.
