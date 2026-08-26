// Diagnostic UI. Intentionally unstyled beyond legibility.
//
// This component holds NO workflow state. It renders whatever /api/state
// returns, so a reload reconstructs the page from server truth alone.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approvePacket,
  fetchState,
  resetWorkflow,
  type ServerSnapshot,
} from './capabilities'
import {
  browserToolNames,
  isWebMcpAvailable,
  registeredToolNames,
  setInvocationListener,
  syncTools,
  type InvocationLog,
} from './webmcp'

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' }

export default function App() {
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invocation, setInvocation] = useState<InvocationLog | null>(null)
  const [registered, setRegistered] = useState<string[]>([])
  const [browserTools, setBrowserTools] = useState<string[] | null>(null)
  const webmcp = isWebMcpAvailable()

  // Kept in a ref so tool `execute` closures always reach the current refresh.
  const refreshRef = useRef<() => void>(() => {})

  const refresh = useCallback(async () => {
    // Fetching state and registering tools fail for unrelated reasons; keeping
    // the catches separate stops a registration bug from being misreported as
    // an unreachable backend.
    let next: ServerSnapshot
    try {
      next = await fetchState()
    } catch {
      setError('Cannot reach backend. Run: npm run server')
      return
    }
    setSnapshot(next)
    setError(null)

    try {
      await syncTools(next.availableTools, () => refreshRef.current())
    } catch (e) {
      setError(`WebMCP registration failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRegistered(registeredToolNames())
    setBrowserTools(await browserToolNames())
  }, [])

  refreshRef.current = refresh

  useEffect(() => {
    setInvocationListener(setInvocation)
    void refresh()
  }, [refresh])

  const act = async (fn: () => Promise<unknown>) => {
    await fn()
    await refresh()
  }

  if (error) {
    return (
      <main style={{ padding: 24, ...mono }}>
        <h1>WellAuth WebMCP Probe</h1>
        <p style={{ color: 'crimson' }}>{error}</p>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main style={{ padding: 24, ...mono }}>
        <h1>WellAuth WebMCP Probe</h1>
        <p>Loading authoritative state…</p>
      </main>
    )
  }

  const { order, preparedPacket, approval } = snapshot
  // Divergence between what we registered and what the browser reports is a
  // hard failure of the whole thesis, so it is surfaced loudly.
  const drift =
    browserTools !== null && browserTools.join(',') !== [...registered].sort().join(',')

  return (
    <main style={{ padding: 24, maxWidth: 900, ...mono }}>
      <h1>WellAuth WebMCP Probe</h1>

      <section>
        <h3>Workflow state</h3>
        <p style={{ fontSize: 20 }}>
          <code data-testid="workflow-state">{snapshot.workflowState}</code>{' '}
          <small>(revision {snapshot.revision})</small>
        </p>
      </section>

      <section>
        <h3>Order</h3>
        <ul>
          <li>Patient: {order.patientId}</li>
          <li>Order: {order.orderId}</li>
          <li>Service: {order.orderedService} ({order.serviceCode})</li>
          <li>Status: {order.status}</li>
          <li>
            Prior authorization required:{' '}
            <strong>{order.priorAuthorizationRequired ? 'YES' : 'no'}</strong>
          </li>
        </ul>
      </section>

      <section>
        <h3>
          Payer requirements{' '}
          <span data-testid="satisfied-count">
            {snapshot.satisfiedCount} / {snapshot.requirementCount} satisfied
          </span>
        </h3>
        {snapshot.requirements.length === 0 ? (
          <p>
            <em>Not yet discovered. Ask the agent to discover coverage requirements.</em>
          </p>
        ) : (
          <ol>
            {snapshot.requirements.map((r) => (
              <li key={r.id}>
                [{r.satisfied ? 'x' : ' '}] {r.id} — {r.label}
                {r.boundEvidenceId && <> · bound: <code>{r.boundEvidenceId}</code></>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3>
          Agent Access:{' '}
          <span data-testid="capability-count">{snapshot.availableTools.length} capabilities</span>
        </h3>
        {!webmcp && (
          <p style={{ color: 'darkorange' }}>
            WebMCP not detected in this browser. The list below is the server's
            authoritative inventory; nothing is registered.
          </p>
        )}
        <ul data-testid="capability-list">
          {snapshot.availableTools.map((t) => (
            <li key={t}><code>{t}</code></li>
          ))}
        </ul>
        <p>
          Registered with browser: <code>{registered.join(', ') || '(none)'}</code>
        </p>
        <p>
          Browser <code>getTools()</code> reports:{' '}
          <code>{browserTools ? browserTools.join(', ') || '(none)' : 'unavailable'}</code>
        </p>
        {drift && (
          <p style={{ color: 'crimson', fontWeight: 'bold' }} data-testid="drift-warning">
            DRIFT DETECTED — registered set does not match browser inventory.
          </p>
        )}
      </section>

      {preparedPacket && (
        <section style={{ border: '2px solid #333', padding: 12 }}>
          <h3>Prepared packet — awaiting human approval</h3>
          <ul>
            <li>Destination payer: {preparedPacket.destinationPayer}</li>
            <li>Packet hash: <code>{preparedPacket.packetHash}</code></li>
            <li>Prepared at revision: {preparedPacket.preparedAtRevision}</li>
            <li>Complete: {preparedPacket.complete ? 'yes' : 'no'}</li>
          </ul>
          <h4>Proposed disclosure (minimum necessary)</h4>
          <ol>
            {preparedPacket.proposedDisclosure.map((d) => (
              <li key={d.requirementId}>
                {d.requirementLabel} → <code>{d.evidenceId}</code> {d.evidenceTitle}
              </li>
            ))}
          </ol>
          {!approval && (
            <button
              data-testid="approve-button"
              onClick={() => void act(() => approvePacket(preparedPacket.packetHash))}
            >
              Approve submission
            </button>
          )}
        </section>
      )}

      {approval && (
        <section style={{ border: '2px solid green', padding: 12 }}>
          <h3 data-testid="approved-banner">APPROVED FOR SUBMISSION</h3>
          <ul>
            <li>Approved packet hash: <code>{approval.approvedPacketHash}</code></li>
            <li>Approved at revision: {approval.approvedAtRevision}</li>
            <li>Approved by: {approval.approvedBy}</li>
          </ul>
          <p>
            <em>
              Gate 0: <code>submit_prior_authorization</code> is now registered but returns
              NOT_IMPLEMENTED_GATE_0.
            </em>
          </p>
        </section>
      )}

      <section>
        <h3>Latest WebMCP invocation</h3>
        {invocation ? (
          <>
            <p>
              <code data-testid="last-invocation">{invocation.tool}</code> at {invocation.at}
            </p>
            <p>input:</p>
            <pre>{JSON.stringify(invocation.input, null, 2)}</pre>
            <p>result:</p>
            <pre data-testid="last-result">{JSON.stringify(invocation.result, null, 2)}</pre>
          </>
        ) : (
          <p><em>No tool has been invoked yet.</em></p>
        )}
      </section>

      <section>
        <h3>Operator controls (not agent-accessible)</h3>
        <button onClick={() => void act(resetWorkflow)}>Reset workflow</button>{' '}
        <button onClick={() => void refresh()}>Refresh from server</button>
      </section>
    </main>
  )
}
