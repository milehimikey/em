<!--
Conformance report skeleton. One per conform run, stored at
<model-name>/conformance/<YYYY-MM-DD>-report.md (see reference/conform.md).
Fill every section; leave "none" rather than deleting a section with nothing to report.
Replace bracketed placeholders; delete guidance comments before finishing.
-->

# Conformance Report — {{Model Name}} — {{YYYY-MM-DD}}

- **Model:** `{{model-name}}.em`
- **Target repo:** {{repo path or URL}} @ `{{revision}}`
- **Previous conformance revision:** {{prior target-repo revision, or "never (first run)"}}
- **Scope:** {{full | diff-scoped since <prior revision>}}
- **Slices checked:** {{comma-separated slice names, or "all implemented slices"}}
- **Slices skipped (not yet implemented):** {{list, or "none"}}

## Summary

| Surface | Real drift | Model gap | Internal inconsistency | Accepted divergence | Unpropagated delta | Uncertainty |
|---|---|---|---|---|---|---|
| Structural | {{n}} | {{n}} | — | {{n}} | {{n}} | {{n}} |
| Spec | {{n}} | {{n}} | — | {{n}} | {{n}} | {{n}} |
| Internal | — | — | {{n}} | {{n}} | — | {{n}} |

**Unpropagated delta** — a slice re-ratified past its shipped version (`slice.doc.driftSignal:
"unpropagated-delta"` in `em export --json`): a known state, not a code defect. See
`reference/conform.md` step 4.

{{One or two sentences: overall read — clean, mostly clean with N items, or notably drifted.}}

## Findings

<!-- One subsection per finding. Group however reads clearest (by slice, or by surface) but keep
     every field below for every finding. Order doesn't matter; classification does. -->

### {{n}}. {{Short finding title}}

- **Surface:** {{structural | spec | internal}}
- **Classification:** {{real drift | model gap | internal inconsistency | accepted divergence | unpropagated delta}}
- **Slice:** {{slice name}}
- **Evidence:** {{file path(s) and line/symbol, or the `em diff --json` entry (type + name) —
  for accepted divergence, the `divergence "..."` annotation text itself; for unpropagated
  delta, `slice.doc.driftSignal` and `slice.doc.version` from `em export --json`}}
- **Claim:** {{what the model/doc says vs. what the code/doc shows — the actual disagreement}}
- **Proposed red note:** `issue "conformance: {{text}}"` on {{element}} (slice "{{slice}}")
  <!-- Omit this line entirely for internal-inconsistency findings with no clear side to flag,
       for any accepted-divergence or unpropagated-delta finding (already ratified, or already
       a known pending-ship state — don't propose re-ratifying either), or when the finding
       doesn't warrant a red note (say why instead). -->

## Scenario / invariant coverage

<!-- Per in-scope slice: every named invariant and every GWT scenario the doc claims, mapped to
     its enforcement/test site. Leave a cell explicitly blank/"none found" rather than omitting
     the row — gaps are the point of this table. -->

### {{Slice Name}}

| Claim | Type | Enforcement site | Test site | Status |
|---|---|---|---|---|
| {{INV-XXX-1 or scenario title}} | {{invariant \| scenario}} | {{file path / symbol, or "none found"}} | {{file path / symbol, or "none found"}} | {{covered \| gap \| uncertain}} |

## Uncertainties

<!-- Listed separately from Findings — these are NOT drift. No evidence either way; say what was
     missing (time, clarity, an ambiguous test) so a follow-up run can pick it up. -->

- **{{structural | spec | internal}}** — {{what's uncertain}} — {{slice}} — {{why: e.g. "couldn't locate the test for INV-CHK-3, only its enforcement site"}}

<!-- Tag each with its surface so these reconcile against the Summary table's Uncertainty column. -->

## Applied this run

<!-- Filled in AFTER the user reviews Findings and says what to apply. Leave "none yet — awaiting
     ratification" until that conversation happens. -->

{{List of ratified proposals actually applied to the `.em`/slice docs, or "none yet — awaiting ratification".}}
