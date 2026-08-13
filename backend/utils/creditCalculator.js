// Billing rule: every answered call costs 1 credit per started 15-second slab of connected
// duration (1-15s -> 1 credit, 16-30s -> 2 credits, ...). Calls that never connected are billed
// by the caller passing durationSec as 0/undefined, never by this function guessing dialStatus.
export function creditsForDuration(durationSec) {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 15);
}
