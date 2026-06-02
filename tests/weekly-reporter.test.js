'use strict';

const { aggregateSite, buildHtml } = require('../agents/weekly-reporter');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SITE_CONFIG = {
  name:        'tradolux',
  displayName: 'Tradolux',
};

// Helper: write temp report files to a temp dir and swap REPORTS_DIR
// Instead, we test aggregateSite by confirming it handles empty date ranges cleanly

// ── aggregateSite — no report files ──────────────────────────────────────────

describe('aggregateSite — no report files present', function () {
  it('returns zero counts for all metrics', function () {
    // Using a date far in the past so no reports exist
    const pastDates = ['1990-01-01', '1990-01-02'];
    const result = aggregateSite(SITE_CONFIG, pastDates);

    expect(result.site).toBe('tradolux');
    expect(result.displayName).toBe('Tradolux');
    expect(result.improvements.generated).toBe(0);
    expect(result.improvements.vettedOut).toBe(0);
    expect(result.improvements.applied).toBe(0);
    expect(result.improvements.verified).toBe(0);
    expect(result.improvements.verifyFailed).toBe(0);
    expect(result.prs.created).toBe(0);
    expect(result.prs.merged).toBe(0);
    expect(result.prs.rejected).toBe(0);
    expect(result.prs.mergeRate).toBe('N/A');
  });

  it('defaults to YELLOW status when no data', function () {
    const result = aggregateSite(SITE_CONFIG, ['1990-01-01']);
    expect(result.status).toBe('YELLOW');
  });

  it('returns N/A for confidence rates when no data', function () {
    const result = aggregateSite(SITE_CONFIG, ['1990-01-01']);
    expect(result.confidence.highConfidenceApplyRate).toBe('N/A');
    expect(result.confidence.lowConfidenceApplyRate).toBe('N/A');
  });
});

// ── buildHtml ─────────────────────────────────────────────────────────────────

describe('buildHtml', function () {
  const WEEKLY_DATA = {
    period: { start: '2025-05-25', end: '2025-06-01' },
    generatedAt: new Date().toISOString(),
    summary: {
      totalPrsMerged: 2,
      totalImprovementsApplied: 8,
      totalVettedOut: 1,
      totalVerified: 7,
      totalVerifyFailed: 0,
      overallHealth: 'GREEN',
    },
    sites: [
      {
        site:        'tradolux',
        displayName: 'Tradolux',
        status:      'GREEN',
        improvements: { generated: 5, vettedOut: 1, applied: 4, verified: 4, verifyFailed: 0 },
        prs:         { created: 1, merged: 1, rejected: 0, mergeRate: '100%' },
        confidence:  { highConfidenceApplyRate: '90%', lowConfidenceApplyRate: '60%', note: '' },
        gscDelta:    { lowCtrPageCount: 3, note: 'Lower is better' },
        timeline:    { improvementsByDate: [], vettingByDate: [], verificationsByDate: [] },
      },
      {
        site:        'lawverra',
        displayName: 'Lawverra',
        status:      'RED',
        improvements: { generated: 4, vettedOut: 0, applied: 4, verified: 3, verifyFailed: 1 },
        prs:         { created: 1, merged: 0, rejected: 1, mergeRate: '0%' },
        confidence:  { highConfidenceApplyRate: 'N/A', lowConfidenceApplyRate: 'N/A', note: '' },
        gscDelta:    null,
        timeline:    { improvementsByDate: [], vettingByDate: [], verificationsByDate: [] },
      },
    ],
  };

  var html;
  beforeAll(function () {
    html = buildHtml(WEEKLY_DATA, '2025-05-25 → 2025-06-01');
  });

  it('returns a non-empty string', function () {
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('is valid HTML (starts with DOCTYPE)', function () {
    expect(html.trim()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('includes the period label', function () {
    expect(html).toContain('2025-05-25');
    expect(html).toContain('2025-06-01');
  });

  it('includes site display names', function () {
    expect(html).toContain('Tradolux');
    expect(html).toContain('Lawverra');
  });

  it('includes status badges', function () {
    expect(html.toLowerCase()).toContain('green');
    expect(html.toLowerCase()).toContain('red');
  });

  it('includes improvement metrics', function () {
    expect(html).toContain('100%'); // merge rate
    expect(html).toContain('90%');  // high-conf apply rate
  });

  it('includes verify-failed alert for Lawverra', function () {
    expect(html).toContain('1 improvement(s) not confirmed');
  });

  it('includes PR rejected alert for Lawverra', function () {
    expect(html).toContain('1 PR(s) closed without merging');
  });

  it('includes GSC note for Tradolux', function () {
    expect(html).toContain('3 low-CTR pages');
  });

  it('includes the progress key legend', function () {
    expect(html).toContain('merged and verified');
    expect(html).toContain('pending');
    expect(html).toContain('verify failed');
  });

  it('handles singular verify-failed correctly (1 improvement)', function () {
    // Lawverra has 1 verifyFailed — text should say "improvement(s)" but not "improvements(s)"
    expect(html).toContain('improvement(s)');
  });
});
