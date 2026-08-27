// Compact in-product representation of what the assistant can do right now.
//
// The chip list is the server's `availableTools` mapped to healthcare labels --
// nothing else. It is never computed from workflow state, and a capability that
// is absent is simply not drawn: there is no disabled chip, because there is no
// capability to disable. That absence is the product's point.
//
// Raw WebMCP tool names never appear here. They are acceptable only in the
// transient unlock cue, which is explicitly a demo affordance.

import type { Snapshot } from './capabilities'

/** Implementation name -> user-facing label (INTEGRATION-CONTRACT §3.2). */
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

export function toolLabel(name: string): string {
  return LABELS[name] ?? name
}

/** Capabilities that mark a hero unlock, so a fresh chip earns its badge. */
const HERO = new Set([
  'prepare_prior_authorization',
  'submit_prior_authorization',
  'resolve_authorization_window',
  'submit_authorization_extension',
])

type Verb = { text: string; tone: 'neutral' | 'working' | 'blocked' }

/**
 * The assistant's posture, derived from authoritative state in the same
 * precedence the lower region uses: act2.phase -> submission -> state.
 */
function posture(snap: Snapshot): { verb: Verb; blocked?: string } {
  const phase = snap.act2?.phase

  if (phase === 'REMEDIATION_PREPARED') {
    return {
      verb: { text: 'Blocked', tone: 'blocked' },
      blocked: 'No submission action available · awaiting your approval.',
    }
  }
  if (phase === 'REMEDIATION_APPROVED') return { verb: { text: 'Ready to submit', tone: 'neutral' } }
  if (phase === 'REMEDIATION_SUBMITTING' || phase === 'REMEDIATION_SUBMITTED') {
    return { verb: { text: 'Monitoring', tone: 'neutral' } }
  }
  if (phase === 'AUTHORIZATION_ALIGNED') return { verb: { text: 'Idle', tone: 'neutral' } }
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') return { verb: { text: 'Ready', tone: 'neutral' } }

  if (snap.submission && snap.submission.state !== 'FAILED') {
    return { verb: { text: 'Monitoring', tone: 'neutral' } }
  }

  if (snap.state === 'PREPARED_AWAITING_APPROVAL') {
    return {
      verb: { text: 'Blocked', tone: 'blocked' },
      blocked:
        'No submission action available · awaiting your approval. Evidence tools remain — ' +
        'editing would invalidate the prepared packet.',
    }
  }
  if (snap.state === 'APPROVED') return { verb: { text: 'Ready to submit', tone: 'neutral' } }
  if (snap.state === 'PACKET_COMPLETE') return { verb: { text: 'Ready', tone: 'neutral' } }
  if (snap.state === 'REQUIREMENTS_RESOLVED') return { verb: { text: 'Working', tone: 'working' } }
  return { verb: { text: 'Ready', tone: 'neutral' } }
}

export function Assistant({
  snap,
  unlockCue,
}: {
  snap: Snapshot
  unlockCue: string | null
}) {
  const { verb, blocked } = posture(snap)

  return (
    <div className="assistant">
      <div className="assistant-head">
        <span className="section-title">Assistant</span>
        <span className={`verb ${verb.tone}`} data-testid="assistant-state">
          {verb.text}
        </span>
      </div>

      <div className="eyebrow">Available actions</div>

      {snap.availableTools.length > 0 && (
        <div className="actions" data-testid="cap-list">
          {snap.availableTools.map((name) => {
            const fresh = name === unlockCue
            return (
              <span className={`action${fresh ? ' fresh' : ''}`} key={name}>
                {fresh && HERO.has(name) && <span className="badge">NEW</span>}
                {toolLabel(name)}
              </span>
            )
          })}
        </div>
      )}

      {blocked && <div className="blocked-note">{blocked}</div>}
    </div>
  )
}
