# Screenshot sets

Four sets. They are **not** duplicates of each other:
each was taken against a different build or environment, and each proves
something the others cannot. All data is synthetic; Northstar Health Plan is
fictional and every payer interaction is a clearly labelled simulator.

| Set | Captured | Environment | What it proves |
|---|---|---|---|
| `gpt-work-app/` | 2026-08-28 | **Real ChatGPT agent**, GPT Work App → deployed provider | **Current — the two README images.** WellAuth driven by an actual agent rather than a scripted browser: the agent chooses tools from natural-language intent, stops honestly at 4/5 with `NO STRUCTURED MATCH`, and at 5/5 states it cannot submit while the human `Approve submission` control waits. The only set showing the intended surface — WellAuth *inside* an agent client. |
| `judge-deployed/` | 2026-08-27 | Deployed Cloud Run provider | Full eleven-beat walkthrough incl. Act II (payer window gap → remediation → `AUTHORIZATION_ALIGNED`), with the capability-reveal UX (tiers, `NEW` marker, reveal reasons). Was the README source before the GPT Work App captures. |
| `judge/` | 2026-08-27 | Deployed, pre-reveal-UX build | The same eleven beats immediately *before* the capability-reveal change (commit `8da61fd`). Kept as the before-half of that visual delta — beats 03–10 differ from `judge-deployed/`; 01, 02 and 11 are byte-identical. |
| `screenshots/` | 2026-08-26 | Local dev server | Beat-numbered development captures, plus three states no other set covers: `11-unlock-cue-placement`, `12-refusal-missing-evidence` (the adversarial refusal case), `13-deployed-prepared-awaiting-approval`. |

Beat numbering differs between sets: `screenshots/` is numbered by demo beat,
the two `judge*` sets by judge-walkthrough step, and `gpt-work-app/` covers only
the two beats it captures. `docs/final-ui/captured/`
holds the corresponding real HTTP responses for the same workflow.

## Reuse

`gpt-work-app/` is the set to cite for the product thesis — it is the only
evidence of a real agent client driving WellAuth. `judge-deployed/` remains the
set to cite for full-journey and Act II states, which `gpt-work-app/` does not
cover. The other two are historical evidence — prefer re-capturing over reusing
them if the UI has moved on.

The `gpt-work-app/` captures are 1600 px wide at the source aspect ratio (not
1600 × 900): they are full-window, showing the agent panel and the WellAuth page
side by side.
