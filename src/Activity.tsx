// One honest timeline for assistant, human and payer events.
//
// It is NOT chat and NOT a raw tool log: every entry is derived from durable
// backend state, so a reload reproduces the same timeline. Nothing is appended
// optimistically by React.

import type { Snapshot } from './capabilities'

export interface Event {
  who: string
  what: string
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

  if (snap.requirements.length > 0) {
    out.push({ who: 'Assistant', what: 'Discovered payer requirements' })
  }

  // One line per attachment, in binding order, using the durable boundAt.
  for (const b of snap.bindings) {
    out.push({
      who: 'Assistant',
      what: `Attached evidence for ${b.requirementId}`,
      at: b.boundAt,
    })
  }
  if (satisfied === snap.completeness.required && satisfied > 0) {
    out.push({ who: 'WellAuth', what: `All ${satisfied} requirements satisfied` })
  }

  if (snap.packetHash) out.push({ who: 'Assistant', what: 'Prepared submission for review' })

  if (snap.approval) {
    out.push({
      who: snap.approval.approvedBy,
      what: 'Approved submission',
      at: snap.approval.at,
    })
  }

  if (snap.submission) {
    out.push({ who: 'Assistant', what: 'Submitted to Northstar (simulated)' })
    if (snap.submission.payerStatus === 'approved') {
      out.push({ who: 'Simulated payer', what: 'Returned Approved' })
    } else if (snap.submission.payerStatus === 'denied') {
      out.push({ who: 'Simulated payer', what: 'Returned Denied' })
    }
  }

  // --- Act II ---
  const phase = snap.act2?.phase
  if (phase && phase !== 'AUTHORIZATION_ALIGNED') {
    out.push({ who: 'WellAuth', what: 'Detected authorization-window mismatch' })
    out.push({ who: 'WellAuth', what: 'Enabled authorization-window remediation' })
  }
  const rem = snap.remediation
  if (rem) {
    out.push({ who: 'Assistant', what: 'Prepared authorization-window remediation' })
    if (rem.approval) {
      out.push({
        who: rem.approval.approvedBy,
        what: 'Approved extension request',
        at: rem.approval.at,
      })
    }
    if (rem.submission?.extensionReceiptId) {
      out.push({ who: 'Assistant', what: 'Submitted extension to Northstar (simulated)' })
    }
  }
  if (phase === 'AUTHORIZATION_ALIGNED' && rem) {
    out.push({ who: 'Simulated payer', what: 'Updated authorization validity' })
  }

  return out
}

export function Activity({ events }: { events: Event[] }) {
  return (
    <section className="panel" aria-label="Activity">
      <div className="panel-head"><h2>Activity</h2></div>
      <div className="panel-body">
        {events.length === 0 ? (
          <p style={{ color: 'var(--ink-3)', fontSize: 12.5, margin: 0 }}>
            No activity yet.
          </p>
        ) : (
          <ol className="activity" data-testid="activity">
            {events.map((e, i) => (
              <li key={`${e.who}-${e.what}-${i}`}>
                <span className="t">{time(e.at)}</span>
                <span>
                  <span className="who">{e.who}</span> · {e.what}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
