// Deterministic serialization + packet hashing.
//
// SERIALIZATION METHOD
//   JSON, produced by canonicalize() below, then UTF-8 encoded.
//
// CANONICAL FIELD ORDERING
//   Object keys are emitted in ascending code-unit order at every depth
//   (Array.prototype.sort default). Arrays keep their meaningful order, and
//   every array the packet builder produces is itself sorted on a stable
//   business key (requirementId) before it gets here, so array order is a
//   function of content rather than of iteration or write order.
//   undefined-valued keys are dropped; null is preserved and meaningful
//   (an absent version is not the same as a null version).
//
// HASHING ALGORITHM
//   SHA-256 over those bytes, lowercase hex, prefixed "sha256:".
//
// Consequence: a semantically identical packet hashes identically across
// processes and deploys, and any change to a bound version, requirement set,
// order, coverage, destination or purpose changes the hash.

import { createHash } from 'node:crypto'

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
}

export function packetHash(packet) {
  return 'sha256:' + createHash('sha256').update(canonicalize(packet), 'utf8').digest('hex')
}
