# Screenshot sets

Three sets of 1600 × 900 captures. They are **not** duplicates of each other:
each was taken against a different build or environment, and each proves
something the others cannot. All data is synthetic; Northstar Health Plan is
fictional and every payer interaction is a clearly labelled simulator.

| Set | Captured | Environment | What it proves |
|---|---|---|---|
| `judge-deployed/` | 2026-08-27 | Deployed Cloud Run provider | **Current.** The capability-reveal UX (tiers, `NEW` marker, plain-language reveal reasons) running against the live judge URL. The two README images come from here. |
| `judge/` | 2026-08-27 | Deployed, pre-reveal-UX build | The same eleven beats immediately *before* the capability-reveal change (commit `8da61fd`). Kept as the before-half of that visual delta — beats 03–10 differ from `judge-deployed/`; 01, 02 and 11 are byte-identical. |
| `screenshots/` | 2026-08-26 | Local dev server | Beat-numbered development captures, plus three states no other set covers: `11-unlock-cue-placement`, `12-refusal-missing-evidence` (the adversarial refusal case), `13-deployed-prepared-awaiting-approval`. |

Beat numbering differs between sets: `screenshots/` is numbered by demo beat,
the two `judge*` sets by judge-walkthrough step. `docs/final-ui/captured/`
holds the corresponding real HTTP responses for the same workflow.

## Reuse

`judge-deployed/` is the set to cite. The other two are historical evidence —
prefer re-capturing over reusing them if the UI has moved on.
