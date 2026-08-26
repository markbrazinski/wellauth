# Open problem — HL7 FHIR validator will not complete against Da Vinci PAS 2.2.1

Everything else in Gate 3 is finished and green. This is the **single** open
item. We need a real validation verdict on one 8 KB FHIR Bundle, and the
official validator has not produced one in ~25 minutes of wall time.

## What we are trying to do

Validate one file against the Da Vinci PAS 2.2.1 implementation guide, to
decide honestly whether WellAuth may claim:

> "The demonstrated synthetic request validates against the named PAS 2.2.1
> profiles tested."

or must fall back to the weaker, safer claim:

> "PAS-shaped FHIR R4 request."

We will not claim conformance without validator evidence, so the outcome of
this command directly decides the wording of the Gate 3 report.

## The artifact

`docs/gate3/outgoing-pas-request.json` — 8,043 bytes, 10 entries.

- `Bundle.type = collection`
- entry[0] = `Claim`, `use = preauthorization`, one item, 5 `supportingInfo`
- plus Patient, Practitioner, PractitionerRole, 2× Organization, Coverage,
  Condition, DiagnosticReport, DocumentReference
- every reference resolves inside the bundle
- entirely synthetic data

## The command

```sh
java -jar ~/fhir-validator/validator_cli.jar \
  docs/gate3/outgoing-pas-request.json \
  -version 4.0.1 \
  -ig hl7.fhir.us.davinci-pas#2.2.1 \
  -tx n/a \
  -output docs/gate3/pas-validation-notx.json
```

## Environment

| | |
|---|---|
| Machine | macOS 24.3.0, Apple Silicon |
| Java | OpenJDK 26.0.2.1 (Homebrew) — **note: very new** |
| Validator | `validator_cli.jar`, 179 MB, downloaded from `hapifhir/org.hl7.fhir.core` **latest** release |
| Package cache | `~/.fhir/packages`, 3.6 GB, ~51 packages incl. `hl7.fhir.us.davinci-pas#2.2.1`, `#2.1.0`, davinci-crd, cdex, us.core 3.1.1/6.1.0/7.0.0 |
| JVM heap | not set — default max heap |

## What we observed

Run 1 (with terminology, no `-tx n/a`): ~25 min, no output file, killed.
Run 2 (`-tx n/a`): still running at 7:42 CPU / 25 min elapsed when written up.

The process is **CPU-bound, not blocked**:

- `lsof` shows **no** open TCP connections → not waiting on `tx.fhir.org`
- no writes under `~/.fhir` for minutes → not still downloading
- CPU climbs steadily at ~23% of a core
- `-tx n/a` did **not** change the behaviour, which is itself the clue: the
  cost is *before* terminology, during IG load

`jstack` of the real Java PID:

```
"main" #3 prio=5 cpu=347430.73ms elapsed=1522.04s nid=6147 runnable
   java.lang.Thread.State: RUNNABLE
	at org.hl7.fhir.r5.context.CanonicalResourceManager.see(CanonicalResourceManager.java:375)
	at org.hl7.fhir.r5.context.CanonicalResourceManager.register(CanonicalResourceManager.java:316)
	at org.hl7.fhir.r5.context.BaseWorkerContext.registerResource(BaseWorkerContext.java:472)
	at org.hl7.fhir.r5.context.BaseWorkerContext.registerResourceFromPackage(BaseWorkerContext.java:431)
	at org.hl7.fhir.r5.context.SimpleWorkerContext.loadFromPackageInt(SimpleWorkerContext.java:643)
	at org.hl7.fhir.r5.context.SimpleWorkerContext.loadFromPackage(SimpleWorkerContext.java:539)
	at org.hl7.fhir.validation.IgLoader.loadIg(IgLoader.java:149)
	at org.hl7.fhir.validation.IgLoader.loadIg(IgLoader.java:138)
	at org.hl7.fhir.validation.IgLoader.loadIg(IgLoader.java:138)
	at org.hl7.fhir.validation.IgLoader.loadIg(IgLoader.java:138)
```

It never reaches validation. It is stuck **registering canonical resources
while recursively loading the PAS dependency tree** — the nested `loadIg`
frames are PAS pulling in its dependencies pulling in theirs.

## The actual question

**Why does IG loading for `hl7.fhir.us.davinci-pas#2.2.1` never finish, and
what is the known-good way to validate one small Bundle against PAS 2.2.1?**

Sub-questions worth checking:

1. **Is `CanonicalResourceManager.see()` a known super-linear hot spot?** The
   stack sits in `see()` → `register()`. Is there an open
   `hapifhir/org.hl7.fhir.core` issue about IG load time blowing up when many
   packages / multiple us.core versions are present? Is it quadratic in the
   number of already-registered canonicals?

2. **Is a 3.6 GB / 51-package cache the problem?** Would a clean `~/.fhir`
   containing only PAS 2.2.1 + its exact dependencies load fast? We have
   `us.core` 3.1.1, 6.1.0 **and** 7.0.0 plus `davinci-pas` 2.1.0 **and** 2.2.1
   side by side — does version fan-out multiply the canonical registry?

3. **Is OpenJDK 26 the problem?** That is a very new JVM. Is the validator
   known-good only on 11/17/21? Would `-Xmx6g` or a supported LTS JDK fix it —
   i.e. is this actually GC thrash rather than algorithmic cost? (Default heap
   on this machine may be small relative to a 3.6 GB package tree.)

4. **Is `latest` the wrong validator build?** Should we pin a specific known-good
   `validator_cli.jar` release rather than `latest`?

5. **Is there a faster supported path?** e.g.
   - `-ig` pointing at the local `.tgz` instead of resolving from the registry
   - `java -jar validator_cli.jar -help` flags that skip snapshot generation
   - validating against the specific PAS **profile** URL via `-profile` rather
     than loading the whole IG
   - the HL7 hosted validator UI (`validator.fhir.org`) as a cross-check for a
     single 8 KB file

## What "solved" looks like

Any one of:

- a command that completes and writes an OperationOutcome we can cite; or
- authoritative confirmation that full PAS 2.2.1 IG validation is impractical
  in this setup, so we correctly record P0.19 as PASS WITH LIMITATIONS and
  claim only "PAS-shaped".

Either answer is genuinely fine. What we must not do is claim conformance we
did not verify.

## Not the question

- Whether the bundle is *structurally* PAS-shaped — already asserted in-code by
  P0.19 (Claim first, `use=preauthorization`, stable identifier, patient /
  insurer / coverage / provider references, ordered service unchanged) and by
  P0.18 (minimum-necessary, no decoys, all references resolve).
- Whether Gate 3 otherwise passes — it does: 175/175 in-process, 176/176
  deployed, Gate 0/1/2 unregressed.
