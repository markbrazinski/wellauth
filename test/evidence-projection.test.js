/**
 * C-2 evidence presentation metadata.
 *
 * `titleOf` / `effectiveOf` are what the provenance line renders. They were
 * already used by evidence discovery; C-2 reuses them at attach time so a
 * binding carries the title and clinical date of the exact version it froze.
 * Previously the UI hardcoded a resourceType -> title map, which fabricated a
 * title for whatever happened to be attached.
 *
 * Pure functions over plain resource literals -- no FHIR, no Firestore, no
 * mocks. The literals mirror the real shapes in provider/fixtures/seed.json.
 */

import { describe, expect, it } from 'vitest'
import { effectiveOf, titleOf } from '../provider/service.js'

describe('titleOf -- the five real fixture resource shapes', () => {
  it('reads a Condition from code.text', () => {
    expect(titleOf({ resourceType: 'Condition', code: { text: 'Dyspnea on exertion' } }))
      .toBe('Dyspnea on exertion')
  })

  it('reads a DiagnosticReport from code.text', () => {
    expect(titleOf({ resourceType: 'DiagnosticReport', code: { text: 'Transthoracic echocardiogram' } }))
      .toBe('Transthoracic echocardiogram')
  })

  it('reads a DocumentReference from the attachment title', () => {
    // The fifth-beat resource: no code.text, the human title lives on content.
    expect(titleOf({
      resourceType: 'DocumentReference',
      type: { coding: [{ code: '11488-4' }] },
      content: [{ attachment: { title: 'Cardiology consult note - conservative therapy trial outcome' } }],
    })).toBe('Cardiology consult note - conservative therapy trial outcome')
  })

  it('reads a PractitionerRole from its specialty, not a title', () => {
    // PractitionerRole has no code.text at all; this is why the fallback chain
    // extends past the usual title fields.
    expect(titleOf({
      resourceType: 'PractitionerRole',
      specialty: [{ coding: [{ display: 'Cardiovascular Disease Physician' }] }],
    })).toBe('Cardiovascular Disease Physician')
  })

  it('reads a Coverage from type.text', () => {
    expect(titleOf({ resourceType: 'Coverage', type: { text: 'preferred provider organization policy' } }))
      .toBe('preferred provider organization policy')
  })

  it('returns null rather than inventing a title', () => {
    expect(titleOf({ resourceType: 'Condition' })).toBeNull()
  })
})

describe('effectiveOf -- clinical date per resource type', () => {
  it('prefers effectiveDateTime', () => {
    expect(effectiveOf({ effectiveDateTime: '2026-07-28T10:00:00Z' })).toBe('2026-07-28T10:00:00Z')
  })

  it('falls back to recordedDate for a Condition', () => {
    expect(effectiveOf({ recordedDate: '2026-07-22' })).toBe('2026-07-22')
  })

  it('falls back to date for a DocumentReference', () => {
    expect(effectiveOf({ date: '2026-08-01T09:00:00Z' })).toBe('2026-08-01T09:00:00Z')
  })

  it('falls back to period.start for a Coverage', () => {
    expect(effectiveOf({ period: { start: '2026-01-01', end: '2026-12-31' } })).toBe('2026-01-01')
  })

  it('returns null rather than inventing a date', () => {
    expect(effectiveOf({ resourceType: 'PractitionerRole' })).toBeNull()
  })

  it('does not treat an absent date as now', () => {
    // Guards the provenance line against showing today's date for a resource
    // that carries no clinical date at all.
    expect(effectiveOf({})).toBeNull()
  })
})
