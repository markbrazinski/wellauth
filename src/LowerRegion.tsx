// The transforming lower region.
//
// Selection precedence is act2.phase -> submission -> state, which is the real
// precedence in the backend: `state` stays APPROVED for the whole submission and
// Act II lifecycle, because the approval is the thing being consumed. Reading
// `state` first would strand the page on "Approved for submission" through the
// entire payer exchange.
//
// Exactly two controls in here are human progression: Approve submission and
// Approve extension request. Neither transmits. Agent capabilities are never
// rendered as clickable buttons.

import type { Disclosure, Snapshot } from './capabilities'

interface Props {
  snap: Snapshot
  disclosure: Disclosure | null
  busy: boolean
  fmtDate: (iso?: string | null) => string
  onApproveSubmission: () => void
  onApproveRemediation: () => void
}

/**
 * P1-3: human-facing reason from the frozen manifest's inclusionReason.
 *
 * The manifest stores the deterministic match rule; the review surface is read
 * by a prior-auth coordinator, so the rule is phrased operationally rather
 * than as an implementation identifier. Unknown rules fall back to the raw
 * value rather than being hidden -- the disclosure must stay complete.
 */
const REASON_TEXT: Record<string, string> = {
  'structured-resource-path': 'matched the structured record',
  'alternate-document-path': 'located in the clinical notes',
}

function reasonOf(inclusionReason: string): string {
  const rule = inclusionReason.split(':').pop() ?? inclusionReason
  return REASON_TEXT[rule] ?? rule.replace(/-/g, ' ')
}

/** P1-3: same human source vocabulary the requirements list uses. */
const SOURCE_LABEL: Record<string, string> = {
  Condition: 'Problem list',
  DiagnosticReport: 'Diagnostic report',
  DocumentReference: 'Clinical note',
  PractitionerRole: 'Provider credential',
  Coverage: 'Member coverage',
  Observation: 'Observation',
}

const sourceLabel = (resourceType: string) => SOURCE_LABEL[resourceType] ?? resourceType

export function LowerRegion(p: Props) {
  const { snap } = p
  const phase = snap.act2?.phase
  const sub = snap.submission

  // --- Act II first: it is the outermost axis. ---
  if (phase === 'AUTHORIZATION_ALIGNED') return <Aligned {...p} />
  if (phase === 'REMEDIATION_SUBMITTING' || phase === 'REMEDIATION_SUBMITTED') {
    return <RemediationPending />
  }
  if (phase === 'REMEDIATION_APPROVED') return <RemediationApproved {...p} />
  if (phase === 'REMEDIATION_PREPARED') return <RemediationReview {...p} />
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') return <CoverageGap {...p} />

  // --- then submission ---
  if (sub && sub.state !== 'FAILED') {
    if (sub.state === 'COMPLETE') return <PayerDecision {...p} />
    if (sub.state === 'UNKNOWN_SUBMISSION_OUTCOME') return <UnknownOutcome {...p} />
    return <SubmittedPending {...p} />
  }
  if (sub?.state === 'FAILED') return <SubmissionFailed {...p} />

  // --- then Act I state ---
  if (snap.state === 'APPROVED') return <ApprovedForSubmission {...p} />
  if (snap.state === 'PREPARED_AWAITING_APPROVAL') return <DisclosureReview {...p} />
  return <PreSubmission {...p} />
}

/* ---------- Act I ---------- */

function PreSubmission({ snap }: Props) {
  const { satisfied, required } = snap.completeness
  const discovered = snap.requirements.length > 0
  const ready = snap.state === 'PACKET_COMPLETE'
  const missing = required - satisfied

  const msg = !discovered
    ? 'Discover the payer requirements to begin.'
    : ready
      ? 'All requirements are satisfied. The assistant can now prepare the submission for your review.'
      : satisfied === 0
        ? `${required} of ${required} requirements still need evidence.`
        : missing === 1
          ? `1 of ${required} requirements still needs evidence.`
          : `${missing} of ${required} requirements still need evidence.`

  return (
    <div className="lower">
      <div className="lower-strip">
        <span className="label" style={{ margin: 0 }}>Submission</span>
        <span className="divider" style={{ width: 1, height: 20, background: 'var(--hairline)' }} />
        <span className={`lower-msg${ready ? ' ready' : ''}`} data-testid="lower-state">
          {msg}
        </span>
        {/* An affordance, not a button: preparing is the assistant's action. */}
        {ready && (
          <span className="badge-ready" style={{ marginLeft: 'auto' }}>
            Available to the assistant · Prepare submission
          </span>
        )}
      </div>
    </div>
  )
}

function DisclosureReview({ snap, disclosure, busy, onApproveSubmission }: Props) {
  const items = disclosure?.items ?? []
  const labelFor = (requirementId: string) =>
    snap.requirements.find((r) => r.id === requirementId)?.label ?? requirementId

  return (
    <div className="lower">
      <div className="lower-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
          <span className="lower-title" data-testid="lower-state">Proposed disclosure</span>
          <span className="lower-sub">
            review before approving · the assistant cannot submit
          </span>
        </div>

        <div className="review-cols">
          <div className="review-left">
            <div className="meta-label">
              {items.length} evidence item{items.length === 1 ? '' : 's'} · why each is included
            </div>
            <div className="disclosure-grid" data-testid="disclosure-items">
              {items.map((i) => (
                <div className="disclosure-item" key={i.requirementId}>
                  <span className="marker" aria-hidden="true" />
                  <div>
                    <span className="name">{labelFor(i.requirementId)}</span>
                    <span className="reason" title={`${i.resourceType} · version ${i.sourceVersionId}`}>
                      {' '}— {sourceLabel(i.resourceType)} · {reasonOf(i.inclusionReason)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="review-rule" />

          <div className="review-right">
            <div className="meta-row">
              <div>
                <div className="meta-label">Destination</div>
                <div className="meta-value">{disclosure?.destination ?? snap.payer}</div>
              </div>
              <div>
                <div className="meta-label">Purpose</div>
                <div className="meta-value">Prior authorization</div>
              </div>
            </div>

            {disclosure?.exclusionPolicy && (
              <div className="policy-line">
                <span className="k">Excluded · </span>
                {disclosure.exclusionPolicy.excludes.join(', ').replace(/-/g, ' ')}.
              </div>
            )}

            {snap.packetHash && (
              <div className="policy-line" title={snap.packetHash}>
                <span className="k">Packet · </span>
                {snap.packetHash.slice(0, 18)}…
              </div>
            )}

            <div className="approve-row">
              <button
                className="approve"
                data-testid="approve-submission"
                onClick={onApproveSubmission}
                disabled={busy}
              >
                Approve submission
              </button>
              <span className="approve-note">
                Approving does not transmit — it authorizes the assistant to submit this exact
                prepared version.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ApprovedForSubmission({ snap }: Props) {
  const a = snap.approval
  return (
    <div className="lower">
      <div className="lower-strip" style={{ animation: 'softIn .45s both' }}>
        <span className="tick-lg" aria-hidden="true">✓</span>
        <div>
          <div className="headline" data-testid="lower-state">Approved for submission</div>
          <div className="subline">
            Authorized by {a?.approvedBy ?? '—'}
            {a?.role ? ` (${a.role})` : ''}
            {a?.packetHash ? ` · bound to packet ${a.packetHash.slice(7, 15)}` : ''}
          </div>
        </div>
        <span className="trailing">The assistant can now submit.</span>
      </div>
    </div>
  )
}

function SubmittedPending({ snap }: Props) {
  return (
    <div className="lower">
      <div className="lower-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="pending-dot" aria-hidden="true" />
          <div>
            <div className="headline" data-testid="lower-state">
              Submitted to simulated payer · pending
            </div>
            <div className="subline">
              Monitoring {snap.payer} for a response · claim {snap.submission?.claimIdentifier} ·{' '}
              {snap.submission?.attempts} transmission
              {snap.submission?.attempts === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="sweep" aria-hidden="true"><span /></div>
      </div>
    </div>
  )
}

/**
 * Payer answered but no coverage gap was found -- the ordinary terminal Act I
 * outcome. Kept distinct from the gap screen so an approval that genuinely
 * covers the date is not dressed up as a problem.
 */
function PayerDecision({ snap }: Props) {
  const approved = snap.submission?.payerStatus === 'approved'
  return (
    <div className="lower">
      <div className="lower-inner">
        <div className="payer-eyebrow">Simulated payer response</div>
        <div className="gap-row">
          <div className="gap-cell">
            <span className={approved ? 'tick-md' : 'warn-md'} aria-hidden="true">
              {approved ? '✓' : '!'}
            </span>
            <div>
              <div className="gap-label">Payer decision</div>
              <div className="gap-value" data-testid="payer-decision">
                {approved ? 'Approved' : 'Denied'}
              </div>
            </div>
          </div>
          <div className="gap-right">
            <div className="gap-dates">
              Reference <strong>{snap.submission?.payerReference ?? '—'}</strong>
            </div>
            <div className="gap-explain">
              Decision recorded by a simulated payer. No real payer was contacted.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SubmissionFailed({ snap }: Props) {
  return (
    <div className="lower">
      <div className="lower-inner">
        <div className="refusal-row">
          <span className="warn-md" aria-hidden="true">!</span>
          <div style={{ flex: 1 }}>
            <div className="headline" data-testid="lower-state">
              Payer refused the submission before recording it
            </div>
            <div className="subline">
              Nothing was recorded by {snap.payer}. Evidence editing has re-opened.
            </div>
          </div>
          <span className="refusal-chip">Not accepted</span>
        </div>
      </div>
    </div>
  )
}

/** Ambiguous transport. Never auto-retried -- it needs explicit reconciliation. */
function UnknownOutcome({ snap }: Props) {
  return (
    <div className="lower">
      <div className="lower-inner">
        <div className="refusal-row">
          <span className="warn-md" aria-hidden="true">!</span>
          <div style={{ flex: 1 }}>
            <div className="headline" data-testid="lower-state">
              Submission outcome unknown — reconciliation required
            </div>
            <div className="subline">
              {snap.payer} may or may not hold this request. It will not be resubmitted
              automatically.
            </div>
          </div>
          <span className="refusal-chip">Needs reconciliation</span>
        </div>
      </div>
    </div>
  )
}

/* ---------- Act II ---------- */

function CoverageGap({ snap, fmtDate }: Props) {
  const align = snap.act2?.alignment
  const canResolve = snap.availableTools.includes('resolve_authorization_window')

  return (
    <div className="lower">
      <div className="lower-inner">
        <div className="payer-eyebrow">Simulated payer response</div>

        <div className="gap-row">
          <div className="gap-cell">
            <span className="tick-md" aria-hidden="true">✓</span>
            <div>
              <div className="gap-label">Payer decision</div>
              <div className="gap-value" data-testid="payer-decision">Approved</div>
            </div>
          </div>

          <div className="gap-rule" />

          <div className="gap-cell">
            <span className="warn-md" aria-hidden="true">!</span>
            <div>
              <div className="gap-label">Coverage of scheduled service</div>
              <div className="gap-value warn" data-testid="coverage-state">
                Does not cover scheduled date
              </div>
            </div>
          </div>

          <div className="gap-right">
            <div className="gap-dates">
              Authorization valid through <strong>{fmtDate(align?.validThrough)}</strong> · MRI
              scheduled <strong className="warn">{fmtDate(align?.scheduledServiceDate)}</strong>
            </div>
            <div className="gap-explain">
              The payer approved, but the ordered care remains administratively blocked.
            </div>
          </div>
        </div>

        {/* The capability appeared because of the payer's own response -- not
            because the browser did anything. */}
        {canResolve && (
          <div className="gap-action">
            <span className="badge-ready">
              Available to the assistant · Resolve authorization window
            </span>
            <span className="gap-action-note">
              WellAuth evaluated the payer result against the scheduled service and exposed a new
              bounded action.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function RemediationReview({ snap, busy, fmtDate, onApproveRemediation }: Props) {
  const r = snap.remediation
  return (
    <div className="lower">
      <div className="lower-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
          <span className="lower-title" data-testid="lower-state">
            Proposed remediation — authorization window
          </span>
          <span className="lower-sub">review before approving · the assistant cannot submit</span>
        </div>

        <div className="review-cols">
          <div className="rem-grid">
            <div>
              <div className="meta-label">Current authorization</div>
              <div className="rem-value" data-testid="rem-current">
                Valid through {fmtDate(r?.currentValidThrough)}
              </div>
            </div>
            <div>
              <div className="meta-label">Scheduled MRI</div>
              <div className="rem-value warn">{fmtDate(r?.scheduledServiceDate)}</div>
            </div>
            <div>
              <div className="meta-label">Requested change</div>
              <div className="rem-value request" data-testid="rem-requested">
                Extend validity through {fmtDate(r?.requestedValidThrough)}
              </div>
            </div>
            <div>
              <div className="meta-label">Reason</div>
              <div className="rem-reason">{r?.reasonDisplay}</div>
            </div>
          </div>

          <div className="review-rule" />

          <div className="review-right">
            {/* Rendered literally from the three explicit false flags, not
                paraphrased -- this is the honest answer to "what am I
                authorizing?". */}
            <div className="policy-line">
              <span className="k">Unchanged · </span>
              ordered service, clinical evidence, and medical intent. Administrative correction
              only — no clinical reconsideration.
            </div>

            {r?.hash && (
              <div className="policy-line" title={r.hash}>
                <span className="k">Request · </span>
                {r.hash.slice(0, 18)}…
              </div>
            )}

            <div className="approve-row">
              <button
                className="approve"
                data-testid="approve-remediation"
                onClick={onApproveRemediation}
                disabled={busy}
              >
                Approve extension request
              </button>
              <span className="approve-note">
                Approving does not transmit — it authorizes the assistant to submit this exact
                request.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RemediationApproved({ snap }: Props) {
  const a = snap.remediation?.approval
  return (
    <div className="lower">
      <div className="lower-strip" style={{ animation: 'softIn .45s both' }}>
        <span className="tick-lg" aria-hidden="true">✓</span>
        <div>
          <div className="headline" data-testid="lower-state">Extension approved for submission</div>
          <div className="subline">
            Authorized by {a?.approvedBy ?? '—'}
            {a?.role ? ` (${a.role})` : ''}
            {snap.remediation?.hash ? ` · bound to request ${snap.remediation.hash.slice(7, 15)}` : ''}
          </div>
        </div>
        <span className="trailing">The assistant can now submit the extension.</span>
      </div>
    </div>
  )
}

function RemediationPending() {
  return (
    <div className="lower">
      <div className="lower-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="pending-dot" aria-hidden="true" />
          <div>
            <div className="headline" data-testid="lower-state">
              Remediation submitted to simulated payer · pending
            </div>
            <div className="subline">Monitoring for an updated authorization…</div>
          </div>
        </div>
        <div className="sweep" aria-hidden="true"><span /></div>
      </div>
    </div>
  )
}

function Aligned({ snap, fmtDate }: Props) {
  const r = snap.remediation
  return (
    <div className="lower">
      <div className="lower-inner">
        <div className="payer-eyebrow aligned">Simulated payer · authorization updated</div>
        <div className="gap-row">
          <div className="gap-cell">
            <span className="tick-md" aria-hidden="true">✓</span>
            <div>
              <div className="gap-label">Scheduled MRI</div>
              <div className="gap-value met" data-testid="final-coverage">
                Covered by authorization
              </div>
            </div>
          </div>

          <div className="gap-rule" />

          <div>
            <div className="gap-label">Administrative readiness</div>
            <div className="gap-value" data-testid="final-readiness">Ready</div>
          </div>

          <div className="gap-right">
            <div className="final-ref">
              #{r?.payerAuthorizationReference ?? '—'} · EXT
            </div>
            {/* Validity comes from remediation.currentValidThrough -- the
                same durable field check_authorization_status now reports as
                the EFFECTIVE window, so the page and the tool agree (P0-2). */}
            <div className="final-validity">
              Valid through {fmtDate(r?.currentValidThrough)} · covers{' '}
              {fmtDate(r?.scheduledServiceDate)} MRI
            </div>
            <div className="final-note">
              Administrative alignment only — not a clinical determination.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
