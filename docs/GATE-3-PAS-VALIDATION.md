# Gate 3 — PAS validation record

What was checked against **Da Vinci PAS 2.2.1 / FHIR R4**, what passed, and
what was **not** established. The safe claim is stated at the bottom.

Artifact under test: `docs/gate3/outgoing-pas-request.json` — the exact bytes
the provider transmits, written by the Gate 3 suite (P0.19), not hand-authored.

## 1. Structural conformance against the official 2.2.1 package

These checks read the **official** `hl7.fhir.us.davinci-pas#2.2.1` package
(StructureDefinitions and OperationDefinition shipped by HL7) and compare it to
the artifact. They do not depend on the validator running.

### Transport — `OperationDefinition-Claim-submit`

| Property in the official package | Value | WellAuth |
|---|---|---|
| `code` | `submit` | `POST …/Claim/$submit` ✅ |
| `resource` | `["Claim"]` | Claim ✅ |
| `type` (type-level operation) | `true` | type-level, not instance ✅ |
| input parameter type | `Bundle` | Bundle ✅ |
| output parameter type | `Bundle` | ⚠️ returns bare `ClaimResponse` — see §3 |

### Request bundle — `profile-pas-request-bundle`

| Constraint | Required | WellAuth |
|---|---|---|
| `Bundle.type` | pattern `collection` | `collection` ✅ |
| `Bundle.entry` | min 1 | 10 entries ✅ |
| first entry | Claim | Claim ✅ |

### Claim — `profile-claim`, all 11 required (min ≥ 1) top-level elements

`identifier`, `status`, `type`, `use`, `patient`, `created`, `insurer`,
`provider`, `priority`, `insurance`, `item` — **all present**.

Fixed/pattern values both satisfied:

| Element | Required pattern | WellAuth |
|---|---|---|
| `Claim.status` | `active` | `active` ✅ |
| `Claim.use` | `preauthorization` | `preauthorization` ✅ |

**Result: the artifact satisfies the cardinality and fixed-value constraints of
the PAS 2.2.1 Claim and request-bundle profiles, checked against the official
package.**

## 2. Full IG validation — NOT COMPLETED

The official HL7 validator was run twice and **did not produce a verdict**:

```sh
java -jar validator_cli.jar docs/gate3/outgoing-pas-request.json \
  -version 4.0.1 -ig hl7.fhir.us.davinci-pas#2.2.1 [-tx n/a]
```

| Run | Config | Outcome |
|---|---|---|
| 1 | terminology enabled | ~25 min, no output, killed |
| 2 | `-tx n/a` | >35 min, no output |

Not a hang and not a network stall — it is CPU-bound in IG loading, never
reaching validation:

```
"main" RUNNABLE  cpu=347430ms elapsed=1522s
  CanonicalResourceManager.see(CanonicalResourceManager.java:375)
  CanonicalResourceManager.register(...)
  BaseWorkerContext.registerResourceFromPackage(...)
  SimpleWorkerContext.loadFromPackage(...)
  IgLoader.loadIg(IgLoader.java:138)   ← nested, recursive dependency load
```

Evidence it is IG load and not terminology: `-tx n/a` changed nothing, and
`lsof` showed no open TCP connections while CPU climbed.

Contributing factor (unconfirmed): the shared package cache holds **56
packages**, including **5 concurrent `us.core` versions** and two `davinci-pas`
versions. Registry fan-out is the leading hypothesis.

Environment: OpenJDK 26.0.2.1 (very new — not an LTS the validator is
routinely tested on), `validator_cli.jar` `latest`, macOS arm64.

Full write-up and open research questions: `docs/gate3/VALIDATOR-CHALLENGE.md`.

## 3. Known deviations — stated, not hidden

1. **Response shape.** PAS defines `Claim/$submit` as returning a `Bundle`
   (a PAS response bundle containing a `ClaimResponse`). The simulator returns
   a bare `ClaimResponse`. The provider persists the payer decision correctly
   either way, but this is **not** PAS response-bundle conformant.
2. **No PAS extensions.** The artifact does not carry
   `extension-requestedService`, `extension-itemRequestedServiceDate`,
   `extension-serviceItemRequestType` or the PAS `identifier` slicing. Adding
   them without validator feedback would be guesswork dressed as conformance.
3. **Profile assertions not run.** `meta.profile` is not stamped on the Bundle
   or Claim, precisely because full profile validation has not passed. Claiming
   a profile the artifact has not been validated against would be the wrong
   direction of error.
4. **Terminology not verified.** No code-system membership or value-set binding
   was checked, in either run.

## 4. The claim WellAuth is entitled to make

> **PAS-shaped FHIR R4 prior-authorization request.** The outgoing artifact is
> a `collection` Bundle whose first entry is a `Claim` with
> `use = preauthorization`, transmitted to `Claim/$submit` — the operation the
> official PAS 2.2.1 package defines for this purpose. It satisfies the
> cardinality and fixed-value constraints of the PAS 2.2.1 `profile-claim` and
> `profile-pas-request-bundle`, verified against the official package.

WellAuth does **NOT** claim:

- "validates against PAS 2.2.1" — the validator never returned a verdict;
- PAS conformance or certification;
- trading-partner, X12 278 or clearinghouse conformance;
- terminology or value-set conformance.

**Gate 3 P0.19 verdict: PASS WITH LIMITATIONS.** Structural conformance to the
named profiles is established from the official package; full IG validation is
unresolved and is the one open item in Gate 3.
