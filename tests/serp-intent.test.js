'use strict';

const { classifyIntent, flattenKeywords } = require('../agents/serp-intent');

// ── classifyIntent ────────────────────────────────────────────────────────────

describe('classifyIntent', function() {
  it('classifies navigational intent', function() {
    expect(classifyIntent('tradolux login')).toBe('navigational');
    expect(classifyIntent('account dashboard')).toBe('navigational');
    expect(classifyIntent('official site trading')).toBe('navigational');
  });

  it('classifies transactional intent', function() {
    expect(classifyIntent('buy trading signals')).toBe('transactional');
    expect(classifyIntent('trading platform pricing')).toBe('transactional');
    expect(classifyIntent('free trial stock alerts')).toBe('transactional');
    expect(classifyIntent('get started trading')).toBe('transactional');
  });

  it('classifies commercial investigation intent', function() {
    expect(classifyIntent('best trading platform')).toBe('commercial_investigation');
    expect(classifyIntent('tradolux vs competitor')).toBe('commercial_investigation');
    expect(classifyIntent('trading platform review')).toBe('commercial_investigation');
    expect(classifyIntent('top stock signal apps')).toBe('commercial_investigation');
  });

  it('classifies informational intent as default', function() {
    expect(classifyIntent('what is algorithmic trading')).toBe('informational');
    expect(classifyIntent('how trading signals work')).toBe('informational');
    expect(classifyIntent('AI stock analysis')).toBe('informational');
  });

  it('navigational takes priority over transactional', function() {
    // "sign up" is navigational; "free trial" is transactional
    // navigational is checked first so it should win
    expect(classifyIntent('sign up for free trial')).toBe('navigational');
  });

  it('transactional takes priority over commercial investigation', function() {
    expect(classifyIntent('buy best trading platform')).toBe('transactional');
  });

  it('is case insensitive', function() {
    expect(classifyIntent('BUY Trading Signals')).toBe('transactional');
    expect(classifyIntent('BEST Platform')).toBe('commercial_investigation');
  });

  it('handles empty string', function() {
    expect(classifyIntent('')).toBe('informational');
  });
});

// ── flattenKeywords ───────────────────────────────────────────────────────────

describe('flattenKeywords', function() {
  it('returns arrays as-is', function() {
    const kws = ['trading signals', 'stock alerts', 'portfolio tracker'];
    expect(flattenKeywords(kws)).toEqual(kws);
  });

  it('flattens object-keyed keywords (underlytix format)', function() {
    const kws = {
      realtors:  ['real estate market analysis', 'property investment tools'],
      investors: ['investment portfolio AI', 'market trend analysis'],
    };
    const result = flattenKeywords(kws);
    expect(result).toContain('real estate market analysis');
    expect(result).toContain('investment portfolio AI');
    expect(result).toHaveLength(4);
  });

  it('returns empty array for null', function() {
    expect(flattenKeywords(null)).toEqual([]);
  });

  it('returns empty array for undefined', function() {
    expect(flattenKeywords(undefined)).toEqual([]);
  });

  it('returns empty array for non-object, non-array input', function() {
    expect(flattenKeywords('string')).toEqual([]);
    expect(flattenKeywords(42)).toEqual([]);
  });

  it('handles empty array', function() {
    expect(flattenKeywords([])).toEqual([]);
  });

  it('handles empty object', function() {
    expect(flattenKeywords({})).toEqual([]);
  });

  it('handles nested arrays in object values', function() {
    const kws = {
      type1: ['keyword a', 'keyword b'],
      type2: ['keyword c'],
    };
    const result = flattenKeywords(kws);
    expect(result).toHaveLength(3);
  });
});
