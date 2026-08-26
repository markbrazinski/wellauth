// The payer must hash an inbound artifact EXACTLY as the provider hashed it,
// or "is this the request I sent?" can never be answered. Re-exporting the
// provider's implementation keeps one definition of canonical form rather than
// two copies that can silently drift apart.
//
// ponytail: a re-export, not a duplicate. The Dockerfile copies both dirs.
export { canonicalize, packetHash } from '../provider/canonical.js'
