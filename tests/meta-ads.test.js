'use strict';

const {
  detectLowRelevanceAdSets,
  detectHighFrequencyAdSets,
  detectCpmTrend,
} = require('../agents/meta-ads');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AD_SETS = [
  // flagged: below-average quality ranking
  { id: 'as1', name: 'Awareness US', campaign_id: 'c1', impressions: '5000', reach: '4000', frequency: '1.2', spend: '150', quality_ranking: 'BELOW_AVERAGE_10', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'AVERAGE' },
  // flagged: below-average engagement
  { id: 'as2', name: 'Retarget Cart', campaign_id: 'c1', impressions: '2000', reach: '1800', frequency: '2.1', spend: '80',  quality_ranking: 'AVERAGE', engagement_rate_ranking: 'BELOW_AVERAGE_20', conversion_rate_ranking: 'AVERAGE' },
  // NOT flagged: all average
  { id: 'as3', name: 'Lookalike High', campaign_id: 'c2', impressions: '8000', reach: '7000', frequency: '1.5', spend: '300', quality_ranking: 'AVERAGE', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'AVERAGE' },
  // NOT flagged: above average
  { id: 'as4', name: 'Top Performer', campaign_id: 'c2', impressions: '4000', reach: '3500', frequency: '1.0', spend: '200', quality_ranking: 'ABOVE_AVERAGE', engagement_rate_ranking: 'ABOVE_AVERAGE', conversion_rate_ranking: 'ABOVE_AVERAGE' },
  // high frequency — flagged
  { id: 'as5', name: 'Stale Creative', campaign_id: 'c3', impressions: '6000', reach: '1500', frequency: '4.0', spend: '220', quality_ranking: 'AVERAGE', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'AVERAGE' },
  // high frequency (exactly > 3.0)
  { id: 'as6', name: 'Over-served', campaign_id: 'c3', impressions: '3000', reach: '700',  frequency: '3.5', spend: '100', quality_ranking: 'AVERAGE', engagement_rate_ranking: 'BELOW_AVERAGE_35', conversion_rate_ranking: 'AVERAGE' },
  // NOT flagged: frequency exactly 3.0
  { id: 'as7', name: 'At Limit',   campaign_id: 'c4', impressions: '2000', reach: '650',  frequency: '3.0', spend: '90',  quality_ranking: 'AVERAGE', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'AVERAGE' },
];

const THIS_WEEK = [
  { campaign_id: 'c1', campaign_name: 'Brand',      impressions: '5000', spend: '200', cpm: '40' },
  { campaign_id: 'c2', campaign_name: 'Prospecting', impressions: '8000', spend: '240', cpm: '30' },
  { campaign_id: 'c3', campaign_name: 'Retargeting', impressions: '3000', spend: '120', cpm: '40' },
];

const PRIOR_WEEK = [
  { campaign_id: 'c1', campaign_name: 'Brand',      impressions: '6000', spend: '180', cpm: '30' }, // CPM rose 33% -- flagged
  { campaign_id: 'c2', campaign_name: 'Prospecting', impressions: '9000', spend: '225', cpm: '25' }, // CPM rose 20% -- NOT flagged (exactly 20%)
  { campaign_id: 'c3', campaign_name: 'Retargeting', impressions: '2800', spend: '100', cpm: '36' }, // CPM rose 11% -- not flagged
  { campaign_id: 'c4', campaign_name: 'New',         impressions: '1000', spend: '50',  cpm: '50' }, // no current-week match
];

// ── detectLowRelevanceAdSets ──────────────────────────────────────────────────

describe('detectLowRelevanceAdSets', function() {
  var results;
  beforeAll(function() { results = detectLowRelevanceAdSets(AD_SETS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags ad sets with below-average quality ranking', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).toContain('Awareness US');
  });

  it('flags ad sets with below-average engagement ranking', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).toContain('Retarget Cart');
  });

  it('does NOT flag average-ranked ad sets', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).not.toContain('Lookalike High');
  });

  it('does NOT flag above-average ad sets', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).not.toContain('Top Performer');
  });

  it('each result has type low_relevance_ad_set', function() {
    results.forEach(function(r) { expect(r.type).toBe('low_relevance_ad_set'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('adSetId');
      expect(r).toHaveProperty('adSetName');
      expect(r).toHaveProperty('campaignId');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array when no below-average ad sets', function() {
    const none = detectLowRelevanceAdSets([
      { id: 'a1', name: 'Good', campaign_id: 'c1', impressions: '100', reach: '90', frequency: '1.1', spend: '10', quality_ranking: 'AVERAGE', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'AVERAGE' },
    ]);
    expect(none).toEqual([]);
  });
});

// ── detectHighFrequencyAdSets ─────────────────────────────────────────────────

describe('detectHighFrequencyAdSets', function() {
  var results;
  beforeAll(function() { results = detectHighFrequencyAdSets(AD_SETS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags ad sets with frequency > 3.0', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).toContain('Stale Creative');
    expect(names).toContain('Over-served');
  });

  it('does NOT flag frequency exactly 3.0', function() {
    const names = results.map(function(r) { return r.adSetName; });
    expect(names).not.toContain('At Limit');
  });

  it('sorts by frequency descending (worst first)', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].frequency).toBeGreaterThanOrEqual(results[i].frequency);
    }
  });

  it('each result has type high_frequency_ad_set', function() {
    results.forEach(function(r) { expect(r.type).toBe('high_frequency_ad_set'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('adSetId');
      expect(r).toHaveProperty('adSetName');
      expect(r).toHaveProperty('frequency');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array when no high-frequency ad sets', function() {
    const none = detectHighFrequencyAdSets([
      { id: 'a1', name: 'Low freq', campaign_id: 'c1', frequency: '2.0', impressions: '100', reach: '90', spend: '10' },
    ]);
    expect(none).toEqual([]);
  });
});

// ── detectCpmTrend ────────────────────────────────────────────────────────────

describe('detectCpmTrend', function() {
  var results;
  beforeAll(function() { results = detectCpmTrend(THIS_WEEK, PRIOR_WEEK); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags campaigns with CPM increase > 20%', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).toContain('Brand'); // 33% increase
  });

  it('does NOT flag campaigns with exactly 20% CPM increase', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Prospecting'); // exactly 20%
  });

  it('does NOT flag campaigns with < 20% CPM increase', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Retargeting'); // 11%
  });

  it('sorts by changePercent descending', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].changePercent).toBeGreaterThanOrEqual(results[i].changePercent);
    }
  });

  it('each result has type cpm_trend_increase', function() {
    results.forEach(function(r) { expect(r.type).toBe('cpm_trend_increase'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('campaignId');
      expect(r).toHaveProperty('campaignName');
      expect(r).toHaveProperty('cpmThisWeek');
      expect(r).toHaveProperty('cpmPriorWeek');
      expect(r).toHaveProperty('changePercent');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('skips campaigns with no prior week data', function() {
    // Campaign c4 is only in prior week (not current week) -- should not appear
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('New');
  });

  it('returns empty array when both inputs are empty', function() {
    expect(detectCpmTrend([], [])).toEqual([]);
  });
});
