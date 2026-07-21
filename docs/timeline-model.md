# The Two Laws of the Timeline

Grounded in Event Modeling canon (Dymitruk's eventmodeling.org; Dilger, *Understanding
Eventsourcing* — "always readable left to right"; Mermaid's Event Modeling diagram type):

1. **No event→event connections.** Information moves only via the four patterns. A command MAY
   record multiple events in one slice (an atomic multi-stream fact set); the renderer draws a
   FAN from the command to each event, side-routing fanned arrows so they never read as a chain.
2. **Forward-only.** Arrows never point right-to-left. An evolving read model REAPPEARS on the
   timeline via `view <Name> again [from …]` — instances share logical identity (first
   declaration owns the note/slice-doc binding), are linked with forward continuity arrows, and
   reactions read the nearest instance at-or-before their own slice. Backward `from` sources,
   reactions reading not-yet-declared views, and backward explicit arrows are validation ERRORS.
