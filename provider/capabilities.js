// Server-authoritative capability document.
//
// This is the single source of truth for "what may the browser agent do here,
// now?". The frontend synchronizes its WebMCP registrations FROM this list and
// never computes it locally, which is what makes UI state and browser tool
// inventory structurally unable to drift from backend state.
//
// A capability appearing here is an AFFORDANCE, not an authorization. Every
// underlying route independently re-validates state, revision and freshness --
// removing a name from this list hides a capability, it does not secure it.
//
// Deliberately absent, at every state: any approval capability. Approving a
// submission and approving a remediation are workforce actions reachable only
// with workforce headers, and are never WebMCP tools.

/**
 * Derives the live capability list from authoritative state.
 *
 * Pure function of persisted state, so a page reload reconstructs exactly the
 * same inventory -- no React memory is involved.
 *
 * @param {object} wf   workflow projection (state, completeness, submission)
 * @param {object} act2 Act II posture from remediation.derivePosture
 */
export function capabilitiesFor(wf, act2 = {}) {
  const out = []
  const state = wf?.state
  const sub = wf?.submission
  const phase = act2?.phase ?? null

  // --- Act I -------------------------------------------------------------
  // Order context is readable in every state; it is how an agent orients.
  out.push('get_order_context')

  if (state === 'CONTEXT_READY' || state === 'REQUIREMENTS_RESOLVED') {
    out.push('discover_coverage_requirements')
  }

  // Evidence operations exist once requirements are resolved, and stop being
  // valid once a real outbound submission exists (the workflow cannot be
  // edited out from under a transmitted authorization).
  const editable = !sub || sub.state === 'FAILED'
  if (state !== 'CONTEXT_READY' && editable) {
    out.push('find_supporting_evidence', 'inspect_evidence', 'attach_evidence')
    // Removal only makes sense when something is actually bound.
    if ((wf?.completeness?.satisfied ?? 0) > 0) out.push('remove_evidence')
  }

  // Prepare appears only at 5/5, and disappears once prepared.
  if (state === 'PACKET_COMPLETE' && editable) out.push('prepare_prior_authorization')

  // THE HUMAN GATE. In PREPARED_AWAITING_APPROVAL there is deliberately no
  // submission capability of any kind -- the tool is absent, not disabled.
  if (state === 'APPROVED' && editable) out.push('submit_prior_authorization')

  // Status monitoring exists from the moment a submission exists.
  if (sub) out.push('check_authorization_status')

  // --- Act II ------------------------------------------------------------
  // These capabilities are unlocked by EXTERNAL payer state, not by anything
  // the agent or the browser did.
  if (phase === 'PAYER_APPROVED_COVERAGE_GAP') {
    out.push('resolve_authorization_window')
  }
  // REMEDIATION_PREPARED: no remediation-submission capability. Same human
  // gate as Act I, for the same reason.
  if (phase === 'REMEDIATION_APPROVED') {
    out.push('submit_authorization_extension')
  }
  // REMEDIATION_SUBMITTED / AUTHORIZATION_ALIGNED: status only, no mutation.

  return [...new Set(out)]
}
