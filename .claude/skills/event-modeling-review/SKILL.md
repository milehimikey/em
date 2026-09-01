---
name: event-modeling-review
em-version: 1.9.0
description: >-
  Use when starting em's live browser viewer (`em watch --serve`) so a team can watch a model
  update in real time, or facilitating a SCHEDULED stakeholder walkthrough that steps through
  slices one at a time in Review mode, capturing anything the room raises live as `issue "..."`
  red notes. Drives `em`'s watch and review phases.
---

# Event Modeling — watch & review

## Phase: `watch` — live team view

Start the watcher with `--serve` in the background:
`em watch <model-name>.em -o <model-name>.svg --serve` (run_in_background). It re-renders on every
save and pushes an instant reload to the browser over Server-Sent Events. Tell the user to open the
URL it prints (e.g. `http://localhost:5173/?svg=<model-name>.svg`) and share their screen — updates
appear the moment you save, with no polling and no idle churn between edits.

The viewer navigates like a map — drag to pan, scroll/pinch to zoom, **Fit** to reset — and its
**Review mode** steps through slices one at a time (see the `review` phase below). A save that
fails to render never blanks the shared screen: the last good diagram stays up, an error banner
explains what went wrong, and the viewer recovers on its own at the next successful render.

## Phase: `review` — stakeholder walkthrough

Goal: step a real stakeholder review session through the model slice by slice, one slice
spotlighted at a time, with any open questions the room raises captured live as `issue "..."`
red notes.

**Trigger: a real stakeholder review session is on the calendar — a scheduled use, not
speculation.** Don't propose this phase proactively; it exists for facilitated reviews with
non-engineer stakeholders in the room, not routine model editing.

Start the same live server as `watch`: `em watch <model-name>.em -o <model-name>.svg --serve`
(run_in_background). Open the printed URL, click **Review mode** in the header, and share the
screen. Use Prev/Next (or the left/right arrow keys) to step through slices in declaration
order — each one pans/zooms into view with everything else dimmed, so the room's attention
tracks one slice at a time.

**Live capture:** when a stakeholder raises something unresolved, add `issue "..."` to the
relevant element in the `.em` file and save — exactly the same mechanism `event-modeling-conform`
uses for any other issue. The browser updates over the existing SSE push within moments, without
losing the current slice or resetting review mode.

Wrap-up: run `em validate --list-issues` to sweep everything captured during the session and
walk each one with the user, same as any open issue. Update the state file's Participants
section with who attended, and run `em state set-review <date>` to set the `Last stakeholder
review:` marker (mirrors `Last conformance:`).

End of phase: state file's `Last stakeholder review:` marker updated, every issue captured
live triaged (resolved on the spot, moved to Open questions / parking lot, or left open on
purpose). Review doesn't chain to another phase — it's a recurring, scheduled activity like
`conform`, not a step in the discover → model → slice sequence.

Preconditions (tool check, model location) are the same as every other phase — see
`../event-modeling-shared/reference/operating-principles.md`.
