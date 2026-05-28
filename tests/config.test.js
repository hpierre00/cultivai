const path = require('path');
const fs = require('fs');

const SITES = ['tradolux', 'lawverra', 'underlytix'];
const SITES_DIR = path.join(__dirname, '..', 'sites');

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadSite(name) {
  const filePath = path.join(SITES_DIR, `${name}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

// ── Shared schema tests ───────────────────────────────────────────────────────

describe('Site config files exist and are valid JSON', () => {
  SITES.forEach((site) => {
    it(`${site}.json exists and parses`, () => {
      const filePath = path.join(SITES_DIR, `${site}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(() => loadSite(site)).not.toThrow();
    });
  });
});

describe('Required top-level fields', () => {
  const REQUIRED_FIELDS = [
    'name',
    'displayName',
    'url',
    'github_repo',
    'github_branch',
    'gsc_property',
    'brand_voice',
    'competitors',
    'ad_accounts',
    'improvement_limits',
  ];

  SITES.forEach((site) => {
    describe(site, () => {
      let config;
      beforeAll(() => { config = loadSite(site); });

      REQUIRED_FIELDS.forEach((field) => {
        it(`has field: ${field}`, () => {
          expect(config).toHaveProperty(field);
        });
      });
    });
  });
});

describe('Field types and constraints', () => {
  SITES.forEach((site) => {
    describe(site, () => {
      let config;
      beforeAll(() => { config = loadSite(site); });

      it('name is a non-empty lowercase string', () => {
        expect(isNonEmptyString(config.name)).toBe(true);
        expect(config.name).toBe(config.name.toLowerCase());
      });

      it('url starts with https://', () => {
        expect(config.url).toMatch(/^https:\/\//);
      });

      it('github_repo is owner/repo format', () => {
        expect(config.github_repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      });

      it('github_branch is a non-empty string', () => {
        expect(isNonEmptyString(config.github_branch)).toBe(true);
      });

      it('gsc_property starts with sc-domain:', () => {
        expect(config.gsc_property).toMatch(/^sc-domain:/);
      });

      it('brand_voice is a non-empty string', () => {
        expect(isNonEmptyString(config.brand_voice)).toBe(true);
      });

      it('competitors is a non-empty array', () => {
        expect(Array.isArray(config.competitors)).toBe(true);
        expect(config.competitors.length).toBeGreaterThan(0);
      });

      it('each competitor is a domain string (no protocol)', () => {
        config.competitors.forEach((c) => {
          expect(c).not.toMatch(/^https?:\/\//);
          expect(isNonEmptyString(c)).toBe(true);
        });
      });

      it('ad_accounts has google_ads_customer_id, meta_ad_account_id, bing_account_id keys', () => {
        expect(config.ad_accounts).toHaveProperty('google_ads_customer_id');
        expect(config.ad_accounts).toHaveProperty('meta_ad_account_id');
        expect(config.ad_accounts).toHaveProperty('bing_account_id');
      });

      it('improvement_limits.max_per_run is a positive integer', () => {
        const { max_per_run } = config.improvement_limits;
        expect(Number.isInteger(max_per_run)).toBe(true);
        expect(max_per_run).toBeGreaterThan(0);
      });

      it('improvement_limits.min_confidence is between 0 and 1', () => {
        const { min_confidence } = config.improvement_limits;
        expect(typeof min_confidence).toBe('number');
        expect(min_confidence).toBeGreaterThan(0);
        expect(min_confidence).toBeLessThanOrEqual(1);
      });
    });
  });
});

describe('primary_keywords field', () => {
  it('tradolux primary_keywords is a non-empty array', () => {
    const config = loadSite('tradolux');
    expect(Array.isArray(config.primary_keywords)).toBe(true);
    expect(config.primary_keywords.length).toBeGreaterThan(0);
    config.primary_keywords.forEach((kw) => expect(isNonEmptyString(kw)).toBe(true));
  });

  it('lawverra primary_keywords is a non-empty array', () => {
    const config = loadSite('lawverra');
    expect(Array.isArray(config.primary_keywords)).toBe(true);
    expect(config.primary_keywords.length).toBeGreaterThan(0);
  });

  it('underlytix primary_keywords is an object keyed by client_types', () => {
    const config = loadSite('underlytix');
    expect(typeof config.primary_keywords).toBe('object');
    expect(Array.isArray(config.primary_keywords)).toBe(false);
    expect(config).toHaveProperty('client_types');
    config.client_types.forEach((type) => {
      expect(config.primary_keywords).toHaveProperty(type);
      expect(Array.isArray(config.primary_keywords[type])).toBe(true);
      expect(config.primary_keywords[type].length).toBeGreaterThan(0);
    });
  });
});

describe('Site name matches filename', () => {
  SITES.forEach((site) => {
    it(`${site}.json — config.name === "${site}"`, () => {
      const config = loadSite(site);
      expect(config.name).toBe(site);
    });
  });
});
