// Compact in-product representation of what the assistant can do right now.
//
// This is NOT a chat panel and NOT a tool debugger. It shows the capability
// posture in healthcare language ("Assistant", not "agent"; "Attach evidence",
// not "attach_evidence"), because that is what the clinical user needs to see.
// The raw WebMCP names appear only in the transient unlock cue, which is a
// deliberate demo affordance.

import type { Snapshot } from './capabilities'

/** Healthcare-facing labels for agent capabilities. */
const LABELS: Record<string, string> = {
  get_order_context: 'Review order context',
  discover_coverage_requirements: 'Discover payer requirements',
  find_supporting_evidence: 'Find supporting evidence',
  inspect_evidence: 'Inspect evidence',
  attach_evidence: 'Attach existing evidence',
  remove_evidence: 'Remove attached evidence',
  prepare_prior_authorization: 'Prepare submission',
  submit_prior_authorization: 'Submit to payer',
  check_authorization_status: 'Check authorization status',
  resolve_authorization_window: 'Resolve authorization window',
  submit_authorization_extension: 'Submit extension',
}

interface Posture {
  tone: 'ready' | 'blocked' | 'done'
  headline: string
  detail?: string
}

/** Assistant posture, derived entirely from server-authoritative state. */
function posture(snap: Snapshot): Posture {
  const phase = snap.act2?.phase

  if (phase === 'AUTHORIZATION_ALIGNED') {
    return { tone: 'done', headline: 'Complete', detail: 'No further action available.' }
  }
  if (phase === 'REMEDIATION_SUBMITTED') {
    return { tone: 'done', headline: 'Monitoring', detail: 'Awaiting simulated payer update.' }
  }
  if (phase === 'REMEDIATION_APPROVED') {
    return { tone: 'ready', headline: 'Ready to submit' }
  }
  if (phase === 'REMEDIATION_PREPARED') {
    return {
      tone: 'blocked',
      headline: 'Blocked',
      detail: 'No submission action available · awaiting your approval',
    }
  }
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') {
    return { tone: 'ready', headline: 'Ready' }
  }
  if (snap.submission) {
    return { tone: 'done', headline: 'Monitoring', detail: 'Awaiting simulated payer response.' }
  }
  if (snap.state === 'PREPARED_AWAITING_APPROVAL') {
    return {
      tone: 'blocked',
      headline: 'Blocked',
      detail: 'No submission action available · awaiting your approval',
    }
  }
  if (snap.state === 'APPROVED') return { tone: 'ready', headline: 'Ready to submit' }
  return { tone: 'ready', headline: 'Ready' }
}

export function Assistant({
  snap, unlockCue, registered,
}: {
  snap: Snapshot
  unlockCue: string | null
  registered: string[]
}) {
  const p = posture(snap)
  // Registered-with-browser is shown so a judge can see the page's own claim
  // and the DevTools WebMCP pane agree.
  const live = registered.length > 0

  return (
    <section className="panel" aria-label="Assistant">
      <div className="panel-head"><h2>Assistant</h2></div>
      <div className="panel-body">
        <div className="assistant-state">
          <span className={`dot-i dot-${p.tone}`} aria-hidden="true" />
          <span data-testid="assistant-state">{p.headline}</span>
        </div>
        {p.detail && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{p.detail}</div>}

        <ul className="cap-list" data-testid="cap-list">
          {snap.availableTools.map((t) => (
            <li key={t}>{LABELS[t] ?? t}</li>
          ))}
        </ul>

        {unlockCue && (
          <div className="unlock-cue" data-testid="unlock-cue" role="status">
            WebMCP action unlocked · {LABELS[unlockCue] ?? unlockCue}
          </div>
        )}

        <p className="notice">
          {live
            ? `${registered.length} capabilities registered with this browser.`
            : 'WebMCP not detected — the list above is the server’s authoritative inventory.'}
        </p>
      </div>
    </section>
  )
}
