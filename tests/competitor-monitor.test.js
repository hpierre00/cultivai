'use strict';

const { diffHtml, extractTags, extractPrices, extractCTAs, extractLinks } = require('../agents/competitor-monitor');

const OLD_HTML = '<html><body>'
  + '<h1>The Best Trading Platform</h1>'
  + '<h2>Real-Time Alerts</h2>'
  + '<h2>Advanced Charts</h2>'
  + '<h3>Portfolio Tracking</h3>'
  + '<p>Starting at <strong>$29/mo</strong> for basic plan.</p>'
  + '<button>Start Free Trial</button>'
  + '<a href="/pricing">View Pricing</a>'
  + '<a href="/features">See Features</a>'
  + '</body></html>';

const NEW_HTML = '<html><body>'
  + '<h1>The #1 AI-Powered Trading Platform</h1>'
  + '<h2>Real-Time Alerts</h2>'
  + '<h2>Advanced Charts</h2>'
  + '<h2>AI-Powered Signals</h2>'
  + '<h3>Portfolio Tracking</h3>'
  + '<h3>Risk Analysis Dashboard</h3>'
  + '<p>Starting at <strong>$49/mo</strong> for basic plan.</p>'
  + '<button>Start Free Trial</button>'
  + '<button>Book a Demo</button>'
  + '<a href="/pricing">View Pricing</a>'
  + '<a href="/features">See Features</a>'
  + '<a href="/ai-signals">AI Signals</a>'
  + '<a href="/risk">Risk Tools</a>'
  + '</body></html>';

describe('extractTags', function() {
  it('extracts h1 text', function() {
    expect(extractTags(OLD_HTML, 'h1')).toContain('The Best Trading Platform');
    expect(extractTags(OLD_HTML, 'h1')).toHaveLength(1);
  });
  it('extracts multiple h2 texts', function() {
    const h2s = extractTags(OLD_HTML, 'h2');
    expect(h2s).toContain('Real-Time Alerts');
    expect(h2s).toContain('Advanced Charts');
    expect(h2s).toHaveLength(2);
  });
  it('returns empty array when tag not present', function() {
    expect(extractTags(OLD_HTML, 'h4')).toEqual([]);
  });
  it('trims whitespace', function() {
    expect(extractTags('<h1>  Trimmed  </h1>', 'h1')).toContain('Trimmed');
  });
});

describe('extractPrices', function() {
  it('detects dollar price with /mo', function() {
    expect(extractPrices(OLD_HTML).some(function(p) { return p.includes('29'); })).toBe(true);
  });
  it('returns empty when no prices', function() {
    expect(extractPrices('<p>nothing</p>')).toEqual([]);
  });
  it('detects changed price', function() {
    expect(extractPrices(NEW_HTML).some(function(p) { return p.includes('49'); })).toBe(true);
  });
});

describe('extractCTAs', function() {
  it('extracts button text', function() {
    expect(extractCTAs(OLD_HTML)).toContain('Start Free Trial');
  });
  it('detects new CTA in updated HTML', function() {
    expect(extractCTAs(NEW_HTML)).toContain('Book a Demo');
  });
  it('returns empty when no CTAs', function() {
    expect(extractCTAs('<p>no buttons</p>')).toEqual([]);
  });
});

describe('extractLinks', function() {
  it('extracts href values', function() {
    const links = extractLinks(OLD_HTML);
    expect(links).toContain('/pricing');
    expect(links).toContain('/features');
  });
  it('detects new links', function() {
    const links = extractLinks(NEW_HTML);
    expect(links).toContain('/ai-signals');
    expect(links).toContain('/risk');
  });
});

describe('diffHtml - with changes', function() {
  var changes;
  beforeAll(function() { changes = diffHtml(OLD_HTML, NEW_HTML, 'https://competitor.com'); });

  it('returns an array', function() { expect(Array.isArray(changes)).toBe(true); });

  it('detects h1 change', function() {
    const c = changes.find(function(x) { return x.category === 'heading_change' && x.tag === 'h1'; });
    expect(c).toBeDefined();
    expect(c.added).toContain('The #1 AI-Powered Trading Platform');
    expect(c.removed).toContain('The Best Trading Platform');
  });

  it('detects new h2', function() {
    const c = changes.find(function(x) { return x.category === 'heading_change' && x.tag === 'h2'; });
    expect(c).toBeDefined();
    expect(c.added).toContain('AI-Powered Signals');
  });

  it('detects new feature copy via h3', function() {
    const c = changes.find(function(x) { return x.category === 'new_feature_copy'; });
    expect(c).toBeDefined();
    expect(c.added).toContain('Risk Analysis Dashboard');
  });

  it('detects price change', function() {
    const c = changes.find(function(x) { return x.category === 'price_change'; });
    expect(c).toBeDefined();
    expect(c.added.some(function(p) { return p.includes('49'); })).toBe(true);
    expect(c.removed.some(function(p) { return p.includes('29'); })).toBe(true);
  });

  it('detects new CTA', function() {
    const c = changes.find(function(x) { return x.category === 'new_cta'; });
    expect(c).toBeDefined();
    expect(c.added).toContain('Book a Demo');
  });

  it('detects new pages/links', function() {
    const c = changes.find(function(x) { return x.category === 'new_pages_or_links'; });
    expect(c).toBeDefined();
    expect(c.added.some(function(l) { return l.includes('ai-signals') || l.includes('risk'); })).toBe(true);
  });
});

describe('diffHtml - no changes', function() {
  it('returns empty array when HTML is identical', function() {
    expect(diffHtml(OLD_HTML, OLD_HTML, 'https://competitor.com')).toEqual([]);
  });
});

describe('diffHtml - edge cases', function() {
  it('handles empty old HTML', function() {
    expect(function() { diffHtml('', NEW_HTML, 'https://competitor.com'); }).not.toThrow();
  });
  it('handles empty new HTML', function() {
    expect(function() { diffHtml(OLD_HTML, '', 'https://competitor.com'); }).not.toThrow();
  });
});
