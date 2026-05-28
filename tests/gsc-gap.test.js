'use strict';

const { detectLowCtrPages, detectPage2Opportunities, detectQueryWithoutPage } = require('../agents/gsc-gap');

const PAGE_ROWS = [
  { keys: ['https://tradolux.com/features'], impressions: 1200, clicks: 10, ctr: 0.0083, position: 5.2 },
  { keys: ['https://tradolux.com/pricing'],  impressions: 150,  clicks: 3,  ctr: 0.021,  position: 7.0 },
  { keys: ['https://tradolux.com/blog'],     impressions: 500,  clicks: 25, ctr: 0.05,   position: 3.1 },
  { keys: ['https://tradolux.com/about'],    impressions: 80,   clicks: 1,  ctr: 0.012,  position: 8.0 },
  { keys: ['https://tradolux.com/signals'],  impressions: 300,  clicks: 4,  ctr: 0.013,  position: 15.3 },
  { keys: ['https://tradolux.com/terminal'], impressions: 220,  clicks: 2,  ctr: 0.009,  position: 11.0 },
  { keys: ['https://tradolux.com/alerts'],   impressions: 180,  clicks: 6,  ctr: 0.033,  position: 10.5 },
  { keys: ['https://tradolux.com/docs'],     impressions: 90,   clicks: 1,  ctr: 0.011,  position: 20.5 },
];

const QUERY_ROWS = [
  { keys: ['AI trading terminal'], impressions: 800, clicks: 5, ctr: 0.006, position: 14 },
  { keys: ['stock analysis AI'],   impressions: 300, clicks: 2, ctr: 0.007, position: 12 },
  { keys: ['obscure query'],       impressions: 30,  clicks: 0, ctr: 0,     position: 18 },
  { keys: ['trading signals'],     impressions: 150, clicks: 8, ctr: 0.053, position: 6  },
];

const PAGE_QUERY_ROWS = [
  { keys: ['https://tradolux.com/',           'AI trading terminal'] },
  { keys: ['https://tradolux.com/features',   'AI trading terminal'] },
  { keys: ['https://tradolux.com/signals',    'AI trading terminal'] },
  { keys: ['https://tradolux.com/blog/intro', 'AI trading terminal'] },
  { keys: ['https://tradolux.com/',           'stock analysis AI']   },
  { keys: ['https://tradolux.com/signals',    'trading signals']     },
];

describe('detectLowCtrPages', function() {
  var results;
  beforeAll(function() { results = detectLowCtrPages(PAGE_ROWS); });

  it('returns an array', function() { expect(Array.isArray(results)).toBe(true); });

  it('flags pages with impressions > 100 AND ctr < 3%', function() {
    const pages = results.map(function(r) { return r.page; });
    expect(pages).toContain('https://tradolux.com/features');
    expect(pages).toContain('https://tradolux.com/pricing');
  });

  it('does NOT flag page with CTR above 3%', function() {
    expect(results.map(function(r) { return r.page; })).not.toContain('https://tradolux.com/blog');
  });

  it('does NOT flag page with impressions below 100', function() {
    expect(results.map(function(r) { return r.page; })).not.toContain('https://tradolux.com/about');
  });

  it('converts CTR to percentage', function() {
    const feat = results.find(function(r) { return r.page === 'https://tradolux.com/features'; });
    expect(feat.ctr).toBeLessThan(3);
    expect(feat.ctr).toBeGreaterThan(0);
  });

  it('sorts by impressions descending', function() {
    for (var i = 1; i < results.length; i++) {
      expect(results[i-1].impressions).toBeGreaterThanOrEqual(results[i].impressions);
    }
  });

  it('each result has required fields', function() {
    results.forEach(function(r) {
      expect(r.type).toBe('low_ctr_page');
      ['page','impressions','ctr','clicks','position','recommendation'].forEach(function(f) {
        expect(r).toHaveProperty(f);
      });
    });
  });

  it('returns empty array when no rows qualify', function() {
    expect(detectLowCtrPages([{ keys: ['https://x.com/'], impressions: 50, clicks: 5, ctr: 0.1, position: 1 }])).toEqual([]);
  });
});

describe('detectPage2Opportunities', function() {
  var results;
  beforeAll(function() { results = detectPage2Opportunities(PAGE_ROWS); });

  it('flags pages with position 11-20 inclusive', function() {
    const pages = results.map(function(r) { return r.page; });
    expect(pages).toContain('https://tradolux.com/signals');
    expect(pages).toContain('https://tradolux.com/terminal');
  });

  it('does NOT flag position 10.5 (below range)', function() {
    expect(results.map(function(r) { return r.page; })).not.toContain('https://tradolux.com/alerts');
  });

  it('does NOT flag position 20.5 (above range)', function() {
    expect(results.map(function(r) { return r.page; })).not.toContain('https://tradolux.com/docs');
  });

  it('sorts by impressions descending', function() {
    for (var i = 1; i < results.length; i++) {
      expect(results[i-1].impressions).toBeGreaterThanOrEqual(results[i].impressions);
    }
  });

  it('each result has type page_2_opportunity and required fields', function() {
    results.forEach(function(r) {
      expect(r.type).toBe('page_2_opportunity');
      ['page','position','impressions','clicks','ctr','recommendation'].forEach(function(f) {
        expect(r).toHaveProperty(f);
      });
    });
  });
});

describe('detectQueryWithoutPage', function() {
  var results;
  beforeAll(function() { results = detectQueryWithoutPage(QUERY_ROWS, PAGE_QUERY_ROWS); });

  it('flags queries spread across more than 3 pages', function() {
    expect(results.map(function(r) { return r.query; })).toContain('AI trading terminal');
  });

  it('flags queries whose only page is the homepage', function() {
    expect(results.map(function(r) { return r.query; })).toContain('stock analysis AI');
  });

  it('does NOT flag queries with impressions <= 50', function() {
    expect(results.map(function(r) { return r.query; })).not.toContain('obscure query');
  });

  it('does NOT flag queries with a dedicated non-homepage page', function() {
    expect(results.map(function(r) { return r.query; })).not.toContain('trading signals');
  });

  it('includes pages array in each result', function() {
    const ai = results.find(function(r) { return r.query === 'AI trading terminal'; });
    expect(Array.isArray(ai.pages)).toBe(true);
    expect(ai.pages.length).toBeGreaterThan(0);
  });

  it('each result has type missing_landing_page and required fields', function() {
    results.forEach(function(r) {
      expect(r.type).toBe('missing_landing_page');
      ['query','impressions','clicks','ctr','position','pages','recommendation'].forEach(function(f) {
        expect(r).toHaveProperty(f);
      });
    });
  });

  it('flags queries with no page data at all', function() {
    const r = detectQueryWithoutPage(
      [{ keys: ['ghost query'], impressions: 200, clicks: 0, ctr: 0, position: 20 }], []
    );
    expect(r[0].query).toBe('ghost query');
  });
});
