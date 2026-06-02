'use strict';

const { vetImprovement, hasCompetitorBrand } = require('../agents/batch-vettor');

// hasCompetitorBrand

describe('hasCompetitorBrand', function () {
  it('detects TradingView', function () {
    expect(hasCompetitorBrand('Try TradingView today')).toBe(true);
  });

  it('detects Clio', function () {
    expect(hasCompetitorBrand('Better than Clio for lawyers')).toBe(true);
  });

  it('detects Ironclad', function () {
    expect(hasCompetitorBrand('Unlike Ironclad, we offer X')).toBe(true);
  });

  it('detects Benzinga', function () {
    expect(hasCompetitorBrand('Powered by Benzinga data')).toBe(true);
  });

  it('returns false for clean copy', function () {
    expect(hasCompetitorBrand('Professional legal document automation')).toBe(false);
  });

  it('is case-insensitive', function () {
    expect(hasCompetitorBrand('tradingview signals')).toBe(true);
  });
});

// vetImprovement

const VALID_IMP = {
  type:            'meta',
  file:            'src/pages/index.astro',
  selector:        'meta[name="description"]',
  current:         'Trading for everyone.',
  proposed:        'Institutional-grade trading signals for professional traders.',
  confidence:      0.88,
  source_findings: ['low_ctr_page'],
};

describe('vetImprovement - passing case', function () {
  it('passes a valid improvement', function () {
    const result = vetImprovement(VALID_IMP, {}, 0.7);
    expect(result.pass).toBe(true);
  });
});

describe('vetImprovement - required fields', function () {
  it('rejects when type is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { type: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when file is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { file: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when selector is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { selector: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when current is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { current: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when proposed is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { proposed: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when confidence is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { confidence: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });

  it('rejects when source_findings is missing', function () {
    const imp = Object.assign({}, VALID_IMP, { source_findings: undefined });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(false);
  });
});

describe('vetImprovement - confidence threshold', function () {
  it('rejects when confidence is below threshold', function () {
    const imp = Object.assign({}, VALID_IMP, { confidence: 0.5 });
    const result = vetImprovement(imp, {}, 0.7);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/confidence/);
  });

  it('passes when confidence equals threshold exactly', function () {
    const imp = Object.assign({}, VALID_IMP, { confidence: 0.7 });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(true);
  });

  it('passes when confidence exceeds threshold', function () {
    const imp = Object.assign({}, VALID_IMP, { confidence: 0.95 });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(true);
  });
});

describe('vetImprovement - no-op change', function () {
  it('rejects when current equals proposed', function () {
    const imp = Object.assign({}, VALID_IMP, { current: 'same text', proposed: 'same text' });
    const result = vetImprovement(imp, {}, 0.7);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/identical/);
  });
});

describe('vetImprovement - competitor brand names', function () {
  it('rejects when proposed contains a competitor name', function () {
    const imp = Object.assign({}, VALID_IMP, { proposed: 'Better than Clio for legal teams.' });
    const result = vetImprovement(imp, {}, 0.7);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/competitor/);
  });

  it('passes when only current contains a competitor name and proposed is clean', function () {
    const imp = Object.assign({}, VALID_IMP, { current: 'Clio alternative', proposed: 'The smarter legal platform.' });
    expect(vetImprovement(imp, {}, 0.7).pass).toBe(true);
  });
});

describe('vetImprovement - content mismatch', function () {
  it('rejects when current text is not found in the actual file', function () {
    const fileContentMap = { 'src/pages/index.astro': '<h1>Welcome to Tradolux</h1>' };
    const result = vetImprovement(VALID_IMP, fileContentMap, 0.7);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/content mismatch/);
  });

  it('passes when current text IS found in the actual file', function () {
    const fileContentMap = { 'src/pages/index.astro': 'Trading for everyone. The best platform.' };
    expect(vetImprovement(VALID_IMP, fileContentMap, 0.7).pass).toBe(true);
  });

  it('passes when file content is null meaning file not found so mismatch check skipped', function () {
    const fileContentMap = { 'src/pages/index.astro': null };
    expect(vetImprovement(VALID_IMP, fileContentMap, 0.7).pass).toBe(true);
  });

  it('passes when file is not in contentMap at all', function () {
    expect(vetImprovement(VALID_IMP, {}, 0.7).pass).toBe(true);
  });
});

describe('vetImprovement - empty proposed', function () {
  it('rejects when proposed is an empty string', function () {
    const imp = Object.assign({}, VALID_IMP, { proposed: '' });
    const result = vetImprovement(imp, {}, 0.7);
    expect(result.pass).toBe(false);
  });

  it('rejects when proposed is only spaces', function () {
    const spaces = '   ';
    const imp = Object.assign({}, VALID_IMP, { proposed: spaces });
    const result = vetImprovement(imp, {}, 0.7);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });
});
