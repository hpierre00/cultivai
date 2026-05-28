'use strict';

const { classifyPr, computeStats } = require('../agents/outcome-tracker');

// ── classifyPr ────────────────────────────────────────────────────────────────

describe('classifyPr', function() {
  it('returns "merged" when merged_at is set', function() {
    const pr = { merged_at: '2025-05-01T10:00:00Z', state: 'closed' };
    expect(classifyPr(pr)).toBe('merged');
  });

  it('returns "rejected" when state is closed and merged_at is null', function() {
    const pr = { merged_at: null, state: 'closed' };
    expect(classifyPr(pr)).toBe('rejected');
  });

  it('returns "rejected" when state is closed and merged_at is undefined', function() {
    const pr = { state: 'closed' };
    expect(classifyPr(pr)).toBe('rejected');
  });

  it('returns "open" for open PRs', function() {
    const pr = { merged_at: null, state: 'open' };
    expect(classifyPr(pr)).toBe('open');
  });

  it('prioritizes merged_at over state', function() {
    // A PR with merged_at set should be "merged" regardless of state string
    const pr = { merged_at: '2025-05-01T10:00:00Z', state: 'open' };
    expect(classifyPr(pr)).toBe('merged');
  });
});

// ── computeStats ──────────────────────────────────────────────────────────────

const HISTORY = [
  {
    date: '2025-05-01',
    prs:  [
      { outcome: 'merged' },
      { outcome: 'merged' },
      { outcome: 'rejected' },
    ],
  },
  {
    date: '2025-05-08',
    prs:  [
      { outcome: 'merged' },
      { outcome: 'open' },
      { outcome: 'rejected' },
    ],
  },
  {
    date: '2025-05-15',
    prs:  [
      { outcome: 'open' },
      { outcome: 'open' },
    ],
  },
];

describe('computeStats', function() {
  var stats;
  beforeAll(function() { stats = computeStats(HISTORY); });

  it('counts merged correctly', function() {
    expect(stats.merged).toBe(3); // 2 + 1
  });

  it('counts rejected correctly', function() {
    expect(stats.rejected).toBe(2); // 1 + 1
  });

  it('counts open correctly', function() {
    expect(stats.open).toBe(3); // 1 + 2
  });

  it('computes acceptance rate as merged / (merged + rejected)', function() {
    // 3 merged out of 5 decided = 0.6
    expect(stats.acceptanceRate).toBe(0.6);
  });

  it('returns null acceptanceRate when no decided PRs', function() {
    const s = computeStats([{ date: '2025-01-01', prs: [{ outcome: 'open' }] }]);
    expect(s.acceptanceRate).toBeNull();
  });

  it('returns zero counts for empty history', function() {
    const s = computeStats([]);
    expect(s.merged).toBe(0);
    expect(s.rejected).toBe(0);
    expect(s.open).toBe(0);
    expect(s.acceptanceRate).toBeNull();
  });

  it('handles history entries with no prs array', function() {
    const s = computeStats([{ date: '2025-01-01' }]);
    expect(s.merged).toBe(0);
    expect(s.acceptanceRate).toBeNull();
  });

  it('100% acceptance rate when all merged', function() {
    const s = computeStats([{ prs: [{ outcome: 'merged' }, { outcome: 'merged' }] }]);
    expect(s.acceptanceRate).toBe(1);
  });

  it('0% acceptance rate when all rejected', function() {
    const s = computeStats([{ prs: [{ outcome: 'rejected' }, { outcome: 'rejected' }] }]);
    expect(s.acceptanceRate).toBe(0);
  });
});
