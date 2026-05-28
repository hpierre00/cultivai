'use strict';

const {
  detectLowQualityScoreKeywords,
  detectLowCtrAdGroups,
  detectBudgetImpShareLoss,
} = require('../agents/google-ads');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const QS_ROWS = [
  // flagged: QS 3
  {
    campaign:  { id: 'c1' },
    adGroup:   { id: 'ag1' },
    adGroupCriterion: {
      keyword:     { text: 'best trading platform', matchType: 'BROAD' },
      qualityInfo: { qualityScore: 3, searchExpectedCtr: 'BELOW_AVERAGE', adRelevance: 'AVERAGE', landingPageExperience: 'BELOW_AVERAGE' },
    },
  },
  // flagged: QS 4
  {
    campaign:  { id: 'c1' },
    adGroup:   { id: 'ag2' },
    adGroupCriterion: {
      keyword:     { text: 'stock alerts', matchType: 'PHRASE' },
      qualityInfo: { qualityScore: 4, searchExpectedCtr: 'AVERAGE', adRelevance: 'BELOW_AVERAGE', landingPageExperience: 'AVERAGE' },
    },
  },
  // NOT flagged: QS 7
  {
    campaign:  { id: 'c2' },
    adGroup:   { id: 'ag3' },
    adGroupCriterion: {
      keyword:     { text: 'trading signals', matchType: 'EXACT' },
      qualityInfo: { qualityScore: 7, searchExpectedCtr: 'ABOVE_AVERAGE', adRelevance: 'ABOVE_AVERAGE', landingPageExperience: 'ABOVE_AVERAGE' },
    },
  },
  // NOT flagged: QS 5 (threshold is < 5)
  {
    campaign:  { id: 'c2' },
    adGroup:   { id: 'ag4' },
    adGroupCriterion: {
      keyword:     { text: 'AI charts', matchType: 'BROAD' },
      qualityInfo: { qualityScore: 5, searchExpectedCtr: 'AVERAGE', adRelevance: 'AVERAGE', landingPageExperience: 'AVERAGE' },
    },
  },
];

const AD_GROUP_ROWS = [
  // Low CTR ad group — 0.5% vs account avg of ~2%
  { campaign: { id: 'c1' }, adGroup: { id: 'ag1', name: 'Brand terms' },      metrics: { clicks: '5',  impressions: '1000' } },
  // Low CTR — 1%
  { campaign: { id: 'c1' }, adGroup: { id: 'ag2', name: 'Competitor terms' }, metrics: { clicks: '10', impressions: '1000' } },
  // High CTR — 5% (above avg)
  { campaign: { id: 'c2' }, adGroup: { id: 'ag3', name: 'High intent' },      metrics: { clicks: '50', impressions: '1000' } },
  // Insufficient impressions — excluded
  { campaign: { id: 'c2' }, adGroup: { id: 'ag4', name: 'New group' },        metrics: { clicks: '1',  impressions: '50' } },
];

const IS_ROWS = [
  // flagged: 35% budget IS loss
  { campaign: { id: 'c1', name: 'Awareness Campaign' }, metrics: { searchImpressionShare: '0.45', searchBudgetLostImpressionShare: '0.35' } },
  // NOT flagged: 15% budget IS loss
  { campaign: { id: 'c2', name: 'Retargeting' },        metrics: { searchImpressionShare: '0.70', searchBudgetLostImpressionShare: '0.15' } },
  // NOT flagged: exactly 20% (threshold is > 0.2, not >=)
  { campaign: { id: 'c3', name: 'Brand' },              metrics: { searchImpressionShare: '0.60', searchBudgetLostImpressionShare: '0.20' } },
  // flagged: 55%
  { campaign: { id: 'c4', name: 'ROAS campaign' },      metrics: { searchImpressionShare: '0.30', searchBudgetLostImpressionShare: '0.55' } },
];

// ── detectLowQualityScoreKeywords ─────────────────────────────────────────────

describe('detectLowQualityScoreKeywords', function() {
  var results;
  beforeAll(function() { results = detectLowQualityScoreKeywords(QS_ROWS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags keywords with QS < 5', function() {
    const keywords = results.map(function(r) { return r.keyword; });
    expect(keywords).toContain('best trading platform');
    expect(keywords).toContain('stock alerts');
  });

  it('does NOT flag QS 5 (threshold is strictly less than 5)', function() {
    const keywords = results.map(function(r) { return r.keyword; });
    expect(keywords).not.toContain('AI charts');
  });

  it('does NOT flag QS 7', function() {
    const keywords = results.map(function(r) { return r.keyword; });
    expect(keywords).not.toContain('trading signals');
  });

  it('sorts by QS ascending (worst first)', function() {
    expect(results[0].qualityScore).toBeLessThanOrEqual(results[results.length - 1].qualityScore);
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('type', 'low_quality_score');
      expect(r).toHaveProperty('keyword');
      expect(r).toHaveProperty('qualityScore');
      expect(r).toHaveProperty('expectedCtr');
      expect(r).toHaveProperty('adRelevance');
      expect(r).toHaveProperty('landingPageExperience');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array when no low-QS keywords', function() {
    const none = detectLowQualityScoreKeywords([]);
    expect(none).toEqual([]);
  });

  it('handles missing qualityInfo gracefully', function() {
    const rows = [{ campaign: { id: 'c1' }, adGroup: { id: 'ag1' }, adGroupCriterion: { keyword: { text: 'test', matchType: 'BROAD' } } }];
    expect(function() { detectLowQualityScoreKeywords(rows); }).not.toThrow();
    expect(detectLowQualityScoreKeywords(rows)).toEqual([]);
  });
});

// ── detectLowCtrAdGroups ──────────────────────────────────────────────────────

describe('detectLowCtrAdGroups', function() {
  var results;
  beforeAll(function() { results = detectLowCtrAdGroups(AD_GROUP_ROWS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags ad groups with CTR below account average', function() {
    const names = results.map(function(r) { return r.adGroupName; });
    expect(names).toContain('Brand terms');
    expect(names).toContain('Competitor terms');
  });

  it('does NOT flag the high-CTR ad group', function() {
    const names = results.map(function(r) { return r.adGroupName; });
    expect(names).not.toContain('High intent');
  });

  it('excludes ad groups with < 100 impressions', function() {
    const names = results.map(function(r) { return r.adGroupName; });
    expect(names).not.toContain('New group');
  });

  it('sorts by CTR ascending (worst first)', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].ctr).toBeLessThanOrEqual(results[i].ctr);
    }
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('type', 'low_ctr_ad_group');
      expect(r).toHaveProperty('adGroupId');
      expect(r).toHaveProperty('adGroupName');
      expect(r).toHaveProperty('clicks');
      expect(r).toHaveProperty('impressions');
      expect(r).toHaveProperty('ctr');
      expect(r).toHaveProperty('accountAvgCtr');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array for empty input', function() {
    expect(detectLowCtrAdGroups([])).toEqual([]);
  });
});

// ── detectBudgetImpShareLoss ──────────────────────────────────────────────────

describe('detectBudgetImpShareLoss', function() {
  var results;
  beforeAll(function() { results = detectBudgetImpShareLoss(IS_ROWS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags campaigns with > 20% budget IS loss', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).toContain('Awareness Campaign');
    expect(names).toContain('ROAS campaign');
  });

  it('does NOT flag 15% IS loss', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Retargeting');
  });

  it('does NOT flag exactly 20% (threshold is strictly greater than)', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Brand');
  });

  it('sorts by loss descending (worst first)', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].budgetLostImpressionShare).toBeGreaterThanOrEqual(results[i].budgetLostImpressionShare);
    }
  });

  it('each result has type budget_impression_share_loss', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('type', 'budget_impression_share_loss');
    });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('campaignId');
      expect(r).toHaveProperty('campaignName');
      expect(r).toHaveProperty('budgetLostImpressionShare');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array when no campaigns exceed threshold', function() {
    const none = detectBudgetImpShareLoss([
      { campaign: { id: 'c1', name: 'Fine' }, metrics: { searchBudgetLostImpressionShare: '0.05', searchImpressionShare: '0.80' } },
    ]);
    expect(none).toEqual([]);
  });
});
