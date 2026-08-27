// One honest timeline for assistant, human and payer events.
//
// It is NOT chat and NOT a raw tool log: every entry is derived from durable
// backend state, so a reload reproduces the same timeline. Nothing is appended
// optimistically by React.
//
// Only three event families carry a durable per-event time -- bindings[].boundAt,
// approval.at and remediation.approval.at. The rest derive from state presence
// and deliberately render without a timestamp rather than inventing one
// (INTEGRATION-CONTRACT §5 / Gap C-3).

import type { Snapshot } from './capabilities'

export type Actor = 'assistant' | 'human' | 'payer' | 'system'

export interface Event {
  who: string
  what: string
  kind: Actor
  at?: string | null
}

const time = (iso?: string | null) => {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/** Derives the timeline from server state alone. */
export function buildActivity(snap: Snapshot): Event[] {
  const out: Event[] = []
  const satisfied = snap.completeness.satisfied

  // Keyed on the workflow having actually left CONTEXT_READY, not on the
  // requirement list being non-empty -- the list is server policy and would
  // otherwise assert a discovery that never occurred.
  if (snap.state !== 'CONTEXT_READY') {
    out.push({ who: 'Assistant', kind: 'assistant', what: 'Discovered payer requirements' })
  }

  // One line per attachment, in binding order, using the durable boundAt.
  for (const b of snap.bindings) {
    out.push({
      who: 'Assistant',
      kind: 'assistant',
      what: b.title
        ? `Attached evidence · ${b.title}`
        : `Attached evidence for ${b.requirementId}`,
      at: b.boundAt,
    })
  }
  if (satisfied === snap.completeness.required && satisfied > 0) {
    out.push({ who: 'WellAuth', kind: 'system', what: `All ${satisfied} requirements satisfied` })
  }

  if (snap.packetHash) {
    out.push({ who: 'Assistant', kind: 'assistant', what: 'Prepared submission for review' })
  }

  if (snap.approval) {
    out.push({
      who: snap.approval.approvedBy,
      kind: 'human',
      what: 'Approved submission',
      at: snap.approval.at,
    })
  }

  if (snap.submission) {
    out.push({
      who: 'Assistant',
      kind: 'assistant',
      what: `Submitted authorization to ${snap.payer} (simulated)`,
      // P2-2: durable submission start, never a render-time clock.
      at: snap.submission.startedAt ?? null,
    })
    if (snap.submission.payerStatus === 'approved') {
      out.push({
        who: 'Simulated payer', kind: 'payer', what: 'Returned Approved',
        at: snap.submission.receivedAt ?? snap.submission.completedAt ?? null,
      })
    } else if (snap.submission.payerStatus === 'denied') {
      out.push({
        who: 'Simulated payer', kind: 'payer', what: 'Returned Denied',
        at: snap.submission.receivedAt ?? snap.submission.completedAt ?? null,
      })
    }
  }

  // --- Act II ---
  const phase = snap.act2?.phase
  if (phase && phase !== 'AUTHORIZATION_ALIGNED') {
    out.push({ who: 'WellAuth', kind: 'system', what: 'Detected authorization-window mismatch' })
    out.push({ who: 'WellAuth', kind: 'system', what: 'Enabled authorization-window remediation' })
  }
  const rem = snap.remediation
  if (rem) {
    out.push({
      who: 'Assistant',
      kind: 'assistant',
      what: 'Prepared authorization-window remediation',
      at: rem.preparedAt ?? null,
    })
    if (rem.approval) {
      out.push({
        who: rem.approval.approvedBy,
        kind: 'human',
        what: 'Approved extension request',
        at: rem.approval.at,
      })
    }
    if (rem.submission?.extensionReceiptId) {
      out.push({
        who: 'Assistant',
        kind: 'assistant',
        what: `Submitted extension to ${snap.payer} (simulated)`,
        at: rem.submission.startedAt ?? null,
      })
    }
  }
  if (phase === 'AUTHORIZATION_ALIGNED' && rem) {
    out.push({
      who: 'Simulated payer', kind: 'payer', what: 'Updated authorization validity',
      at: rem.submission?.completedAt ?? null,
    })
  }

  return out
}

const DOT: Record<Actor, string> = {
  assistant: 'var(--accent)',
  human: 'var(--ink)',
  payer: 'var(--met)',
  system: 'var(--slate)',
}

const WHO_CLASS: Record<Actor, string> = {
  assistant: 'who-assistant',
  human: 'who-human',
  payer: 'who-payer',
  system: 'who-system',
}

/**
 * P2-4: how many newest events stay at full emphasis. Everything older is
 * de-emphasised but NEVER removed -- full auditability is preserved, the
 * timeline scrolls, and no state is truncated or summarised away.
 */
const CURRENT_EVENTS = 3

export function Activity({ events }: { events: Event[] }) {
  // Newest first: the beat that just happened is the one being filmed.
  const ordered = [...events].reverse()

  return (
    <div className="activity-wrap" aria-label="Activity">
      <div className="activity-head">
        <span className="section-title">Activity</span>
        {ordered.length > 0 && (
          <span className="activity-count" data-testid="activity-count">
            {ordered.length} event{ordered.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {ordered.length === 0 ? (
        <p className="activity-empty">No activity yet.</p>
      ) : (
        <ol className="activity" data-testid="activity">
          {ordered.map((e, i) => (
            <li
              key={`${e.who}-${e.what}-${i}`}
              // Hierarchy, not truncation: older entries fade back so the
              // current state reads first. Every event stays present.
              className={i < CURRENT_EVENTS ? 'current' : 'historical'}
            >
              <span className="dot" style={{ background: DOT[e.kind] }} aria-hidden="true" />
              <div className="body">
                <div className="text">
                  <span className={`who ${WHO_CLASS[e.kind]}`}>{e.who}</span> {e.what}
                </div>
                {e.at && <div className="t">{time(e.at)}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
