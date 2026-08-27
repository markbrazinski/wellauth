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

/**
 * P1-3: human-facing source label.
 *
 * The operational reading is "where did this come from", not "which FHIR
 * resource type is it". The resource type is still available on the binding
 * for anyone who needs it (and stays in the title attribute), but the primary
 * line reads like prior-auth operations software rather than a FHIR debugger.
 */
const SOURCE_LABEL: Record<string, string> = {
  Condition: 'Problem list',
  DiagnosticReport: 'Diagnostic report',
  DocumentReference: 'Clinical note',
  PractitionerRole: 'Provider credential',
  Coverage: 'Member coverage',
  Observation: 'Observation',
}

const sourceLabel = (resourceType: string) => SOURCE_LABEL[resourceType] ?? resourceType

/**
 * P2-1: display casing for titles that arrive lower-cased from the source
 * (e.g. Coverage's "preferred provider organization policy").
 *
 * Presentation only -- the source string is never mutated. Applied only to an
 * all-lowercase title, so a title the record already cased deliberately (an
 * acronym, a proper noun) is left exactly as authored.
 */
function displayTitle(title: string | null): string | null {
  if (!title) return title
  if (title !== title.toLowerCase()) return title
  return title.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/**
 * P1-3: how to phrase the date, given what kind of date it is. A coverage or
 * credentialing period start is not a clinical event date and is never shown
 * as a bare date next to a title.
 */
function dateLabel(b: Binding, fmtDate: (iso?: string | null) => string): string {
  if (!b.effectiveDate) return ''
  if (b.dateKind !== 'coverage-period') return fmtDate(b.effectiveDate)
  // An administrative window start ALWAYS carries its year: "effective from
  // Jan 1" is ambiguous in a way "effective from Jan 1, 2026" is not, and this
  // is precisely the presentation the audit flagged.
  const year = String(b.effectiveDate).slice(0, 4)
  const shown = fmtDate(b.effectiveDate)
  return `effective from ${shown.includes(year) ? shown : `${shown}, ${year}`}`
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
                    // Provenance: what was attached, when, where it came from,
                    // and who attached it. Human-facing labels (P1-3); the
                    // exact resource type and version stay in the tooltip.
                    <div
                      className="provenance"
                      title={`${b.resourceType} · version ${b.sourceVersionId}`}
                    >
                      ↳ {displayTitle(b.title) ?? sourceLabel(b.resourceType)}
                      {dateLabel(b, fmtDate) ? ` · ${dateLabel(b, fmtDate)}` : ''} ·{' '}
                      {sourceLabel(b.resourceType)}
                      <span className="by"> · attached by assistant</span>
                    </div>
                  ) : (
                    <div className="req-note">awaiting supporting evidence</div>
                  )}

                  {/* P1-1: THE FIFTH BEAT, made legible.
                      Why this requirement is legitimately satisfied a
                      different way -- rendered only from authoritative truth
                      (requirement.alternatePath + binding.bindingRule), never
                      from invented clinical reasoning. */}
                  {r.alternatePath && (
                    <div
                      className={`alt-path${b ? ' resolved' : ''}`}
                      data-testid={`alt-path-${r.id}`}
                    >
                      <span className="alt-path-tag">
                        {b ? 'Found elsewhere in the record' : 'No structured match'}
                      </span>
                      <span className="alt-path-text">
                        {b
                          ? 'This requirement has no matching structured record. The ' +
                            'assistant located existing authoritative evidence in the ' +
                            'clinical notes instead.'
                          : 'This requirement cannot be satisfied from the structured ' +
                            'record and needs evidence located elsewhere.'}
                      </span>
                    </div>
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
