'use strict';

const {
  detectLowQualityScoreKeywords,
  detectBudgetImpShareLoss,
  detectLowAvgPosition,
  parseCsvLine,
} = require('../agents/bing-ads');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KW_ROWS = [
  // flagged: QS 2
  { 'Campaign Id': 'c1', 'Campaign': 'Brand', 'Ad Group': 'Exact', 'Keyword': 'best trading software', 'Match Type': 'Exact', 'Quality Score': '2', 'Impressions': '1200', 'Clicks': '30', 'Spend': '150' },
  // flagged: QS 4
  { 'Campaign Id': 'c1', 'Campaign': 'Brand', 'Ad Group': 'Broad', 'Keyword': 'stock market alerts', 'Match Type': 'Broad', 'Quality Score': '4', 'Impressions': '500', 'Clicks': '8', 'Spend': '40' },
  // NOT flagged: QS 6
  { 'Campaign Id': 'c2', 'Campaign': 'Competitor', 'Ad Group': 'Phrase', 'Keyword': 'trading platform review', 'Match Type': 'Phrase', 'Quality Score': '6', 'Impressions': '800', 'Clicks': '20', 'Spend': '90' },
  // NOT flagged: QS 5 (boundary — must be strictly less than 5)
  { 'Campaign Id': 'c2', 'Campaign': 'Competitor', 'Ad Group': 'Exact', 'Keyword': 'trade signals', 'Match Type': 'Exact', 'Quality Score': '5', 'Impressions': '300', 'Clicks': '9', 'Spend': '30' },
  // NOT flagged: QS 0 (no data)
  { 'Campaign Id': 'c3', 'Campaign': 'DSA', 'Ad Group': 'Auto', 'Keyword': '--', 'Match Type': 'N/A', 'Quality Score': '0', 'Impressions': '200', 'Clicks': '4', 'Spend': '20' },
];

const CAMP_ROWS = [
  // flagged: 42% budget IS loss
  { 'Campaign Id': 'c1', 'Campaign': 'Brand Awareness', 'Impressions': '3000', 'Clicks': '90', 'Spend': '200', 'Avg. Position': '2.1', 'Budget Lost IS (Search)': '42%' },
  // NOT flagged: 18%
  { 'Campaign Id': 'c2', 'Campaign': 'Retargeting', 'Impressions': '5000', 'Clicks': '200', 'Spend': '300', 'Avg. Position': '1.8', 'Budget Lost IS (Search)': '18%' },
  // NOT flagged: 20% (exactly — threshold is > 20)
  { 'Campaign Id': 'c3', 'Campaign': 'Competitor', 'Impressions': '2000', 'Clicks': '60', 'Spend': '150', 'Avg. Position': '3.2', 'Budget Lost IS (Search)': '20%' },
  // flagged: low avg position 5.8
  { 'Campaign Id': 'c4', 'Campaign': 'Low Bids', 'Impressions': '1800', 'Clicks': '20', 'Spend': '80', 'Avg. Position': '5.8', 'Budget Lost IS (Search)': '10%' },
  // NOT flagged: avg position 3.9 (below threshold of > 4.0)
  { 'Campaign Id': 'c5', 'Campaign': 'Good Position', 'Impressions': '4000', 'Clicks': '160', 'Spend': '250', 'Avg. Position': '3.9', 'Budget Lost IS (Search)': '5%' },
];

// ── parseCsvLine ──────────────────────────────────────────────────────────────

describe('parseCsvLine', function() {
  it('parses a simple comma-separated line', function() {
    const result = parseCsvLine('Brand,Exact,best trading software,2');
    expect(result).toEqual(['Brand', 'Exact', 'best trading software', '2']);
  });

  it('handles quoted fields with commas inside', function() {
    const result = parseCsvLine('"Brand, US",Exact,"high quality, certified",5');
    expect(result).toContain('Brand, US');
    expect(result).toContain('high quality, certified');
  });

  it('handles escaped quotes inside quoted fields', function() {
    const result = parseCsvLine('"Say ""hello"" world",test');
    expect(result[0]).toBe('Say "hello" world');
  });

  it('trims whitespace from unquoted fields', function() {
    const result = parseCsvLine('  Brand  ,  Exact  ');
    expect(result[0]).toBe('Brand');
    expect(result[1]).toBe('Exact');
  });
});

// ── detectLowQualityScoreKeywords ─────────────────────────────────────────────

describe('detectLowQualityScoreKeywords (Bing)', function() {
  var results;
  beforeAll(function() { results = detectLowQualityScoreKeywords(KW_ROWS); });

  it('returns an array', function() {
    expect(Array.isArray(results)).toBe(true);
  });

  it('flags keywords with QS < 5', function() {
    const kws = results.map(function(r) { return r.keyword; });
    expect(kws).toContain('best trading software');
    expect(kws).toContain('stock market alerts');
  });

  it('does NOT flag QS 5 (boundary — strictly less than)', function() {
    const kws = results.map(function(r) { return r.keyword; });
    expect(kws).not.toContain('trade signals');
  });

  it('does NOT flag QS 6', function() {
    const kws = results.map(function(r) { return r.keyword; });
    expect(kws).not.toContain('trading platform review');
  });

  it('does NOT flag QS 0 (no data)', function() {
    const kws = results.map(function(r) { return r.keyword; });
    expect(kws).not.toContain('--');
  });

  it('sorts by QS ascending (worst first)', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].qualityScore).toBeLessThanOrEqual(results[i].qualityScore);
    }
  });

  it('each result has type low_quality_score', function() {
    results.forEach(function(r) { expect(r.type).toBe('low_quality_score'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('keyword');
      expect(r).toHaveProperty('matchType');
      expect(r).toHaveProperty('qualityScore');
      expect(r).toHaveProperty('campaignName');
      expect(r).toHaveProperty('recommendation');
    });
  });
});

// ── detectBudgetImpShareLoss (Bing) ──────────────────────────────────────────

describe('detectBudgetImpShareLoss (Bing)', function() {
  var results;
  beforeAll(function() { results = detectBudgetImpShareLoss(CAMP_ROWS); });

  it('flags campaigns with > 20% budget IS loss', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).toContain('Brand Awareness'); // 42%
  });

  it('does NOT flag exactly 20%', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Competitor');
  });

  it('does NOT flag 18%', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Retargeting');
  });

  it('sorts by loss descending', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].budgetLostImpressionShare).toBeGreaterThanOrEqual(results[i].budgetLostImpressionShare);
    }
  });

  it('each result has type budget_impression_share_loss', function() {
    results.forEach(function(r) { expect(r.type).toBe('budget_impression_share_loss'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('campaignId');
      expect(r).toHaveProperty('campaignName');
      expect(r).toHaveProperty('budgetLostImpressionShare');
      expect(r).toHaveProperty('recommendation');
    });
  });
});

// ── detectLowAvgPosition ──────────────────────────────────────────────────────

describe('detectLowAvgPosition', function() {
  var results;
  beforeAll(function() { results = detectLowAvgPosition(CAMP_ROWS); });

  it('flags campaigns with avg position > 4.0', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).toContain('Low Bids'); // 5.8
  });

  it('does NOT flag avg position 3.9', function() {
    const names = results.map(function(r) { return r.campaignName; });
    expect(names).not.toContain('Good Position');
  });

  it('sorts by position descending (worst first)', function() {
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].avgPosition).toBeGreaterThanOrEqual(results[i].avgPosition);
    }
  });

  it('each result has type low_avg_position', function() {
    results.forEach(function(r) { expect(r.type).toBe('low_avg_position'); });
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r).toHaveProperty('campaignId');
      expect(r).toHaveProperty('campaignName');
      expect(r).toHaveProperty('avgPosition');
      expect(r).toHaveProperty('recommendation');
    });
  });

  it('returns empty array when all positions are fine', function() {
    const none = detectLowAvgPosition([
      { 'Campaign Id': 'c1', 'Campaign': 'Fine', 'Avg. Position': '2.1', 'Budget Lost IS (Search)': '5%', 'Impressions': '1000', 'Spend': '50' },
    ]);
    expect(none).toEqual([]);
  });
});
