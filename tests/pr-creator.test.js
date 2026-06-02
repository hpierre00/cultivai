'use strict';

const { buildPrBody, applyImprovement, shortHash } = require('../agents/pr-creator');

// Fixtures

const SITE_CONFIG = {
  name:          'tradolux',
  displayName:   'Tradolux',
  github_repo:   'hpierre00/apex-trading',
  github_branch: 'main',
};

const IMPROVEMENTS = [
  {
    type:            'meta',
    file:            'src/pages/index.astro',
    selector:        'meta[name="description"]',
    current:         'Trading for everyone.',
    proposed:        'Institutional-grade trading signals for professional traders.',
    rationale:       'Low CTR page missing primary keyword in meta description.',
    confidence:      0.88,
    source_findings: ['low_ctr_page', 'page_2_opportunity'],
  },
  {
    type:            'heading',
    file:            'src/pages/features.astro',
    selector:        'h1',
    current:         'Our Features',
    proposed:        'Real-Time AI Trading Signals and Portfolio Alerts',
    rationale:       'H1 does not match high-volume query intent.',
    confidence:      0.82,
    source_findings: ['heading_change'],
  },
];

// shortHash

describe('shortHash', function() {
  it('returns a 7-character hex string', function() {
    var h = shortHash('tradolux-2025-01-01-5');
    expect(h).toMatch(/^[0-9a-f]{7}$/);
  });

  it('is deterministic for the same input', function() {
    var a = shortHash('test-input');
    var b = shortHash('test-input');
    expect(a).toBe(b);
  });

  it('differs for different inputs', function() {
    var a = shortHash('input-a');
    var b = shortHash('input-b');
    expect(a).not.toBe(b);
  });
});

// buildPrBody

describe('buildPrBody', function() {
  var body;
  beforeAll(function() {
    body = buildPrBody(IMPROVEMENTS, SITE_CONFIG, '2025-06-01');
  });

  it('returns a non-empty string', function() {
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
  });

  it('includes the site display name', function() {
    expect(body).toContain('Tradolux');
  });

  it('includes the date', function() {
    expect(body).toContain('2025-06-01');
  });

  it('includes improvement count', function() {
    expect(body).toContain('2 changes');
  });

  it('includes improvement types in table', function() {
    expect(body).toContain('meta');
    expect(body).toContain('heading');
  });

  it('includes file paths in table', function() {
    expect(body).toContain('src/pages/index.astro');
    expect(body).toContain('src/pages/features.astro');
  });

  it('includes confidence percentages', function() {
    expect(body).toContain('88%');
    expect(body).toContain('82%');
  });

  it('includes source findings', function() {
    expect(body).toContain('low_ctr_page');
    expect(body).toContain('heading_change');
  });

  it('includes current and proposed values in detail section', function() {
    expect(body).toContain('Trading for everyone.');
    expect(body).toContain('Institutional-grade trading signals for professional traders.');
  });

  it('includes rationale for each improvement', function() {
    expect(body).toContain('Low CTR page missing primary keyword');
  });

  it('has a Cultivai attribution footer', function() {
    expect(body.toLowerCase()).toContain('cultivai');
  });

  it('handles singular count correctly', function() {
    var singleBody = buildPrBody([IMPROVEMENTS[0]], SITE_CONFIG, '2025-06-01');
    expect(singleBody).toContain('1 change');
    expect(singleBody).not.toContain('1 changes');
  });
});

// applyImprovement

describe('applyImprovement', function() {
  it('replaces current text with proposed text', function() {
    var content = '<h1>Trading for everyone.</h1>';
    var imp     = { type: 'heading', file: 'x.astro', selector: 'h1', current: 'Trading for everyone.', proposed: 'Pro Trading Signals.', confidence: 0.88, source_findings: [] };
    var result  = applyImprovement(content, imp);
    expect(result).toContain('Pro Trading Signals.');
    expect(result).not.toContain('Trading for everyone.');
  });

  it('replaces only the first occurrence', function() {
    var content = 'foo foo foo';
    var imp     = { current: 'foo', proposed: 'bar', selector: 'p' };
    var result  = applyImprovement(content, imp);
    expect(result).toBe('bar foo foo');
  });

  it('returns original content unchanged when current text is not found', function() {
    var content = '<h1>Something else entirely</h1>';
    var imp     = { current: 'Trading for everyone.', proposed: 'New copy', selector: 'h1' };
    var result  = applyImprovement(content, imp);
    expect(result).toBe(content);
    expect(result).not.toContain('[Cultivai]');
  });

  it('returns original content unchanged when both current and proposed are missing', function() {
    var content = '<p>unchanged</p>';
    var imp     = { selector: 'p' };
    var result  = applyImprovement(content, imp);
    expect(result).toBe(content);
  });

  it('handles multiline file content correctly', function() {
    var content = [
      '---',
      'title: Home',
      '---',
      '<meta name="description" content="Trading for everyone." />',
      '<h1>Welcome</h1>',
    ].join('\n');
    var imp = { current: 'Trading for everyone.', proposed: 'Pro-grade trading signals.', selector: 'meta' };
    var result = applyImprovement(content, imp);
    expect(result).toContain('Pro-grade trading signals.');
    expect(result).toContain('<h1>Welcome</h1>');
  });

  it('handles empty file content without throwing', function() {
    expect(function() { applyImprovement('', IMPROVEMENTS[0]); }).not.toThrow();
  });
});
