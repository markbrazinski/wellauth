// The emotional center of the demo: five requirements, with evidence shown
// directly beneath the exact requirement it satisfies, in provenance form.
//
// Every string here comes from the server snapshot. There is no local title
// map: before C-2 the UI invented an evidence title from the resource type,
// which meant the provenance line described a resource that might not be the
// one attached. Now `title` and `effectiveDate` ride on the binding, derived
// from the exact source version the binding froze.

import type { Binding, Snapshot } from './capabilities'

/** A requirement is MET iff the server holds a binding for its id. */
function statusOf(b: Binding | undefined): 'met' | 'unmet' {
  return b ? 'met' : 'unmet'
}

export function Requirements({
  snap,
  fmtDate,
}: {
  snap: Snapshot
  fmtDate: (iso?: string | null) => string
}) {
  const { satisfied, required, complete } = snap.completeness
  const bound = new Map(snap.bindings.map((b) => [b.requirementId, b]))
  const discovered = snap.requirements.length > 0

  // Once a submission exists the requirements are settled history, so they
  // collapse to a compact strip and give the vertical room to the payer
  // exchange. They are never hidden -- the authorization basis stays visible.
  const compact = Boolean(snap.submission)

  return (
    <section className="reqs" aria-label="Payer requirements">
      <div className="reqs-head">
        <span className="section-title">
          {compact ? 'Authorization basis' : 'Requirements'}
        </span>

        {discovered && !compact && (
          <div className="readiness">
            <span className="readiness-label" data-testid="counter">
              READINESS · {satisfied} / {required} MET
            </span>
            <div
              className="readiness-track"
              role="progressbar"
              aria-valuenow={satisfied}
              aria-valuemin={0}
              aria-valuemax={required}
              aria-label={`${satisfied} of ${required} requirements met`}
            >
              <div
                className={`readiness-fill${complete ? ' complete' : ''}`}
                style={{ width: `${(satisfied / required) * 100}%` }}
              />
            </div>
          </div>
        )}

        {compact && (
          <span className="basis-count" data-testid="counter">
            {satisfied} / {required} MET · EVIDENCE ATTACHED
          </span>
        )}
      </div>

      <div className="reqs-body">
        {/* `requirements: []` at CONTEXT_READY is deliberate server behavior:
            listing the five before discovery would claim a discovery that never
            happened. The empty state says exactly that. */}
        {!discovered ? (
          <div className="empty-state">
            <div className="headline">Payer requirements not yet discovered.</div>
            <div className="detail">
              The assistant can inspect the order and discover {snap.payer}&rsquo;s requirements.
            </div>
          </div>
        ) : compact ? (
          <>
            <div className="basis-strip">
              {snap.requirements.map((r) => (
                <span className="basis-chip" key={r.id} data-testid={`req-${r.id}`}>
                  <span className="tick" aria-hidden="true">✓</span>
                  {r.label}
                </span>
              ))}
            </div>
            <div className="basis-note">
              Authorization basis · {satisfied} authoritative items attached to {snap.payer}
              &rsquo;s requirements. Unchanged through the payer exchange.
            </div>
          </>
        ) : (
          snap.requirements.map((r, i) => {
            const b = bound.get(r.id)
            const status = statusOf(b)
            return (
              <div
                className={`req ${status}`}
                key={r.id}
                data-testid={`req-${r.id}`}
                style={{ animationDelay: `${(i * 0.07).toFixed(2)}s` }}
              >
                <span className="req-box" aria-hidden="true">
                  {status === 'met' ? '✓' : ''}
                </span>
                <div className="req-main">
                  <div className="req-label">{r.label}</div>

                  {b ? (
                    // Provenance: what was attached, when it was authored, where
                    // it came from, and who attached it.
                    <div className="provenance">
                      ↳ {b.title ?? b.resourceType}
                      {b.effectiveDate ? ` · ${fmtDate(b.effectiveDate)}` : ''} ·{' '}
                      {b.resourceType}
                      <span className="by"> · attached by assistant</span>
                    </div>
                  ) : (
                    <div className="req-note">awaiting supporting evidence</div>
                  )}
                </div>

                {/* Status is a text label, never colour alone. */}
                <span className="req-status" data-testid={`status-${r.id}`}>
                  {status === 'met' ? 'MET' : 'UNMET'}
                </span>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
