// Compact in-product representation of what the assistant can do right now.
//
// The list is the server's `availableTools` mapped to healthcare labels --
// nothing else. It is never computed from workflow state, and a capability that
// is absent is simply not drawn: there is no disabled chip, because there is no
// capability to disable. That absence is the product's point.
//
// CAPABILITY REVEAL (design delta)
//   Three visual tiers, all derived from the REAL availableTools list:
//     read-only  -- subdued; the assistant can look but not change anything;
//     primary    -- the emphasized next capability for this state;
//     new        -- just appeared, carries a temporary NEW marker and a
//                   plain-language reason it became available.
//   The tiers are presentation only. They never gate anything, never predict a
//   capability, and never render a capability the server did not grant.
//
// Raw WebMCP tool names never appear in product-facing copy.

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

/** Capabilities that mark a hero unlock, so a fresh row earns its NEW marker. */
const HERO = new Set([
  'prepare_prior_authorization',
  'submit_prior_authorization',
  'resolve_authorization_window',
  'submit_authorization_extension',
])

/**
 * Capabilities that change nothing. Kept in step with the tool registry's
 * `readOnlyHint` -- a mutation must never be dressed as read-only, because the
 * subdued treatment is a claim about what the capability DOES.
 */
const READ_ONLY = new Set([
  'get_order_context',
  'find_supporting_evidence',
  'inspect_evidence',
  'check_authorization_status',
])

/**
 * The emphasized next capability for a given state, when one is unambiguous.
 * Presentation only: this never grants, orders or predicts a capability -- the
 * name is emphasized ONLY if the server already listed it in availableTools.
 */
function primaryFor(snap: Snapshot): string | null {
  const phase = snap.act2?.phase
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') return 'resolve_authorization_window'
  if (phase === 'REMEDIATION_APPROVED') return 'submit_authorization_extension'
  if (phase) return null
  if (snap.state === 'APPROVED' && !snap.submission) return 'submit_prior_authorization'
  if (snap.state === 'PACKET_COMPLETE') return 'prepare_prior_authorization'
  if (snap.state === 'CONTEXT_READY') return 'discover_coverage_requirements'
  if (snap.state === 'REQUIREMENTS_RESOLVED') return 'find_supporting_evidence'
  return null
}

/**
 * Plain-language reason a capability just became available, in the product's
 * own vocabulary. These describe the AUTHORITATIVE cause -- a human approval,
 * or an external payer result -- never an action the model took.
 */
const REVEAL_REASON: Record<string, string> = {
  submit_prior_authorization:
    'Available because you approved the exact submission.',
  resolve_authorization_window:
    "Available because the payer's authorization ends before the scheduled service.",
  submit_authorization_extension:
    'Available because you approved the exact extension.',
  prepare_prior_authorization:
    'Available because every requirement is now satisfied.',
  find_supporting_evidence:
    "Available because the payer's requirements are now known.",
}

type Tier = 'readonly' | 'primary' | 'new'

/** Classifies one capability for presentation. Pure, and exported for tests. */
export function tierOf(
  name: string,
  { primary, fresh }: { primary: string | null; fresh: string | null },
): Tier | null {
  if (name === fresh && HERO.has(name)) return 'new'
  if (name === primary) return 'primary'
  if (READ_ONLY.has(name)) return 'readonly'
  return null
}

type Verb = { text: string; tone: 'neutral' | 'working' | 'blocked' }

/**
 * The assistant's posture, derived from authoritative state in the same
 * precedence the lower region uses: act2.phase -> submission -> state.
 */
function posture(
  snap: Snapshot,
): { verb: Verb; blocked?: { detail?: string } } {
  const phase = snap.act2?.phase

  if (phase === 'REMEDIATION_PREPARED') {
    return {
      verb: { text: 'Awaiting approval', tone: 'blocked' },
      blocked: {},
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
      verb: { text: 'Awaiting approval', tone: 'blocked' },
      blocked: {
        detail:
          'Evidence tools remain — editing would invalidate the prepared packet.',
      },
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
  const primary = primaryFor(snap)

  return (
    <div className="assistant">
      <div className="assistant-head">
        <span className="section-title">Assistant</span>
        <span className={`verb ${verb.tone}`} data-testid="assistant-state">
          {verb.text}
        </span>
      </div>

      {/* P1-2 / P1-4: name the owner of these actions explicitly. They belong
          to the external assistant; the workforce user's own actions are the
          filled buttons in the review region below, and nowhere else. */}
      <div className="eyebrow">Available to the assistant</div>

      {snap.availableTools.length > 0 && (
        <div className="actions" data-testid="cap-list">
          {snap.availableTools.map((name) => {
            const tier = tierOf(name, { primary, fresh: unlockCue })
            const isNew = tier === 'new'
            return (
              <div key={name}>
                <span
                  className={`action${tier ? ` ${tier}` : ''}`}
                  data-testid={`cap-${name}`}
                  data-tier={tier ?? 'default'}
                >
                  {isNew && <span className="badge">NEW</span>}
                  {toolLabel(name)}
                </span>

                {/* The reveal reason, in plain language, directly beneath the
                    capability it explains. Rendered only while the capability
                    is genuinely fresh, and only from an authoritative cause. */}
                {isNew && REVEAL_REASON[name] && (
                  <div className="reveal-reason" data-testid={`reveal-${name}`}>
                    {REVEAL_REASON[name]}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {blocked && (
        <div className="blocked-note" data-testid="blocked-note">
          {/* At a human gate the headline is the STATE, and the second line is
              the consequence for the assistant. No disabled submit capability
              is drawn, because none exists to disable. */}
          <div className="blocked-head">Awaiting human approval</div>
          <div className="blocked-sub">No submission action available</div>
          {blocked.detail && <div className="blocked-detail">{blocked.detail}</div>}
        </div>
      )}

      {/* P1-4: the boundary, stated once, in the assistant's own panel. This is
          the product thesis in one line -- capabilities are granted by
          workflow state, not chosen by the model. */}
      <div className="cap-note">
        Granted by workflow state · not chosen by the assistant
      </div>
    </div>
  )
}
