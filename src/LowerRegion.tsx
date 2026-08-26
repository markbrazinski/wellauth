// The transforming submission / review region.
//
// ONE region that changes shape with authoritative state. Future-state
// components are never rendered simultaneously: there is no disabled submit
// button standing in for a capability that does not exist, because the whole
// point is that the capability is genuinely absent until a human acts.

import type { Disclosure, Snapshot } from './capabilities'

interface Props {
  snap: Snapshot
  disclosure: Disclosure | null
  busy: boolean
  fmtDate: (iso?: string | null) => string
  onApproveSubmission: () => void
  onApproveRemediation: () => void
}

export function LowerRegion(p: Props) {
  const { snap } = p
  const phase = snap.act2?.phase

  // --- Act II states take precedence once a payer decision exists ---------
  if (phase === 'AUTHORIZATION_ALIGNED') return <Aligned {...p} />
  if (phase === 'REMEDIATION_SUBMITTED') return <RemediationPending />
  if (phase === 'REMEDIATION_APPROVED') return <RemediationApproved {...p} />
  if (phase === 'REMEDIATION_PREPARED') return <RemediationReview {...p} />
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') return <CoverageGap {...p} />

  // --- Act I --------------------------------------------------------------
  if (snap.submission) return <SubmittedPending {...p} />
  if (snap.state === 'APPROVED') return <ApprovedForSubmission {...p} />
  if (snap.state === 'PREPARED_AWAITING_APPROVAL') return <DisclosureReview {...p} />
  if (snap.state === 'PACKET_COMPLETE') return <ReadyToPrepare />
  return <Incomplete snap={snap} />
}

function Panel({ title, children, attention }: {
  title: string; children: React.ReactNode; attention?: boolean
}) {
  return (
    <section className={`panel region${attention ? ' attention' : ''}`} aria-label={title}>
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="panel-body">{children}</div>
    </section>
  )
}

function Incomplete({ snap }: { snap: Snapshot }) {
  const { satisfied, required } = snap.completeness
  const started = snap.requirements.length > 0
  return (
    <Panel title="Submission">
      <div className="blocked">
        <span className="status-chip chip-open">BLOCKED</span>
        <span data-testid="lower-state">
          {started
            ? `${required - satisfied} of ${required} requirements still need evidence. ` +
              'Submission cannot be prepared until every requirement is satisfied.'
            : 'Payer requirements have not been discovered yet.'}
        </span>
      </div>
    </Panel>
  )
}

function ReadyToPrepare() {
  return (
    <Panel title="Submission">
      <div className="blocked">
        <span className="status-chip chip-met">READY</span>
        <span data-testid="lower-state">
          All requirements are satisfied. The assistant can now prepare the submission
          for your review.
        </span>
      </div>
    </Panel>
  )
}

/** The proposed disclosure — exactly what would be sent, before it is sent. */
function DisclosureReview({ snap, disclosure, busy, onApproveSubmission }: Props) {
  return (
    <Panel title="Proposed disclosure" attention>
      <p style={{ margin: '0 0 8px', color: 'var(--ink-2)', fontSize: 13 }}>
        The exact information that would be disclosed to <strong>{snap.payer}</strong>{' '}
        <span className="sim-banner">SIMULATED PAYER</span> for prior-authorization review.
      </p>

      {disclosure && (
        <div data-testid="disclosure-items">
          {disclosure.items.map((it) => (
            <div className="disclosure-item" key={it.requirementId}>
              <span className="rt">{it.resourceType}</span>
              <span>
                {it.requirementId}
                <span style={{ color: 'var(--ink-3)' }}> · version {it.sourceVersionId}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="callout">
        <div className="label">Excluded from this disclosure</div>
        <div style={{ fontSize: 12.5 }}>
          {(disclosure?.exclusionPolicy.excludes ?? []).join(' · ').replace(/-/g, ' ')}
        </div>
      </div>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
                    marginBottom: 10 }}>
        packet {snap.packetHash?.slice(0, 30)}…
      </div>

      <div>
        <button
          className="approve"
          onClick={onApproveSubmission}
          disabled={busy}
          data-testid="approve-submission"
        >
          Approve submission
        </button>
        <p className="approve-note">
          Approving does not transmit — it authorizes the assistant to submit this exact
          request.
        </p>
      </div>
    </Panel>
  )
}

function ApprovedForSubmission({ snap }: Props) {
  return (
    <Panel title="Approved for submission" attention>
      <div className="blocked">
        <span className="status-chip chip-met">APPROVED</span>
        <span data-testid="lower-state">
          Approved by {snap.approval?.approvedBy} ({snap.approval?.role}). The assistant
          now has the capability to submit this exact request.
        </span>
      </div>
    </Panel>
  )
}

function SubmittedPending({ snap }: Props) {
  const denied = snap.submission?.payerStatus === 'denied'
  return (
    <Panel title="Submission">
      <div className="blocked">
        <span className={`status-chip ${denied ? 'chip-alert' : 'chip-open'}`}>
          {denied ? 'DENIED' : 'PENDING'}
        </span>
        <span data-testid="lower-state">
          {denied
            ? 'The simulated payer denied this prior authorization.'
            : 'Submitted to the simulated payer. Awaiting response.'}
        </span>
      </div>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Claim identifier</dt>
        <dd style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
          {snap.submission?.claimIdentifier}
        </dd>
        <dt>Transmissions</dt>
        <dd>{snap.submission?.attempts}</dd>
      </dl>
    </Panel>
  )
}

// --- Act II ----------------------------------------------------------------

/** Approved, but the authorization does not reach the scheduled date. */
function CoverageGap({ snap, fmtDate }: Props) {
  const a = snap.act2.alignment
  return (
    <Panel title="Simulated payer response" attention>
      <div style={{ marginBottom: 12 }}>
        <span className="sim-banner">SIMULATED PAYER</span>
        <div className="value lg" style={{ marginTop: 6 }} data-testid="payer-decision">
          Approved
        </div>
      </div>

      <div className="callout">
        <div className="label">Coverage of scheduled service</div>
        <div className="value" data-testid="coverage-state">Does not cover scheduled date</div>
        <dl className="kv" style={{ marginTop: 9 }}>
          <dt>Authorization valid through</dt>
          <dd>{fmtDate(a?.validThrough)}</dd>
          <dt>MRI scheduled</dt>
          <dd>{fmtDate(a?.scheduledServiceDate)}</dd>
        </dl>
      </div>

      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        The payer approved, but the ordered care remains administratively blocked.
      </p>
    </Panel>
  )
}

/** The exact remediation, shown before a human authorizes it. */
function RemediationReview({ snap, busy, fmtDate, onApproveRemediation }: Props) {
  const r = snap.remediation
  return (
    <Panel title="Proposed remediation — authorization window" attention>
      <dl className="kv">
        <dt>Current authorization</dt>
        <dd data-testid="rem-current">Valid through {fmtDate(r?.currentValidThrough)}</dd>
        <dt>Scheduled MRI</dt>
        <dd>{fmtDate(r?.scheduledServiceDate)}</dd>
        <dt>Requested change</dt>
        <dd data-testid="rem-requested">
          Extend validity through {fmtDate(r?.requestedValidThrough)}
        </dd>
        <dt>Reason</dt>
        <dd>{r?.reasonDisplay}</dd>
      </dl>

      <div className="callout">
        <div className="label">Unchanged</div>
        <div style={{ fontSize: 13 }}>
          Ordered service, clinical evidence, and medical intent.
        </div>
      </div>

      <div>
        <button
          className="approve"
          onClick={onApproveRemediation}
          disabled={busy}
          data-testid="approve-remediation"
        >
          Approve extension request
        </button>
        <p className="approve-note">
          Approving does not transmit — it authorizes the assistant to submit this exact
          request.
        </p>
      </div>
    </Panel>
  )
}

function RemediationApproved({ snap }: Props) {
  return (
    <Panel title="Extension approved for submission" attention>
      <div className="blocked">
        <span className="status-chip chip-met">APPROVED</span>
        <span data-testid="lower-state">
          Approved by {snap.remediation?.approval?.approvedBy}. The assistant now has the
          capability to submit this exact extension request.
        </span>
      </div>
    </Panel>
  )
}

function RemediationPending() {
  return (
    <Panel title="Extension submitted">
      <div className="blocked">
        <span className="status-chip chip-open">PENDING</span>
        <span data-testid="lower-state">
          Remediation submitted to simulated payer · pending
        </span>
      </div>
    </Panel>
  )
}

/** Terminal administrative state. */
function Aligned({ snap, fmtDate }: Props) {
  const r = snap.remediation
  return (
    <Panel title="Simulated payer · authorization updated" attention>
      <span className="sim-banner">SIMULATED PAYER · AUTHORIZATION UPDATED</span>

      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Scheduled MRI</dt>
        <dd className="value" data-testid="final-coverage">Covered by authorization</dd>
        <dt>Administrative readiness</dt>
        <dd className="value" data-testid="final-readiness">Ready</dd>
        <dt>Reference</dt>
        <dd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
          #{r?.payerAuthorizationReference} · EXT
        </dd>
        <dt>Validity</dt>
        <dd>
          Valid through {fmtDate(r?.currentValidThrough)} · covers{' '}
          {fmtDate(r?.scheduledServiceDate)} MRI
        </dd>
      </dl>

      <p className="notice">
        Administrative alignment only — not a clinical determination.
      </p>
    </Panel>
  )
}
