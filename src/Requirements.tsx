// The emotional center of the demo: five requirements, with evidence shown
// directly beneath the exact requirement it satisfies, in provenance form.

import type { Snapshot } from './capabilities'

/** Human-readable evidence titles by resource type. */
const TITLES: Record<string, string> = {
  Condition: 'Documented cardiac symptoms',
  DiagnosticReport: 'Echocardiogram report',
  DocumentReference: 'Conservative therapy consult note',
  PractitionerRole: 'Ordering physician attestation',
  Coverage: 'Member eligibility record',
}

export function Requirements({ snap }: { snap: Snapshot }) {
  const { satisfied, required } = snap.completeness
  const bound = new Map(snap.bindings.map((b) => [b.requirementId, b]))

  return (
    <section className="panel" aria-label="Payer requirements">
      <div className="panel-head">
        <h2>Payer requirements</h2>
        <span className="counter" data-testid="counter">
          {satisfied} of {required} met
        </span>
      </div>

      {snap.requirements.length === 0 ? (
        <p className="req-empty">
          Payer requirements have not been discovered yet.
          <br />
          <span style={{ fontSize: 12.5 }}>
            Ask the assistant to discover the coverage requirements for this order.
          </span>
        </p>
      ) : (
        <div>
          {snap.requirements.map((r) => {
            const b = bound.get(r.id)
            return (
              <div className="req" key={r.id} data-testid={`req-${r.id}`}>
                <div className="req-main">
                  <div className="req-label">{r.label}</div>
                  {b && (
                    // Provenance: what was attached, when it was authored,
                    // where it came from, and who attached it.
                    <div className="provenance">
                      <span className="arrow" aria-hidden="true">↳</span>
                      <span>{TITLES[b.resourceType] ?? b.resourceType}</span>
                      <span className="dot">·</span>
                      <span>{b.resourceType}</span>
                      <span className="dot">·</span>
                      {/* Cloud Healthcare version ids are long opaque base64.
                          The exact value is what the backend binds and freezes;
                          the UI shows a legible prefix so the provenance line
                          stays readable at demo scale. */}
                      <span title={b.sourceVersionId}>
                        v{b.sourceVersionId.slice(-6)}
                      </span>
                      <span className="dot">·</span>
                      <span className="by">attached by assistant</span>
                    </div>
                  )}
                </div>
                <span
                  className={`status-chip ${b ? 'chip-met' : 'chip-open'}`}
                  data-testid={`status-${r.id}`}
                >
                  {b ? 'MET' : 'OPEN'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
