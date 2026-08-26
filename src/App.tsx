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
import { registeredToolNames, setSnapshot, syncTools } from './webmcp'
import { Activity, buildActivity } from './Activity'
import { Assistant } from './Assistant'
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
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).replace(',', ' ·')
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

/** Human-facing status for the context band. Never color-only. */
function authorizationStatus(s: Snapshot): string {
  const phase = s.act2?.phase
  if (phase === 'AUTHORIZATION_ALIGNED') return 'Authorized · covers scheduled date'
  if (phase === 'REMEDIATION_SUBMITTED') return 'Extension pending'
  if (phase === 'REMEDIATION_APPROVED') return 'Extension approved for submission'
  if (phase === 'REMEDIATION_PREPARED') return 'Extension awaiting approval'
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') return 'Approved · does not cover scheduled date'
  if (s.submission?.state === 'COMPLETE' && s.submission.payerStatus === 'denied') {
    return 'Denied by simulated payer'
  }
  if (s.submission) return 'Submitted · pending'
  if (s.state === 'APPROVED') return 'Approved for submission'
  if (s.state === 'PREPARED_AWAITING_APPROVAL') return 'Awaiting workforce approval'
  return 'Prior authorization required'
}

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
      // The backend's refusal is shown as-is. React never papers over it.
      if (r?.code) setError(`${r.code}: ${r.message ?? ''}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (error && !snap) {
    return (
      <>
        <Masthead />
        <div className="loading">
          <p className="err">{error}</p>
        </div>
      </>
    )
  }

  if (!snap) {
    return (
      <>
        <Masthead />
        <p className="loading">Loading authoritative state…</p>
      </>
    )
  }

  const service = snap.order?.service?.display ?? 'Cardiac MRI with contrast'

  return (
    <>
      <Masthead />
      <div className="workspace">
        <main>
          <section className="panel context" aria-label="Authorization context">
            <div className="cell">
              <div className="label">Ordered service</div>
              <div className="value lg">{service}</div>
            </div>
            <div className="cell">
              <div className="label">Patient</div>
              <div className="value">
                J. Alvarez
                <span className="sub">Synthetic record</span>
              </div>
            </div>
            <div className="cell">
              <div className="label">Scheduled</div>
              <div className="value" data-testid="scheduled">
                {fmtScheduled(snap.order?.scheduled)}
              </div>
            </div>
            <div className="cell">
              <div className="label">Payer</div>
              <div className="value">
                {snap.payer}
                <span className="sub">Simulated</span>
              </div>
            </div>
            <div className="cell">
              <div className="label">Authorization status</div>
              <div className="value" data-testid="auth-status">{authorizationStatus(snap)}</div>
            </div>
          </section>

          <Requirements snap={snap} />

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
        </main>

        <aside>
          <Assistant snap={snap} unlockCue={unlockCue} registered={registeredToolNames()} />
          <Activity events={buildActivity(snap)} />
        </aside>
      </div>
    </>
  )
}

function Masthead() {
  return (
    <header className="masthead">
      <div className="wordmark">Well<span>Auth</span></div>
      <div className="env">Synthetic data · Simulated payer</div>
    </header>
  )
}
