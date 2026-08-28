# Portal spike (MIL-162)

A throwaway prototype for [MIL-162](https://linear.app/milehimikey/issue/MIL-162), the "explore:
interactive, teachable navigator for event models across a multi-model system" ticket. It exists
to answer one question the ticket asks for a prototype to settle: **is `em export --json` (plus
the facts `em status` already aggregates) a sufficient, deterministic integration surface for a
separate portal tool, at hundreds-of-slices/multi-model scale?**

The decision itself — separate add-on tool ("em-portal", its own package/repo) rather than
reworking `em catalog` into something interactive — was made in the 2026-08-28 toolchain gap
assessment before this prototype ran. This spike is the verification step, and its numbers feed
the write-up at [`docs/decisions/mil-162-teachable-navigator.md`](../../docs/decisions/mil-162-teachable-navigator.md).

**This is not a shipped `em` feature.** Nothing here is imported by `src/cli.ts`, it ships no new
`em` command, and it is not published in the npm package. It stays in this repo (rather than a
scratch directory) only so it's reviewable in the PR and reproducible by anyone who wants to
re-run the scale numbers.

## What's here

- `scaleFixture.ts` — deterministic generator for a synthetic multi-model system: N models of M
  slices each, chained so model *i*'s last slice's event is `public` (docs/dsl.md "Integration
  surface") and model *i+1* opens with an intake slice whose `view … from "…"` cites it by name.
- `spike.ts` — materializes a fixture to a temp directory in the real `examples/multi-model/`
  layout (one directory per model), compiles every model the way `em` does, builds each one's
  `em export --json` document, resolves cross-model links purely from that JSON (no access to
  internal model objects), computes the same status-rollup facts `em status` does, and renders
  one self-contained demo HTML page exercising all three portal properties from the ticket:
  state up front, a guided first read, and multi-model navigation.

## Run it

```bash
npx tsx prototypes/portal-spike/spike.ts 6 40   # 6 models, 40 slices each (245 slices total)
open prototypes/portal-spike/demo-output.html
```

`test/portalSpike.test.ts` runs the same pipeline at CI-friendly scale (still hundreds of
slices) as an automated regression guard, and asserts the specific findings the decision doc
cites (cross-model links resolve, the export schema round-trips through JSON with everything the
demo page needs, the full pipeline finishes in bounded time).
