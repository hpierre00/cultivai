'use strict';

// agents/serp-intent.js - SERP Intent Classifier
//
// For each primary keyword in a site config:
//   1. Fetches SerpAPI results (cached 48h per keyword)
//   2. Classifies search intent: navigational > transactional > commercial_investigation > informational
//   3. Returns intent-tagged keyword data for the improvement generator
//
// Output: reports/{site}-serp-intent-{date}.json

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR   = path.join(__dirname, '..', 'reports');
const CACHE_TTL_MS  = 48 * 60 * 60 * 1000; // 48 hours
const SERPAPI_BASE  = 'https://serpapi.com/search.json';

// ── Intent classification ─────────────────────────────────────────────────────

const PATTERNS = {
  navigational: [
    /\b(login|sign in|sign up|account|dashboard|portal)\b/i,
    /\b(official site|official page|homepage|website)\b/i,
  ],
  transactional: [
    /\b(buy|purchase|order|checkout|get started|free trial|pricing|price|cost|subscribe|download|install)\b/i,
    /\b(deal|discount|coupon|promo|offer|shop)\b/i,
  ],
  commercial_investigation: [
    /\b(best|top|vs|versus|compare|comparison|review|reviews|alternative|alternatives|pros and cons|ranking)\b/i,
    /\b(should i|worth it|is it good|recommendation)\b/i,
  ],
};

/**
 * Classify a keyword's search intent.
 * @param {string} keyword
 * @returns {'navigational'|'transactional'|'commercial_investigation'|'informational'}
 */
function classifyIntent(keyword) {
  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(keyword)) return intent;
    }
  }
  return 'informational';
}

// ── Keyword flattening ────────────────────────────────────────────────────────

/**
 * Flatten primary_keywords — handles both array (tradolux/lawverra)
 * and object-keyed-by-client-type (underlytix) formats.
 * @param {Array|Object} primary_keywords
 * @returns {Array<string>}
 */
function flattenKeywords(primary_keywords) {
  if (Array.isArray(primary_keywords)) return primary_keywords;

  if (typeof primary_keywords === 'object' && primary_keywords !== null) {
    return Object.values(primary_keywords).flat();
  }

  return [];
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function safeName(keyword) {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
}

function cachePathForKeyword(siteName, keyword) {
  return path.join(REPORTS_DIR, `${siteName}-serp-cache-${safeName(keyword)}.json`);
}

function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (Date.now() - data._cachedAt < CACHE_TTL_MS) return data;
  } catch {}
  return null;
}

function writeCache(cachePath, data) {
  fs.writeFileSync(cachePath, JSON.stringify({ ...data, _cachedAt: Date.now() }));
}

// ── SerpAPI fetch ─────────────────────────────────────────────────────────────

async function fetchSerp(keyword) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('Missing SERPAPI_KEY env var');

  const params = new URLSearchParams({
    engine:  'google',
    q:       keyword,
    num:     '10',
    gl:      'us',
    hl:      'en',
    api_key: apiKey,
  });

  const resp = await fetch(`${SERPAPI_BASE}?${params.toString()}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpAPI ${resp.status} for "${keyword}": ${text}`);
  }

  return resp.json();
}

// ── Summarize SERP results ────────────────────────────────────────────────────

function summarizeSerp(serpData, keyword) {
  const organic      = serpData.organic_results || [];
  const knowledgeBox = !!serpData.knowledge_graph;
  const featSnippet  = !!serpData.answer_box;
  const adCount      = (serpData.ads || []).length;

  // Check if any of our sites appear in top 10
  const topDomains = organic.slice(0, 10).map((r) => {
    try { return new URL(r.link).hostname.replace(/^www\./, ''); } catch { return ''; }
  });

  return {
    keyword,
    intent:       classifyIntent(keyword),
    topDomains,
    knowledgeBox,
    featuredSnippet: featSnippet,
    paidAdCount:  adCount,
    resultCount:  organic.length,
  };
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  const keywords = flattenKeywords(siteConfig.primary_keywords);

  if (!keywords.length) {
    console.log(`[serp-intent] No primary_keywords for ${siteConfig.name}, skipping.`);
    return { skipped: true };
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const results = [];

  for (const keyword of keywords) {
    const cachePath = cachePathForKeyword(siteConfig.name, keyword);
    let summary     = readCache(cachePath);

    if (!summary) {
      try {
        const serpData = await fetchSerp(keyword);
        summary        = summarizeSerp(serpData, keyword);
        writeCache(cachePath, summary);
      } catch (err) {
        console.warn(`[serp-intent] ${keyword}: ${err.message}`);
        // Still include with intent classification even if fetch fails
        summary = { keyword, intent: classifyIntent(keyword), error: err.message };
      }
    }

    results.push(summary);
  }

  const today   = new Date().toISOString().slice(0, 10);
  const report  = {
    site:     siteConfig.name,
    date:     today,
    keywords: results,
    summary: {
      total:                    results.length,
      navigational:             results.filter((r) => r.intent === 'navigational').length,
      transactional:            results.filter((r) => r.intent === 'transactional').length,
      commercial_investigation: results.filter((r) => r.intent === 'commercial_investigation').length,
      informational:            results.filter((r) => r.intent === 'informational').length,
    },
  };

  const outFile = path.join(REPORTS_DIR, `${siteConfig.name}-serp-intent-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`[serp-intent] ${siteConfig.name}: ${results.length} keywords classified → ${outFile}`);

  return report;
}

module.exports = { run, classifyIntent, flattenKeywords };
