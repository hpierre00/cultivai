'use strict';

// agents/improvement-generator.js - AI Improvement Generator
//
// Reads findings from all agent reports for a site, sends them to the
// Claude API, and returns structured improvement recommendations.
//
// Output: reports/{site}-improvements-{date}.json
//
// Each improvement has:
//   - type: 'meta' | 'copy' | 'heading' | 'internal_link' | 'cta' | 'schema'
//   - file: relative path in the repo (e.g. 'src/pages/index.astro')
//   - selector: CSS/XPath hint to locate the element
//   - current: the current text/value
//   - proposed: the proposed replacement
//   - rationale: why this change is recommended
//   - confidence: 0-1 float
//   - source_findings: array of finding type strings that drove this

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

const MODEL           = 'claude-sonnet-4-20250514';
const MAX_TOKENS      = 4096;
const MAX_PER_RUN     = 5;  // global default; overridden by siteConfig.improvement_limits.max_per_run
const MIN_CONFIDENCE  = 0.7; // global default; overridden by siteConfig.improvement_limits.min_confidence

// ── Collect findings from all report files for a site ───────────────────────

function collectFindings(siteName) {
  const today   = new Date().toISOString().slice(0, 10);
  const sources = ['gsc-gaps', 'competitor-diff', 'google-ads', 'meta-ads', 'bing-ads', 'serp-intent'];
  const findings = [];

  for (const source of sources) {
    const filePath = path.join(REPORTS_DIR, `${siteName}-${source}-${today}.json`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let items;
      if (Array.isArray(data.findings)) {
        // Flat findings array (legacy / test format)
        items = data.findings;
      } else if (Array.isArray(data.gaps)) {
        // Flat gaps array
        items = data.gaps;
      } else if (data.gaps && typeof data.gaps === 'object') {
        // gsc-gaps format: { low_ctr_pages: [...], page_2_opportunities: [...], missing_landing_pages: [...] }
        items = Object.values(data.gaps).flat();
      } else if (Array.isArray(data.changes)) {
        // Flat changes array
        items = data.changes;
      } else if (Array.isArray(data.results)) {
        // competitor-diff format: results[].changes
        items = data.results.flatMap((r) => r.changes || []);
      } else if (Array.isArray(data.keywords)) {
        // serp-intent format: keywords[]
        items = data.keywords;
      } else {
        items = [];
      }
      findings.push(...items.map((item) => ({ source, ...item })));
    } catch (err) {
      console.warn(`[improvement-generator] Could not read ${filePath}: ${err.message}`);
    }
  }

  return findings;
}

// ── Build the prompt ──────────────────────────────────────────────────────────

function buildPrompt(siteConfig, findings) {
  const maxPerRun     = (siteConfig.improvement_limits && siteConfig.improvement_limits.max_per_run)    || MAX_PER_RUN;
  const minConfidence = (siteConfig.improvement_limits && siteConfig.improvement_limits.min_confidence) || MIN_CONFIDENCE;

  // Build repo file context so Claude targets real files with real current values
  let repoContext = '';
  if (siteConfig.repo_pages && siteConfig.repo_pages.length > 0) {
    repoContext += `\nREPO FILES — the "file" field in every improvement MUST be one of these exact paths:\n${siteConfig.repo_pages.map((p) => `  ${p}`).join('\n')}\n`;
  }
  if (siteConfig.site_key_elements) {
    repoContext += `\nCURRENT PAGE ELEMENTS — use these exact strings as the "current" field value:\n${JSON.stringify(siteConfig.site_key_elements, null, 2)}\n`;
  }

  const systemPrompt = `You are an expert SEO and conversion rate optimization agent for ${siteConfig.displayName || siteConfig.name}.

Brand voice: ${siteConfig.brand_voice}

Your task: analyze the provided data findings and generate concrete website improvement recommendations.
${repoContext}
Rules:
- Return ONLY valid JSON — no prose, no markdown, no code fences
- Return an array of improvement objects, maximum ${maxPerRun} items
- Only include improvements with confidence >= ${minConfidence}
- Each improvement must target a specific, editable element on the site
- Improvements must respect the brand voice exactly
- The "file" field MUST be one of the exact repo paths listed above — never invent paths
- The "current" field MUST be the exact string from the current page elements above

Each improvement object must have exactly these fields:
{
  "type": "<meta|copy|heading|internal_link|cta|schema>",
  "file": "<relative repo path, e.g. src/pages/about.astro>",
  "selector": "<CSS selector or descriptive locator>",
  "current": "<current text or attribute value>",
  "proposed": "<proposed replacement>",
  "rationale": "<one sentence explaining the data-driven reason>",
  "confidence": <number between 0 and 1>,
  "source_findings": ["<finding type string>", ...]
}`;

  const userMessage = `Here are the current data findings for ${siteConfig.name} (${siteConfig.url}):

${JSON.stringify(findings, null, 2)}

Generate up to ${maxPerRun} high-confidence (>= ${minConfidence}) improvement recommendations as a JSON array.`;

  return { systemPrompt, userMessage };
}

// ── Parse and validate Claude's response ─────────────────────────────────────

function parseImprovements(responseText, minConfidence, maxPerRun) {
  let parsed;

  // Strip any accidental markdown fences
  const cleaned = responseText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${err.message}\nResponse: ${cleaned.slice(0, 300)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Claude returned non-array JSON: ${typeof parsed}`);
  }

  const VALID_TYPES = new Set(['meta', 'copy', 'heading', 'internal_link', 'cta', 'schema']);
  const REQUIRED    = ['type', 'file', 'selector', 'current', 'proposed', 'rationale', 'confidence', 'source_findings'];

  const validated = parsed
    .filter((item) => {
      if (typeof item !== 'object' || item === null) return false;

      // Must have all required fields
      for (const field of REQUIRED) {
        if (!(field in item)) return false;
      }

      // Type must be valid
      if (!VALID_TYPES.has(item.type)) return false;

      // Confidence must be a number >= minConfidence
      const conf = Number(item.confidence);
      if (!Number.isFinite(conf) || conf < minConfidence) return false;

      // source_findings must be a non-empty array
      if (!Array.isArray(item.source_findings) || item.source_findings.length === 0) return false;

      return true;
    })
    .slice(0, maxPerRun);

  return validated;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`[improvement-generator] Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY env var');

  const findings = collectFindings(siteConfig.name);

  if (findings.length === 0) {
    console.log(`[improvement-generator] No findings for ${siteConfig.name} today, skipping.`);
    return { skipped: true, reason: 'no_findings' };
  }

  const maxPerRun     = (siteConfig.improvement_limits && siteConfig.improvement_limits.max_per_run)    || MAX_PER_RUN;
  const minConfidence = (siteConfig.improvement_limits && siteConfig.improvement_limits.min_confidence) || MIN_CONFIDENCE;

  const { systemPrompt, userMessage } = buildPrompt(siteConfig, findings);

  const improvements = await withRetry(async () => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
       