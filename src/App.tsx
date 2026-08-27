// The WellAuth authorization workspace.
//
// This component holds NO workflow state. Everything it renders comes from the
// server snapshot, so a reload reconstructs the page -- and the WebMCP
// capability inventory -- from backend truth alone. React never decides what
// state the workflow is in, never guesses a payer outcome, and never shows a
// success before the backend has committed it.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveRemediation,
  approveSubmission,
  ensureWorkflow,
  fetchDisclosure,
  fetchSnapshot,
  type Disclosure,
  type Snapshot,
} from './capabilities'
import { setSnapshot, syncTools } from './webmcp'
import { Activity, buildActivity } from './Activity'
import { Assistant, toolLabel } from './Assistant'
import { LowerRegion } from './LowerRegion'
import { Requirements } from './Requirements'

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const fmtScheduled = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).replace(/,([^,]*)$/, ' ·$1')
}

/**
 * Is the payer holding an outcome we cannot cause? Pure and exported so the
 * polling trigger is testable without rendering.
 */
export function awaitingPayer(s: Snapshot | null): boolean {
  return (
    s?.submission?.state === 'SUBMITTED_OR_PENDING' ||
    s?.remediation?.submission?.outcome === 'pending'
  )
}

type Tone = 'amber' | 'accent' | 'green' | 'warn'

/**
 * Human-facing status for the context band. Never colour-only -- the tone is
 * always paired with the label text. Precedence is act2.phase -> submission ->
 * state, the same order the lower region uses.
 */
export function authorizationStatus(s: Snapshot): { label: string; tone: Tone } {
  const phase = s.act2?.phase
  if (phase === 'AUTHORIZATION_ALIGNED') return { label: 'Authorization aligned', tone: 'green' }
  if (phase === 'REMEDIATION_SUBMITTING' || phase === 'REMEDIATION_SUBMITTED') {
    return { label: 'Extension submitted · pending', tone: 'amber' }
  }
  if (phase === 'REMEDIATION_APPROVED') return { label: 'Extension approved', tone: 'accent' }
  if (phase === 'REMEDIATION_PREPARED') return { label: 'Remediation prepared', tone: 'accent' }
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') {
    return { label: 'Approved · window mismatch', tone: 'warn' }
  }
  if (s.submission?.state === 'COMPLETE') {
    return s.submission.payerStatus === 'denied'
      ? { label: 'Denied by simulated payer', tone: 'warn' }
      : { label: 'Approved by simulated payer', tone: 'green' }
  }
  if (s.submission?.state === 'FAILED') return { label: 'Not accepted', tone: 'warn' }
  if (s.submission?.state === 'UNKNOWN_SUBMISSION_OUTCOME') {
    return { label: 'Outcome unknown', tone: 'warn' }
  }
  if (s.submission) return { label: 'Submitted · pending', tone: 'amber' }
  if (s.state === 'APPROVED') return { label: 'Approved for submission', tone: 'accent' }
  if (s.state === 'PREPARED_AWAITING_APPROVAL') return { label: 'Prepared for review', tone: 'accent' }
  return { label: 'Prior authorization required', tone: 'amber' }
}

/** The scheduled date turns amber exactly while the authorization misses it. */
const GAP_PHASES = new Set([
  'PAYER_APPROVED_COVERAGE_GAP',
  'REMEDIATION_PREPARED',
  'REMEDIATION_APPROVED',
])

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [unlockCue, setUnlockCue] = useState<string | null>(null)
  const prevTools = useRef<string[]>([])
  const refreshRef = useRef<() => void>(() => {})

  const refresh = useCallback(async () => {
    let next: Snapshot
    try {
      await ensureWorkflow()
      next = await fetchSnapshot()
    } catch {
      setError('Cannot reach the WellAuth provider service.')
      return
    }
    if ((next as unknown as { code?: string }).code) {
      setError(`Provider refused: ${(next as unknown as { code: string }).code}`)
      return
    }
    setError(null)
    setSnap(next)
    setSnapshot(next)

    // A newly available capability is the demo's hero beat, so it is surfaced
    // as a transient cue -- derived from the SERVER's list, not predicted.
    const gained = next.availableTools.filter((t) => !prevTools.current.includes(t))
    const hero = gained.find((t) =>
      ['prepare_prior_authorization', 'submit_prior_authorization',
       'resolve_authorization_window', 'submit_authorization_extension'].includes(t))
    if (hero && prevTools.current.length > 0) setUnlockCue(hero)
    prevTools.current = next.availableTools

    try {
      await syncTools(next.availableTools, () => refreshRef.current())
    } catch (e) {
      setError(`WebMCP registration failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    setDisclosure(
      next.state === 'PREPARED_AWAITING_APPROVAL' || next.state === 'APPROVED'
        ? await fetchDisclosure()
        : null,
    )
  }, [])

  refreshRef.current = refresh

  useEffect(() => { void refresh() }, [refresh])

  // EXTERNAL UPDATE STRATEGY: bounded polling, and only while the payer owes
  // us an outcome the browser cannot cause. The canonical simulator answers
  // /submit synchronously, so this never fires on the demo path -- but
  // SUBMITTED_OR_PENDING is a real reachable state, and without this the page
  // would sit on "pending" forever with no way to learn the result.
  //
  // Polling, not SSE: one transition, on Cloud Run, does not justify holding
  // server-side connection state. Revision changes are detected by refresh()
  // replacing the snapshot wholesale, which re-syncs capabilities too.
  //
  // ponytail: fixed 5s, no backoff -- it stops on its own at a terminal state
  // and the window is short. Add backoff if a real async payer ever lands.
  const pending = awaitingPayer(snap)

  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => void refreshRef.current(), 5000)
    return () => clearInterval(t)
  }, [pending])

  useEffect(() => {
    if (!unlockCue) return
    const t = setTimeout(() => setUnlockCue(null), 6000)
    return () => clearTimeout(t)
  }, [unlockCue])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      const r = (await fn()) as { code?: string; message?: string }
      // The backend's refusal is shown as-is, keyed on the bounded code rather
      // than the HTTP status (Act II returns 400 where Act I returns 409).
      if (r?.code) setError(`${r.code}: ${r.message ?? ''}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!snap) {
    return (
      <div className="page">
        <div className="frame">
          <div className="shell">
            <TopBar />
            <p className="loading">
              {error ?? 'Loading authoritative state…'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const status = authorizationStatus(snap)
  const gap = GAP_PHASES.has(snap.act2?.phase ?? '')

  return (
    <div className="page">
      <div className="frame">
        {unlockCue && (
          // The one place a raw capability name is acceptable: a transient,
          // demo-oriented cue that a new WebMCP action just became available.
          <div className="toast" role="status" data-testid="unlock-cue">
            <span className="glyph" aria-hidden="true">◆</span>
            WebMCP action unlocked · {toolLabel(unlockCue)}
          </div>
        )}

        <div className="shell">
          <TopBar />

          <section className="context" aria-label="Authorization context">
            <div>
              <div className="label">Ordered service</div>
              <div className="value lg">{snap.order?.service?.display ?? '—'}</div>
            </div>
            <div className="divider" />
            <div>
              <div className="label">Patient</div>
              <div className="value" data-testid="patient">
                {snap.patient?.display ? (
                  <>
                    {snap.patient.display}{' '}
                    <span className="sub">· {snap.patient.syntheticLabel}</span>
                  </>
                ) : (
                  // Never a placeholder name: if FHIR could not answer, say so.
                  <span className="unavailable">Patient identity unavailable</span>
                )}
              </div>
            </div>
            <div className="divider" />
            <div>
              <div className="label">Scheduled</div>
              <div className={`value sched${gap ? ' gap' : ''}`} data-testid="scheduled">
                {fmtScheduled(snap.order?.scheduled)}
              </div>
            </div>
            <div className="divider" />
            <div>
              <div className="label">Payer</div>
              <div className="value">
                {snap.payer} <span className="sub">· simulated</span>
              </div>
            </div>
            <span className={`pill ${status.tone}`} data-testid="auth-status">
              <span className="dot" aria-hidden="true" />
              {status.label}
            </span>
          </section>

          <div className="middle">
            <Requirements snap={snap} fmtDate={fmtDate} />
            <aside className="rail">
              <Assistant snap={snap} unlockCue={unlockCue} />
              <Activity events={buildActivity(snap)} />
            </aside>
          </div>

          <LowerRegion
            snap={snap}
            disclosure={disclosure}
            busy={busy}
            fmtDate={fmtDate}
            onApproveSubmission={() =>
              act(() => approveSubmission(snap.revision, snap.packetHash ?? ''))}
            onApproveRemediation={() =>
              act(() => approveRemediation(snap.revision, snap.remediation?.hash ?? ''))}
          />

          {error && <p className="err" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function TopBar() {
  return (
    <div className="topbar">
      <div className="left">
        <span className="wordmark">Well<span>Auth</span></span>
        <span className="vrule" />
        {/* Presentational breadcrumb only. One canonical workflow exists; there
            is no list endpoint and no multi-case view (Gap D-1). */}
        <span className="breadcrumb">Worklist / Authorization</span>
      </div>
      <span className="whoami">A. Reyes · Auth Coordinator</span>
    </div>
  )
}
