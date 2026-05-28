'use strict';

const { parseImprovements, buildPrompt, collectFindings } = require('../agents/improvement-generator');
const fs   = require('fs');
const path = require('path');

// ── parseImprovements ─────────────────────────────────────────────────────────

const VALID_IMPROVEMENT = {
  type:            'meta',
  file:            'src/pages/index.astro',
  selector:        'meta[name="description"]',
  current:         'Trading platform for everyone.',
  proposed:        'Institutional-grade trading signals and real-time alerts for professional traders.',
  rationale:       'Meta description missing primary keyword with high impression share.',
  confidence:      0.85,
  source_findings: ['low_ctr_page'],
};

describe('parseImprovements', function() {
  it('parses valid JSON array', function() {
    const json = JSON.stringify([VALID_IMPROVEMENT]);
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('meta');
  });

  it('strips markdown code fences before parsing', function() {
    const json = '```json\n' + JSON.stringify([VALID_IMPROVEMENT]) + '\n```';
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
  });

  it('strips plain code fences before parsing', function() {
    const json = '```\n' + JSON.stringify([VALID_IMPROVEMENT]) + '\n```';
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
  });

  it('filters out items below minConfidence', function() {
    const lowConf = { ...VALID_IMPROVEMENT, confidence: 0.5 };
    const json = JSON.stringify([VALID_IMPROVEMENT, lowConf]);
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.85);
  });

  it('respects maxPerRun limit', function() {
    const items = [VALID_IMPROVEMENT, VALID_IMPROVEMENT, VALID_IMPROVEMENT];
    const json = JSON.stringify(items);
    const result = parseImprovements(json, 0.7, 2);
    expect(result).toHaveLength(2);
  });

  it('filters out items with invalid type', function() {
    const bad = { ...VALID_IMPROVEMENT, type: 'invalid_type' };
    const json = JSON.stringify([VALID_IMPROVEMENT, bad]);
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
  });

  it('filters out items missing required fields', function() {
    const missing = { type: 'meta', confidence: 0.9 }; // missing file, selector, etc.
    const json = JSON.stringify([VALID_IMPROVEMENT, missing]);
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
  });

  it('filters out items with empty source_findings', function() {
    const noSource = { ...VALID_IMPROVEMENT, source_findings: [] };
    const json = JSON.stringify([VALID_IMPROVEMENT, noSource]);
    const result = parseImprovements(json, 0.7, 5);
    expect(result).toHaveLength(1);
  });

  it('accepts all valid types', function() {
    const types = ['meta', 'copy', 'heading', 'internal_link', 'cta', 'schema'];
    const items = types.map((t) => ({ ...VALID_IMPROVEMENT, type: t }));
    const json  = JSON.stringify(items);
    const result = parseImprovements(json, 0.7, 10);
    expect(result).toHaveLength(6);
    expect(result.map((r) => r.type).sort()).toEqual(types.sort());
  });

  it('throws on invalid JSON', function() {
    expect(function() { parseImprovements('not json', 0.7, 5); }).toThrow();
  });

  it('throws when Claude returns an object instead of array', function() {
    expect(function() { parseImprovements('{"type":"meta"}', 0.7, 5); }).toThrow();
  });

  it('returns empty array when all items fail validation', function() {
    const bad = [{ type: 'bad', confidence: 0.9 }];
    const result = parseImprovements(JSON.stringify(bad), 0.7, 5);
    expect(result).toEqual([]);
  });

  it('accepts confidence exactly at minConfidence', function() {
    const exact = { ...VALID_IMPROVEMENT, confidence: 0.7 };
    const result = parseImprovements(JSON.stringify([exact]), 0.7, 5);
    expect(result).toHaveLength(1);
  });
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

const SITE_CONFIG = {
  name:        'tradolux',
  displayName: 'Tradolux',
  url:         'https://tradolux.com',
  brand_voice: 'Professional, precise, institutional tone.',
  improvement_limits: { max_per_run: 3, min_confidence: 0.75 },
};

const MOCK_FINDINGS = [
  { type: 'low_ctr_page', page: 'https://tradolux.com/features', ctr: 0.8, impressions: 1200 },
  { type: 'price_change', added: ['$49/mo'], removed: ['$29/mo'] },
];

describe('buildPrompt', function() {
  var prompt;
  beforeAll(function() { prompt = buildPrompt(SITE_CONFIG, MOCK_FINDINGS); });

  it('returns systemPrompt and userMessage', function() {
    expect(prompt).toHaveProperty('systemPrompt');
    expect(prompt).toHaveProperty('userMessage');
  });

  it('includes brand voice in system prompt', function() {
    expect(prompt.systemPrompt).toContain('Professional, precise, institutional tone.');
  });

  it('includes max_per_run in system prompt', function() {
    expect(prompt.systemPrompt).toContain('3');
  });

  it('includes min_confidence in system prompt', function() {
    expect(prompt.systemPrompt).toContain('0.75');
  });

  it('includes findings in user message as JSON', function() {
    expect(prompt.userMessage).toContain('low_ctr_page');
    expect(prompt.userMessage).toContain('price_change');
  });

  it('includes site URL in user message', function() {
    expect(prompt.userMessage).toContain('https://tradolux.com');
  });

  it('system prompt requires JSON-only response', function() {
    expect(prompt.systemPrompt.toLowerCase()).toContain('only valid json');
  });
});

// ── collectFindings ───────────────────────────────────────────────────────────

describe('collectFindings', function() {
  var tmpDir;

  beforeAll(function() {
    // Point REPORTS_DIR to a tmp location by writing fixture files
    tmpDir = path.join(require('os').tmpdir(), 'cultivai-test-findings-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write a fake gsc-gaps report
    const today = new Date().toISOString().slice(0, 10);
    const gscReport = {
      findings: [
        { type: 'low_ctr_page', page: 'https://tradolux.com/features' },
        { type: 'page_2_opportunity', page: 'https://tradolux.com/signals' },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, `tradolux-gsc-gaps-${today}.json`),
      JSON.stringify(gscReport)
    );
  });

  afterAll(function() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an array', function() {
    // collectFindings uses the module-level REPORTS_DIR, so we just check it returns an array
    // (it will return [] since our tmp dir is not the real REPORTS_DIR)
    const result = collectFindings('tradolux');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array for a site with no reports', function() {
    const result = collectFindings('nonexistent-site-xyz');
    expect(result).toEqual([]);
  });

  it('does not throw when reports directory is empty', function() {
    expect(function() { collectFindings('tradolux'); }).not.toThrow();
  });
});
