/**
 * searchRanking.test.ts
 *
 * Three groups of tests:
 *  1. scoreSuggestion — validates each scoring component in isolation
 *  2. compareSearchSuggestions — validates ordering between pairs
 *  3. rankSuggestions — end-to-end list tests
 */

import { describe, it, expect } from 'vitest';
import { scoreSuggestion, compareSearchSuggestions, rankSuggestions } from '@/utils/searchRanking';
import type { SearchSuggestionItem } from '@/types/search.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function make(partial: Partial<SearchSuggestionItem>): SearchSuggestionItem {
    return {
        type: 'track',
        id: 'default-id',
        title: 'Default Title',
        plays: 0,
        tips: 0,
        createdAt: '2024-01-01T00:00:00.000Z',
        ...partial,
    };
}

const NOW = new Date().toISOString();
const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// scoreSuggestion unit tests
// ---------------------------------------------------------------------------

describe('scoreSuggestion', () => {
    it('prefix match adds a large constant boost to the score', () => {
        const withPrefix = make({ title: 'Wave Rider' });
        const withoutPrefix = make({ title: 'Ocean Wave Rider', plays: 999_999, tips: 99_999 });

        const scoreWith = scoreSuggestion(withPrefix, 'wave');
        const scoreWithout = scoreSuggestion(withoutPrefix, 'wave');

        // Prefix boost (100) should overcome massive raw engagement
        expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it('log normalization: doubling plays does not double the score', () => {
        const base = make({ plays: 100 });
        const double = make({ plays: 200 });

        const delta1 = scoreSuggestion(double, 'x') - scoreSuggestion(base, 'x');
        const delta2 = scoreSuggestion(base, 'x') - scoreSuggestion(make({ plays: 0 }), 'x');

        // log is concave — doubling plays adds less than the first 100 did
        expect(delta1).toBeLessThan(delta2);
    });

    it('tips are weighted higher than plays (W_TIPS = 3 * W_PLAYS)', () => {
        const byTips = make({ plays: 0, tips: 10 });
        const byPlays = make({ plays: 10, tips: 0 });

        expect(scoreSuggestion(byTips, 'x')).toBeGreaterThan(scoreSuggestion(byPlays, 'x'));
    });

    it('newer item scores higher than older item with identical engagement', () => {
        const newItem = make({ plays: 100, createdAt: NOW });
        const oldItem = make({ plays: 100, createdAt: YEAR_AGO });

        expect(scoreSuggestion(newItem, 'x')).toBeGreaterThan(scoreSuggestion(oldItem, 'x'));
    });

    it('missing createdAt does not crash — recency is treated as zero', () => {
        const noDate = make({ createdAt: undefined });
        expect(() => scoreSuggestion(noDate, 'x')).not.toThrow();
    });

    it('score is always non-negative', () => {
        const empty = make({ plays: 0, tips: 0, createdAt: YEAR_AGO });
        expect(scoreSuggestion(empty, 'nothing')).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// compareSearchSuggestions — ordering
// ---------------------------------------------------------------------------

describe('compareSearchSuggestions', () => {
    it('prefix item ranks above non-prefix regardless of engagement', () => {
        const prefix = make({ id: 'a', title: 'Mako', plays: 0, tips: 0 });
        const noPrefix = make({ id: 'b', title: 'Super Mako', plays: 10_000_000, tips: 100_000 });
        expect(compareSearchSuggestions(prefix, noPrefix, 'mako')).toBeLessThan(0);
    });

    it('higher tips win over higher plays when prefix is tied', () => {
        const byTips = make({ id: 'a', title: 'Track A', plays: 0, tips: 500 });
        const byPlays = make({ id: 'b', title: 'Track B', plays: 500, tips: 0 });
        // tips score > plays score because W_TIPS (3) > W_PLAYS (1)
        expect(compareSearchSuggestions(byTips, byPlays, 'track')).toBeLessThan(0);
    });

    it('newer item wins when scores differ only by recency', () => {
        const newItem = make({ id: 'a', title: 'Alpha', plays: 100, createdAt: NOW });
        const oldItem = make({ id: 'b', title: 'Alpha', plays: 100, createdAt: YEAR_AGO });
        expect(compareSearchSuggestions(newItem, oldItem, 'alpha')).toBeLessThan(0);
    });

    it('identical scores fall back to alphabetical order (deterministic)', () => {
        // Construct two items with scores that are numerically equal
        const a = make({ id: 'a', title: 'Zebra', plays: 0, tips: 0, createdAt: undefined });
        const b = make({ id: 'b', title: 'Apple', plays: 0, tips: 0, createdAt: undefined });
        // Alpha tie-breaker: Apple < Zebra
        expect(compareSearchSuggestions(a, b, '')).toBeGreaterThan(0);
    });

    it('comparison is deterministic — same result on repeated calls', () => {
        const x = make({ id: 'x', title: 'Echo', plays: 50, tips: 5 });
        const y = make({ id: 'y', title: 'Alpha', plays: 50, tips: 5 });
        const r1 = compareSearchSuggestions(x, y, 'test');
        const r2 = compareSearchSuggestions(x, y, 'test');
        expect(r1).toBe(r2);
    });
});

// ---------------------------------------------------------------------------
// rankSuggestions — full pipeline
// ---------------------------------------------------------------------------

describe('rankSuggestions', () => {
    it('returns a new array — does not mutate input', () => {
        const items = [make({ id: 'a', title: 'A' }), make({ id: 'b', title: 'B' })];
        const originalFirstId = items[0].id;
        rankSuggestions(items, 'test');
        expect(items[0].id).toBe(originalFirstId);
    });

    it('empty input returns empty output', () => {
        expect(rankSuggestions([], 'q')).toEqual([]);
    });

    it('prefix-matching item leads the list even against high-engagement non-prefix items', () => {
        const items: SearchSuggestionItem[] = [
            make({ id: 'high-plays', title: 'Great Wave', plays: 5_000_000, tips: 50_000 }),
            make({ id: 'prefix', title: 'Wave Rider', plays: 100, tips: 5 }),
            make({ id: 'mid-plays', title: 'Amazing Wave', plays: 2_000_000, tips: 20_000 }),
        ];
        const ranked = rankSuggestions(items, 'wave');
        expect(ranked[0].id).toBe('prefix');
    });

    it('among non-prefix items, most-engaged ranks first', () => {
        const items: SearchSuggestionItem[] = [
            make({ id: 'low', title: 'Beat A', plays: 100, tips: 1 }),
            make({ id: 'high', title: 'Beat B', plays: 50_000, tips: 500 }),
        ];
        const ranked = rankSuggestions(items, 'something-else');
        expect(ranked[0].id).toBe('high');
    });
});
