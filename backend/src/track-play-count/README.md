## Play Count Semantics

Use `POST /api/v1/plays/record` as the canonical ingestion path for streaming events.

Counted plays:

- Require at least 30 seconds of listening time.
- Are deduplicated within the configured one-hour window across `fromUser`, `sessionId`, and hashed IP fallback.
- Increment `tracks.plays` so leaderboards and downstream analytics read the same aggregate.

Raw play events:

- Still persist even when a listen is skipped or deduplicated.
- Are useful for forensic analytics, funnel analysis, and debugging ingestion quality.
- Should not be used for public-facing totals unless the consumer intentionally wants unfiltered events.

Aggregated counters:

- `tracks.plays` is the durable aggregate derived from counted play events.
- The legacy `PATCH /tracks/:id/play` path now recalculates from canonical counted plays instead of incrementing an independent counter.
