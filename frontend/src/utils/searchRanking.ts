/**
 * searchRanking.ts
 *
 * Deterministic, mathematically-sound ranking for search autocomplete.
 *
 * ─── Algorithm Design ────────────────────────────────────────────────────────
 *
 * Score function (inspired by Reddit / HN / YouTube ranking literature):
 *
 *   score(item, query) =
 *       PREFIX_BOOST                           ← hard binary gate (100 pts)
 *     + log(1 + plays)  * W_PLAYS             ← log-normalized play count
 *     + log(1 + tips)   * W_TIPS              ← tips weighted 3× (intent signal)
 *     + e^(-λ * days)   * W_RECENCY           ← exponential recency decay
 *
 * Why log(1 + n)?
 *   Raw counts are skewed. A million-play track scoring 1,000,000 vs a
 *   10-play track scoring 10 makes the engagement dimension meaningless —
 *   the gap is artificial noise. log(1,000,001) ≈ 13.8, log(11) ≈ 2.4.
 *   The ratio stays meaningful without letting raw scale dominate.
 *
 * Why e^(-λ * days)?
 *   Recency should decay continuously, not in steps. λ = 0.02 means:
 *     - After 1 week  (7 days):  decay ≈ 0.87  (still strong)
 *     - After 1 month (30 days): decay ≈ 0.55  (moderate)
 *     - After 1 year (365 days): decay ≈ 0.0006 (nearly zero)
 *   This is the same curve used in collaborative-filtering recency windows.
 *
 * Why a fixed PREFIX_BOOST, not a fuzz weight?
 *   Prefix match is categorical, not continuous. It either starts with the
 *   query or it doesn't. A hard-enough constant (100) guarantees any prefix
 *   match beats any non-prefix match regardless of engagement — which is
 *   exactly the behaviour users expect when they are mid-word.
 *
 * Tie-breaker: localeCompare (deterministic, locale-aware, zero jitter).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SearchSuggestionItem } from '@/types/search.types';

// ---------------------------------------------------------------------------
// Constants — named, documented, never magic numbers
// ---------------------------------------------------------------------------

/** Added to score when item.title starts with the user's query. */
const PREFIX_BOOST = 100;

/** Relative importance of play count after log-normalization. */
const W_PLAYS = 1.0;

/**
 * Relative importance of tip count after log-normalization.
 * Tips signal stronger user intent than passive plays: weight them 3×.
 */
const W_TIPS = 3.0;

/**
 * Relative importance of the recency signal.
 * Keeps a brand-new item competitive against proven catalogue.
 */
const W_RECENCY = 2.0;

/**
 * Decay rate λ for e^(-λ * age_days).
 * 0.02 → half-life ≈ 34 days.
 */
const RECENCY_DECAY_LAMBDA = 0.02;

// ---------------------------------------------------------------------------
// Score function — one job, pure, no side-effects
// ---------------------------------------------------------------------------

/**
 * Compute a continuous relevance score for a single suggestion.
 * Higher score = ranked earlier.
 */
export function scoreSuggestion(item: SearchSuggestionItem, query: string): number {
    const q = query.trim().toLowerCase();

    // Rule 1 — Categorical prefix gate
    const prefixBoost = item.title.toLowerCase().startsWith(q) ? PREFIX_BOOST : 0;

    // Rule 2 — Log-normalized engagement
    const plays = Math.max(0, item.plays ?? 0);
    const tips = Math.max(0, item.tips ?? 0);
    const engagement = Math.log1p(plays) * W_PLAYS + Math.log1p(tips) * W_TIPS;
    //  Math.log1p(x) = log(1 + x) — built-in, avoids log(0) = -Infinity

    // Rule 3 — Exponential recency decay
    let recency = 0;
    if (item.createdAt) {
        const ageMs = Date.now() - Date.parse(item.createdAt);
        const ageDays = Math.max(0, ageMs / 86_400_000);
        recency = Math.exp(-RECENCY_DECAY_LAMBDA * ageDays) * W_RECENCY;
    }

    return prefixBoost + engagement + recency;
}

// ---------------------------------------------------------------------------
// Comparator — standard Array.sort contract
// ---------------------------------------------------------------------------

/**
 * compareSearchSuggestions
 *
 * Sorts two items by descending score.
 * When scores are numerically identical, falls back to localeCompare
 * for a deterministic, stable order (no UI flickering between renders).
 */
export function compareSearchSuggestions(
    a: SearchSuggestionItem,
    b: SearchSuggestionItem,
    query: string,
): number {
    const scoreA = scoreSuggestion(a, query);
    const scoreB = scoreSuggestion(b, query);

    // Descending score
    if (scoreA !== scoreB) return scoreB - scoreA;

    // Stable alphabetical tie-breaker
    return a.title.localeCompare(b.title);
}

// ---------------------------------------------------------------------------
// Public wrapper — immutable, safe to call on React state
// ---------------------------------------------------------------------------

/**
 * rankSuggestions
 *
 * Returns a new array sorted by relevance score.
 * Does NOT mutate the input.
 */
export function rankSuggestions(
    suggestions: SearchSuggestionItem[],
    query: string,
): SearchSuggestionItem[] {
    return [...suggestions].sort((a, b) => compareSearchSuggestions(a, b, query));
}
