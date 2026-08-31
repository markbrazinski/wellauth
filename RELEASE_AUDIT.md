# Release audit — WellAuth

> **Historical audit note — current publication state:**
> This audit was originally performed *before* final repository publication.
> The repository is **now public and current on `main`**, the root `LICENSE` is
> Apache-2.0 and GitHub-detected, and every commit described below is pushed.
> The earlier private/unpublished findings are retained unedited as historical
> audit context. **For current judge instructions, release state, the live URL
> and testing guidance, use [`README.md`](README.md).**

**Verdict: PASS WITH LIMITATIONS**

Audit run 2026-08-28 against commit `292ffee`, re-verified the same day against
commit `d81d59a` (branch `gate-3.5-contract-review`). See *Re-verification* below.
Scope was release readiness only: no product redesign, no refactor, no
dependency changes, no history rewrite, no deploy.

---

## Repository mode

**Hosted + local.** Primary evaluation path is the deployed Cloud Run provider;
local setup exists for code review and reproduction. Judges are not required to
run cloud setup.

- Provider: `https://wellauth-provider-qxqdngmwjq-uc.a.run.app` — HTTP 200, 2.1 s, `<title>WellAuth — Prior Authorization</title>`
- Payer simulator: `https://wellauth-payer-simulator-qxqdngmwjq-uc.a.run.app` — live

---

## Files changed

| File | Change |
|---|---|
| `README.md` | Embedded two proof images after the demo paragraph; corrected two stale test counts; linked the screenshot index |
| `docs/final-ui/IMAGES.md` | **New.** Explains what each of the three screenshot sets proves |
| `provider/policy.js`, `server/fixtures.js`, `src/LowerRegion.tsx` | Pre-existing working-tree change, verified and committed as `292ffee` (see below) |

**Files removed: none.** See *Deviations*.

---

## Secret scan

Clean. Scanned the tracked tree for API keys, bearer tokens, private keys,
connection strings, and personal contact data.

- One regex hit, `provider/smoke.js:123` — a leak *detector* (`match(/ya29\.|BEGIN PRIVATE KEY|Bearer /)`), not a leaked credential.
- No `.env` files present anywhere outside `node_modules`.
- `.gitignore` covers `.env*`, `*.pem`, `*.key`, `service-account*.json`, ADC, `.gcloud/`, `.aws/`, `.netrc`.
- `dist/` and `tsconfig.tsbuildinfo` are untracked and ignored.
- No untracked non-ignored files in the working tree.

No credential was found in Git history, so no rotation question arises.

---

## License

Apache License 2.0 at repository root, GitHub-detectable. Pre-existing and
intentional; unchanged.

---

## Images

Two proof images now appear near the top of the README, both from
`docs/final-ui/judge-deployed/` (captured against the deployed provider):

1. `06-approved-submit-unlocked.png` — 5/5 met, packet `e23c7cb8` bound, `Submit to payer` marked **NEW** with the reveal reason "Available because you approved the exact submission." This is the human-approval → capability-unlock beat.
2. `10-authorization-aligned.png` — terminal `AUTHORIZATION_ALIGNED`, 15-event timeline spanning assistant, human and simulated-payer events, MRI covered.

Both carry descriptive alt text and an italic caption. No credentials, real
patient data, or private URLs are visible; all data is synthetic.

The three screenshot sets were verified **not** to be duplicates — a byte
comparison showed 8 of 11 files differ between `judge/` and `judge-deployed/`.
They are now documented in `docs/final-ui/IMAGES.md` rather than pruned.

---

## Tests run

Every count below was measured during this audit, not carried over.

| Suite | Result | Environment |
|---|---|---|
| `npm test` | **127/127** | local |
| `npm run test:gate2` | **147/147** | local |
| `npm run test:gate3` | **191/191** | live payer |
| `npm run test:gate4` | **99/99** | live payer |
| `npm run test:gate4` (`GATE4_BASE_URL`) | **99/99** | deployed provider + payer |
| `npm run test:gate5` | **41/41** | local |
| `npm run test:browser` | **12/12** | real Chrome |
| `node browser-journey.mjs <provider>` | **107/107** | real Chrome → deployed |
| `npm run build` | clean, 37 modules, 257.90 kB (78.52 kB gzip) | local |

**Total: 823 checks, 0 failures.**

Two README counts were stale and are corrected: `npm test` claimed 110/110
(actual 127/127) and `browser-journey.mjs` claimed 90/90 (actual 107/107). Both
suites had grown; neither was failing.

The journey run also re-proved the central thesis directly — the browser's own
WebMCP inventory carries no submission capability at `PREPARED_AWAITING_APPROVAL`
(5 tools) and gains `submit_prior_authorization` only at `APPROVED` (6 tools).

---

## Commit `292ffee`

The working tree was dirty at audit start. The change reorders `req-003` (the
alternate-path "failed or contraindicated conservative therapy" requirement) to
last in requirement-set order, so the 4/5 → 5/5 beat lands on the final row.

Verified safe before committing:

- `provider/workflow.js` sorts disclosure items by `requirementId` before canonicalization (3 call sites), so hashed bytes are a function of content, not requirement-set position.
- `src/LowerRegion.tsx` sorts a **copy** for display, with a `ponytail:` comment stating that the hashed bytes must not move.
- No test asserts positional requirement order.
- 127/127 unit tests pass on the result.

---

## Deviations from the skill

1. **No files deleted.** Phase 3 calls for pruning duplicate screenshots. A byte comparison disproved the duplication premise: `judge/` and `judge-deployed/` bracket the capability-reveal UX change (commit `8da61fd`), and `screenshots/` uniquely holds the adversarial refusal state (`12-refusal-missing-evidence.png`). Phase 3 also says preserve evidence that proves the product works. Documented instead — deleting 3.3 MB of gate evidence is the user's call.
2. **No README rewrite.** Phase 5 assumes the README needs authoring. It already follows the product-first structure: thesis, synthetic-data statement, judge access, architecture, test evidence, standards claims. Only the image gap and the stale counts were real defects.
3. **No `.env.example` added.** Phase 3 wants one; there is nothing to template. Runtime config is Cloud Run environment plus ADC, and the only secret (`WELLAUTH_DEMO_RESET_TOKEN`) is already documented in the Reset section.
4. **No clean-clone verification.** Phase 6 is marked "when practical." The primary evaluation path is hosted and was smoke-tested end-to-end against the deployed provider, which is stronger evidence for a judge than a local clone. Local reproduction was exercised in part: install, build, and six suites ran from this tree.

---

## Note for re-runners

`npm run test:gate3` rewrites `docs/gate3/outgoing-pas-request.json` in place
with a fresh timestamp, derived claim ids, and current FHIR `versionId`s. Only
those run-specific values change; the PAS structure Gate 3 validated is
unaffected. This audit reverted that churn rather than commit it into a frozen
gate artifact (CLAUDE.md §28). Expect the file to show as modified after any
gate 3 run — `git checkout -- docs/gate3/outgoing-pas-request.json` clears it.

## Blockers

None for repository safety. One blocker for *publication* was open when this
audit ran — see item 2 below. **It is now resolved: the repository is public and
`main` carries this tree.**

## User input still required

1. **Screenshot sets** — keep all three (documented, 4.8 MB), or delete `judge/` and `screenshots/` now that `judge-deployed/` is the cited set.
2. **Publication state** — ~~the audited work is not published~~ **Resolved:** `main` is pushed and the repository is public. See *Re-verification* below.
3. **Availability window** — the README leads with the live URL. Confirm both Cloud Run services stay up through the evaluation period.

---

## Re-verification — 2026-08-28, commit `d81d59a`

Second pass over the same repository, run after two further commits landed
(`40eec4a` WebMCP self-abort fix, `d81d59a` the first audit). Working tree clean
at start and at finish.

### Every documented count reproduced

All eight suites were re-run, not carried over. Each matched the README exactly.

| Suite | Result | Environment |
|---|---|---|
| `npm test` | **127/127** | local |
| `npm run test:gate2` | **147/147** | local |
| `npm run test:gate3` | **191/191** | live payer |
| `npm run test:gate4` | **99/99** | live payer |
| `npm run test:gate5` | **41/41** | local |
| `npm run test:browser` | **12/12** | real Chrome |
| `node browser-journey.mjs <provider>` | **107/107** | real Chrome → deployed |
| `npm run build` | clean, 37 modules, 257.90 kB (78.52 kB gzip) | local |

**823 checks, 0 failures.** The bundle size is byte-identical to the documented
figure. The journey run again re-proved the central thesis from the browser's own
capability inventory: 5 tools at `PREPARED_AWAITING_APPROVAL` with no submission
capability, 6 at `APPROVED` once `submit_prior_authorization` is revealed.

### Deployed services

- Provider — HTTP 200, 2.07 s, `<title>WellAuth — Prior Authorization</title>`
- Payer simulator — HTTP **403** unauthenticated; **200** with an identity token,
  returning `"marker": "SIMULATED PAYER -- Northstar Health Plan (fictional)"`.

The 403 is Cloud Run IAM, not a broken service: `/health` exists at
`payer/index.js:154`. The payer being unreachable without provider identity is
the payer-boundary control working as designed.

### Secret scan — clean, history included

Tracked-tree scan for Google OAuth/API keys, private keys, `sk-`/`xox`/AKIA
tokens and certificates returned two hits, both the known leak *detector* at
`provider/smoke.js:123` and the previous audit's description of it. Per-pattern
scan across **all** history: 0 real hits (the only `BEGIN PRIVATE KEY` matches are
that same detector regex). No `.env`, credential, `.pem`, `.key` or
service-account file is tracked. No untracked non-ignored files.

`CLAUDE.md` — the internal operating contract — is correctly untracked and stays
out of any published tree.

### README integrity

Both embedded proof images and all five linked gate reports resolve on disk.

### Gate 3 artifact churn — confirmed and reverted

As the note below predicted, `npm run test:gate3` rewrote
`docs/gate3/outgoing-pas-request.json`. The diff was inspected: 7 lines, only
bundle/claim ids, timestamps and FHIR `versionId`s. The PAS structure Gate 3
validated is unchanged. Reverted per CLAUDE.md §28.

### New finding — the repository is private and 20 commits stale

> **Historical — resolved.** Both conditions in this finding have since been
> fixed: `main` was pushed and the repository was made public. The finding is
> kept as written to preserve the audit trail.

The prior audit recorded the branch as "unpushed, no upstream" and did not check
the remote. It exists and is materially behind:

- `origin` → `github.com/markbrazinski/wellauth.git`, **visibility: PRIVATE**
- `origin/main` → `a96afff` *"Ignore CLAUDE.md"*, last pushed **2026-08-26**
- `HEAD` is **20 commits ahead** of `origin/main`

What is published is the Gate 1 FHIR truth layer — before the product, the
WebMCP capability lifecycle, the payer boundary, the final UI, the proof images
and this audit existed. `origin/main` is a clean ancestor of HEAD, so publishing
is a fast-forward with no divergence to reconcile.

**Nothing in this audit is visible to a judge until the branch is pushed and the
repository is made public.** Both actions are outside this skill's change limits
and are left to the user.

*Update, same day:* `main` was fast-forwarded to this tree and pushed to
`origin` at the user's instruction (`a96afff..455111e`, 21 commits). Visibility
was deliberately left **PRIVATE** at that point.

*Final update:* the repository was subsequently made **PUBLIC** at the user's
instruction, verified anonymously (repo page, raw `README.md` and the embedded
proof images all return HTTP 200). `main` is in sync with `origin/main`.

### README images superseded

The two `judge-deployed/` images described above were replaced with
`docs/final-ui/gpt-work-app/` — a real ChatGPT agent, in the GPT Work App,
driving WellAuth. This is stronger evidence for the product thesis than a
scripted browser capture: it shows an actual agent client selecting tools from
natural-language intent, stopping honestly at 4/5 with `NO STRUCTURED MATCH`,
and holding no submission capability at 5/5 while the human control waits.

Checked before release: synthetic patient only, payer labelled simulated, no URL
bar, no tokens, no location or provenance metadata. Downscaled to 1600 px wide
(4.0/3.6 MB → 1.6/1.8 MB) and re-read at that size to confirm legibility. The
`judge-deployed/` set is retained and still cited for the Act II states the new
pair does not cover.

## Final verification commands

```sh
npm test                                                     # 127/127
npm run test:gate2                                           # 147/147
npm run test:gate5                                           # 41/41
PAYER_BASE_URL=https://wellauth-payer-simulator-qxqdngmwjq-uc.a.run.app npm run test:gate3   # 191/191
PAYER_BASE_URL=https://wellauth-payer-simulator-qxqdngmwjq-uc.a.run.app npm run test:gate4   # 99/99
npm run test:browser                                         # 12/12
node browser-journey.mjs https://wellauth-provider-qxqdngmwjq-uc.a.run.app                   # 107/107
npm run build
```

---

> **SAFE TO MAKE PUBLIC: YES**

Re-verified at `d81d59a`. Qualified by the three user decisions above, none of
which is a safety issue. *Safe to publish* was not *published* when this line
was first written; **the repository has since been made public and `main` now
carries this tree.**
No secret, credential, real PHI, or private endpoint is present in the tracked
tree or in Git history. All clinical data is synthetic and every payer
interaction is a clearly labelled simulator.
