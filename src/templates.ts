// SPDX-License-Identifier: MIT
// Starter model used by `em init`.

export const STARTER_EM = `model "Order Fulfillment"

persona Customer
persona Manager

context Order
context Payment

# --- Command pattern: UI -> command -> event ---
slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}

# --- View pattern: event -> read model -> UI ---
slice "View Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Payment
  event Payment Requested @Payment
}

# --- View pattern: a human view of pending payments ---
slice "Manager Review" {
  view Pending Payments from "Payment Requested"
  ui Payment Dashboard @Manager
}

# --- Automation slice: only the read model it reads + the processor ---
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

# --- Command slice: the command the automation triggers + its event ---
slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}

slice "Show Receipt" {
  view Receipts from "Payment Captured"
  ui Receipt Screen @Customer
}
`;

// ---- Templates for `em scaffold` (MIL-97 item 2) ----
//
// Embedded verbatim (backticks escaped) from the bundled skill's own templates/ directory,
// mirroring STARTER_EM above — the compiled CLI never reads .claude/skills/ at runtime to
// produce these, so `em scaffold` behaves identically whether em is run from a checkout or
// installed from npm. test/scaffoldTemplatesSync.test.ts asserts each constant below stays
// byte-identical to its source file in .claude/skills/event-modeling/templates/, so the two
// copies can't silently drift — regenerate by hand (or re-run the one-off script noted there)
// whenever a template file changes.

/** Verbatim copy of templates/live.html — no placeholders, written byte-for-byte by `em scaffold`. */
export const LIVE_HTML_TEMPLATE = `<!doctype html>
<!--
  Live viewer for an em event model. Auto-reloads the rendered SVG so a team on a shared
  screen sees updates from \`em watch\` without manual refresh.

  Two ways to use it:

    A) Push (recommended, instant, no polling):
         em watch MODEL.em -o MODEL.svg --serve
       then open the URL it prints (http://localhost:5173/?svg=MODEL.svg). You don't need
       this file at all in that mode — the server serves its own push-based viewer.

    B) This file, over file:// (no server):
         1) In one terminal:  em watch MODEL.em -o MODEL.svg
         2) Open this file with the SVG name in the query:
              open "live.html?svg=MODEL.svg"      (macOS)
            No editing required — the ?svg= param picks the model.

  Under file:// the browser gives no reliable "did the file change?" signal (fetch/HEAD is
  blocked), so this fallback polls and reloads on a gentle interval. It double-buffers the
  swap so a shared screen never flashes. For zero idle work and instant updates, use --serve.

  The SVG is embedded via <object> so note "..." links inside it stay clickable.
-->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Event Model — Live</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #fafafa; }
    header {
      display: flex; align-items: center; gap: .75rem;
      padding: .5rem .9rem; background: #1f2933; color: #fff; font-size: 14px;
    }
    header .dot { width: 9px; height: 9px; border-radius: 50%; background: #34c759; }
    header .stamp { margin-left: auto; opacity: .7; font-variant-numeric: tabular-nums; }
    #stage { padding: 1rem; }
    object { width: 100%; height: calc(100vh - 60px); border: 0; }
  </style>
</head>
<body>
  <header>
    <span class="dot"></span>
    <span>Event Model — live (auto-refresh)</span>
    <span class="stamp" id="stamp">—</span>
  </header>
  <div id="stage">
    <object id="svg" type="image/svg+xml"></object>
  </div>
  <script>
    // SVG filename from ?svg=<name>.svg (defaults to model.svg) — one file serves any model.
    const SVG_FILE = new URLSearchParams(location.search).get("svg") || "model.svg";
    // Poll cadence for the file:// fallback. Tune freely; --serve makes polling unnecessary.
    const REFRESH_INTERVAL_MS = 2000;

    const stage = document.getElementById("stage");
    const stamp = document.getElementById("stamp");
    let current = document.getElementById("svg");
    let lastModified = null;

    // Best-effort change check — only meaningful when served over http(s). Under file://
    // fetch/HEAD is blocked, so this throws and we fall back to reloading every tick.
    async function changed() {
      if (!location.protocol.startsWith("http")) return true;
      try {
        const res = await fetch(SVG_FILE, { method: "HEAD", cache: "no-store" });
        const tag = res.headers.get("last-modified") || res.headers.get("etag");
        if (tag && tag === lastModified) return false;
        lastModified = tag;
        return true;
      } catch {
        return true; // can't tell — reload to be safe
      }
    }

    // Double-buffer: load into a hidden <object>, swap on load, so the shared screen
    // never flashes white during a reload.
    function swap() {
      const next = document.createElement("object");
      next.type = "image/svg+xml";
      next.style.cssText = current.style.cssText;
      next.addEventListener("load", () => {
        stage.replaceChild(next, current);
        current = next;
        stamp.textContent = new Date().toLocaleTimeString();
      }, { once: true });
      next.setAttribute("data", SVG_FILE + "?t=" + Date.now());
    }

    // Self-scheduling loop: schedule the next tick only after this one resolves, so a slow
    // reload can never overlap the next tick.
    async function tick() {
      try {
        if (await changed()) swap();
      } finally {
        setTimeout(tick, REFRESH_INTERVAL_MS);
      }
    }

    swap();
    setTimeout(tick, REFRESH_INTERVAL_MS);
  </script>
</body>
</html>
`;

/** Raw copy of templates/model-readme.md, \`{{...}}\` placeholders intact — see scaffoldReadme(). */
export const MODEL_README_TEMPLATE = `# {{Model Name}}

{{One-paragraph description of the business process(es) this event model covers.}}

## Live view
While modeling, run the live view so the team can watch the diagram update:

\`\`\`bash
em watch {{model-name}}.em -o {{model-name}}.svg --serve   # re-render + instant push-reload
# then open the URL it prints (http://localhost:5173/?svg={{model-name}}.svg) and share the screen
\`\`\`

No server? Run \`em watch {{model-name}}.em -o {{model-name}}.svg\` and open
\`live.html?svg={{model-name}}.svg\` in a browser (polls ~2s; share the screen).

Static render: \`em render {{model-name}}.em -o {{model-name}}.svg\`

## Patterns legend
- **State Change** — UI → Command → Event
- **State View** — Event(s) → Read Model → UI
- **Automation** — Read Model (slice before) → Processor + Command → Event, together
- **Translation** — External input (or Read Model, slice before) → Translation + Command → Event, together

Between them these are the only legal connections: \`ui → command\`, \`command → event\`,
\`event → read model\`, \`read model → ui\`, \`read model → reaction\`, \`reaction → command\`. A command
never reaches a read model directly — the event goes between them. Every slice is joined up at
both ends: something triggers each command (the screen it's issued from, or the reaction that
triggers it, also in this slice), and every event a command records is read by some read model — so each State
Change slice is paired with the State View slice that projects its event. A read model repeated
along the timeline (\`view X again\`) shows the same projection at a later point; the instances are
never connected to one another.

## Slices
<!-- The canonical slice index — the ONE place slices are enumerated (the state file
     points here rather than keeping its own copy). Generated — run
     \`em slice index {{model-name}}.em\` to (re)write the table below from the model and its
     slice docs; never hand-edit between the markers. -->
<!-- GENERATED:slices:start -->
| # | Slice | Pattern | Status | Implemented in | Design doc |
|---|-------|---------|--------|----------------|------------|
<!-- GENERATED:slices:end -->

## Status
See [\`.event-modeling.md\`](.event-modeling.md) for current phase, decisions, and open questions.
`;

/** Raw copy of templates/state.md, \`{{...}}\` placeholders intact — see scaffoldStateFile(). */
export const STATE_TEMPLATE = `<!--
Resumable progress state for an event model. Stored as <model>/.event-modeling.md
The skill reads this on \`/event-modeling\` (no arg) to resume where you left off.
Keep it current at the end of every working session.
-->

# Event Modeling Progress — {{Model Name}}

- **Model file:** \`{{model-name}}.em\`
- **Current phase:** {{discover | extract | model | slice | implement | conform | review | validate}}
- **Current step:** {{1–7, see methodology; or extraction round R1–R7}}
- **Last updated:** {{YYYY-MM-DD}}
- **Last conformance:** {{YYYY-MM-DD @ <target-repo revision> — report: conformance/<date>-report.md | never}}
- **Last stakeholder review:** {{YYYY-MM-DD — attendees: see Participants | never}}

## Session inputs
- **Scope line:** {{one-line description of what's in/out of bounds for this model}}
- **PRD / spec reference:** {{path, link, or "none"}}
- **Headless/API model:** {{yes | no}}
- **Source mode:** {{greenfield | extract-event-driven | extract-procedural}}
- **Existing system refs:** {{repo paths, event-schema/topic locations, docs — or "n/a"}}

## Participants
<!-- Populate at session start. Live workshop: one human proxy relays questions to the room;
     attribute every answer/decision in the Decisions log to a named participant here. -->
- {{Name}} — {{role}} — {{domain area}}

## Extraction progress (existing-system models only — delete for greenfield)
- [ ] R1. Candidate events (extracted/synthesized, filtered, confirmed)
- [ ] R2. Timeline order (as-is narrative, actors/callers, first render)
- [ ] R3. Commands / inputs
- [ ] R4. Read models / outputs (validate from here)
- [ ] R5. Boundaries & reactions (reaction shares its slice with the command it triggers)
- [ ] R6. Gap & TBD reconciliation
- [ ] R7. Convergence (render + validate clean, user confirmed as-is)

## Steps completed
- [ ] 1. Brainstorm events
- [ ] 2. Plot / storyboard (personas + UI)
- [ ] 3. Inputs (commands)
- [ ] 4. Outputs (read models)
- [ ] 5. Swimlanes & apply patterns
- [ ] 6. Elaborate scenarios
- [ ] 7. Evaluate completeness (\`em validate\` clean)

## Decisions log
<!-- Resolved choices, with the reasoning, so they aren't re-litigated. In a live workshop,
     attribute each entry to the participant who made the call (see Participants above). -->
- {{YYYY-MM-DD}}: {{decision}} — {{why}} — by {{participant, if a live workshop}}

## Usage log
<!-- The team's only usage signal today (see docs/usage-data.md) — cheap and coarse on purpose.
     One line per session: phase(s) touched, and validate diagnostic *categories* hit (one of
     the exact fixed strings in docs/usage-data.md#categories, e.g. "read model has no
     consumer" — never the full instance message or any domain content). Append, never edit
     past entries. -->
- {{YYYY-MM-DD}}: phases: {{discover | extract | model | slice | implement | conform | review | validate | watch, ...}} — validate: {{diagnostic category (docs/usage-data.md#categories), ... | none}}

## Open questions / parking lot
<!-- Unresolved items to bring back to the user. Never guess these. Metadata is optional and
     flat — add only what's known: source (ticket/conversation that spawned it), blocked on
     (who/what), revisit (when). -->
- [ ] {{question}} — source: {{ticket/conversation link, optional}} — blocked on: {{who/what, optional}} — revisit: {{when, optional}}

## Slice inventory
<!-- Deliberately NOT a table: the canonical slice index (slice, pattern, status, doc link)
     lives in README.md's "Slices" section — one source of truth, updated there. This file
     only tracks resumable session state. -->
See \`README.md\` → **Slices** for the slice index and per-slice doc status.
`;

/** Same STARTER_EM content `em init` writes, titled from an arbitrary display name — used by
 *  `em scaffold`, which (unlike `em init`) knows a name to title the model with. */
export function starterEmFor(title: string): string {
  return STARTER_EM.replace('model "Order Fulfillment"', `model "${title}"`);
}

/** Fill MODEL_README_TEMPLATE's Model Name / model-name placeholders from `em scaffold`'s
 *  arguments. The still-unknown one-paragraph description drops to a guidance comment rather
 *  than a fabricated sentence — never leaves \`{{...}}\` in the result. The GENERATED:slices
 *  marker block is untouched: it's already header-only in the template (MIL-98), so there's
 *  nothing to fill and no placeholder row to hand-write. */
export function scaffoldReadme(displayName: string, slugName: string): string {
  return MODEL_README_TEMPLATE.replace(/\{\{Model Name\}\}/g, displayName)
    .replace(/\{\{model-name\}\}/g, slugName)
    .replace(
      "{{One-paragraph description of the business process(es) this event model covers.}}",
      "<!-- One-paragraph description of the business process(es) this event model covers. -->",
    );
}

/** Fill STATE_TEMPLATE's mechanical fields (model path, phase, step, dates) with real values.
 *  Every judgment section's placeholder bullet (Session inputs, Participants, Decisions log,
 *  Usage log, Open questions) is dropped rather than filled, leaving a real empty heading with
 *  the template's own guidance comment intact where it has one — per the skill's "don't guess,
 *  park it" principle, never a fabricated example. Never leaves \`{{...}}\` in the result. */
export function scaffoldStateFile(displayName: string, slugName: string, today: string): string {
  const filled = STATE_TEMPLATE.replace("{{Model Name}}", displayName)
    .replace("{{model-name}}", slugName)
    .replace("{{discover | extract | model | slice | implement | conform | review | validate}}", "discover")
    .replace("{{1\u20137, see methodology; or extraction round R1\u2013R7}}", "1")
    .replace("{{YYYY-MM-DD}}", today) // "Last updated" — the first occurrence; later ones belong to
    // judgment-section placeholder bullets and are dropped whole below.
    .replace("{{YYYY-MM-DD @ <target-repo revision> \u2014 report: conformance/<date>-report.md | never}}", "never")
    .replace("{{YYYY-MM-DD \u2014 attendees: see Participants | never}}", "never");

  return filled
    .split("\n")
    .filter((line) => !line.includes("{{"))
    .join("\n");
}
