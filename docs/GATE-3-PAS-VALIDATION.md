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
| output parameter type | `Bundle` | PAS response Bundle ✅ |

### Request bundle — `profile-pas-request-bundle`

| Constraint | Required | WellAuth |
|---|---|---|
| `Bundle.type` | pattern `collection` | `collection` ✅ |
| `Bundle.entry` | min 1 | 10 entries ✅ |
| first entry | Claim | Claim ✅ |

### Response bundle — `profile-pas-response-bundle`

| Constraint | Required | WellAuth |
|---|---|---|
| `Bundle.type` | fixed `collection` | `collection` ✅ |
| `Bundle.identifier` | min 1 | receipt id ✅ |
| `Bundle.timestamp` | min 1 | received-at instant ✅ |
| `ClaimResponse` slice | min 1, max 1 | first entry ✅ |

### Claim — `profile-claim`, all 11 required (min ≥ 1) top-level elements

`identifier`, `status`, `type`, `use`, `patient`, `created`, `insurer`,
`provider`, `priority`, `insurance`, `item` — **all present**.

Fixed/pattern values both satisfied:

| Element | Required pattern | WellAuth |
|---|---|---|
| `Claim.status` | `active` | `active` ✅ |
| `Claim.use` | `preauthorization` | `preauthorization` ✅ |

**Result: the exchange satisfies the cardinality and fixed-value constraints of
the PAS 2.2.1 Claim, request-bundle and response-bundle profiles, checked
against the official package.**

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

Full write-up and diagnosis: `docs/gate3/VALIDATOR-CHALLENGE.md`.

**This is closed, not pending.** No further effort will be spent making the
full IG validator complete. The demonstrated exchange is permanently
documented as **PAS-shaped, not PAS-validated**. Structural conformance to the
named profiles is established from the official package (§1) and is enforced
by the Gate 3 suite, so a future regression in shape would be caught even
though full IG validation never ran.

## 3. Known deviations — stated, not hidden

1. **No PAS extensions.** The artifact does not carry
   `extension-requestedService`, `extension-itemRequestedServiceDate`,
   `extension-serviceItemRequestType` or the PAS `identifier` slicing. Adding
   them without validator feedback would be guesswork dressed as conformance.
2. **Profile assertions not run.** `meta.profile` is not stamped on the Bundle
   or Claim, precisely because full profile validation has not passed. Claiming
   a profile the artifact has not been validated against would be the wrong
   direction of error.
3. **Terminology not verified.** No code-system membership or value-set binding
   was checked, in either run.

## 4. The claim WellAuth is entitled to make

> **PAS-shaped FHIR R4 prior-authorization exchange.** The outgoing artifact is
> a `collection` Bundle whose first entry is a `Claim` with
> `use = preauthorization`, transmitted to `Claim/$submit` — the operation the
> official PAS 2.2.1 package defines for this purpose — and the payer replies
> with a PAS-shaped response Bundle carrying the `ClaimResponse`. The exchange
> satisfies the cardinality and fixed-value constraints of the PAS 2.2.1
> `profile-claim`, `profile-pas-request-bundle` and
> `profile-pas-response-bundle`, verified against the official package.

WellAuth does **NOT** claim:

- "validates against PAS 2.2.1" — the validator never returned a verdict;
- PAS conformance or certification;
- trading-partner, X12 278 or clearinghouse conformance;
- terminology or value-set conformance.

**Gate 3 P0.19 verdict: PASS WITH LIMITATIONS — closed.** Structural
conformance to the named profiles is established from the official package and
enforced by the suite. Full IG validation did not complete and will not be
pursued further; the exchange is documented permanently as **PAS-shaped, not
PAS-validated**. This is a deliberate, bounded limitation, not an open task.
