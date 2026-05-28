'use strict';

// agents/bing-ads.js - Microsoft Advertising (Bing Ads) Performance Agent
//
// Fetches from Microsoft Advertising Reporting API v13 using OAuth2.
// Identifies:
//   1. Keywords with Quality Score below 5
//   2. Campaigns with impression share loss to budget above 20%
//   3. Campaigns with low average position (> 4.0) indicating competitive pressure
//
// Output: reports/{site}-bing-ads-{date}.json
//
// Microsoft Advertising uses a report-request/poll model:
//   - Submit report request -> get RequestId
//   - Poll until Status=Success
//   - Download zip -> parse CSV

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const TOKEN_URL   = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const API_BASE    = 'https://reporting.api.bingads.microsoft.com/Reporting/v13';
const POLL_MAX    = 12;  // max poll attempts
const POLL_MS     = 5000; // 5 seconds between polls

// ── OAuth2 token exchange ─────────────────────────────────────────────────────

async function fetchAccessToken() {
  const {
    BING_CLIENT_ID,
    BING_CLIENT_SECRET,
    BING_REFRESH_TOKEN,
  } = process.env;

  if (!BING_CLIENT_ID || !BING_REFRESH_TOKEN) {
    throw new Error('Missing Bing Ads OAuth2 env vars (BING_CLIENT_ID, BING_REFRESH_TOKEN)');
  }

  const body = new URLSearchParams({
    client_id:     BING_CLIENT_ID,
    grant_type:    'refresh_token',
    refresh_token: BING_REFRESH_TOKEN,
    scope:         'https://ads.microsoft.com/msads.manage offline_access',
  });
  if (BING_CLIENT_SECRET) body.set('client_secret', BING_CLIENT_SECRET);

  const resp = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bing token exchange failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ── Reporting API helper ──────────────────────────────────────────────────────

function bingHeaders(accessToken) {
  const devToken  = process.env.BING_DEVELOPER_TOKEN;
  const accountId = process.env.BING_ACCOUNT_ID; // numeric account id, not customer id

  if (!devToken)  throw new Error('Missing BING_DEVELOPER_TOKEN');
  if (!accountId) throw new Error('Missing BING_ACCOUNT_ID');

  return {
    'Authorization':        `Bearer ${accessToken}`,
    'DeveloperToken':       devToken,
    'CustomerId':           accountId,
    'CustomerAccountId':    accountId,
    'Content-Type':         'application/json',
    'Accept':               'application/json',
  };
}

async function submitReportRequest(payload, accessToken) {
  const resp = await fetch(`${API_BASE}/SubmitGenerateReport`, {
    method:  'POST',
    headers: bingHeaders(accessToken),
    body:    JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bing SubmitGenerateReport failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.ReportRequestId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollReportStatus(requestId, accessToken) {
  for (let attempt = 0; attempt < POLL_MAX; attempt++) {
    await sleep(POLL_MS);

    const resp = await fetch(`${API_BASE}/PollGenerateReport`, {
      method:  'POST',
      headers: bingHeaders(accessToken),
      body:    JSON.stringify({ ReportRequestId: requestId }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Bing PollGenerateReport failed ${resp.status}: ${text}`);
    }

    const data   = await resp.json();
    const status = data.ReportRequestStatus && data.ReportRequestStatus.Status;

    if (status === 'Success') {
      return data.ReportRequestStatus.ReportDownloadUrl;
    }
    if (status === 'Error') {
      throw new Error(`Bing report request failed: ${JSON.stringify(data)}`);
    }
    // Pending or Running — keep polling
  }
  throw new Error(`Bing report polling timed out after ${POLL_MAX} attempts`);
}

async function downloadAndParseCsv(downloadUrl) {
  const resp = await fetch(downloadUrl);
  if (!resp.ok) throw new Error(`Bing report download failed ${resp.status}`);

  const buffer    = Buffer.from(await resp.arrayBuffer());
  // Bing returns a zip file
  const decompressed = zlib.unzipSync(buffer).toString('utf-8');

  // Parse CSV (skip BOM and header/footer lines)
  const lines  = decompressed.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Find the header row (first non-report-metadata line)
  let headerIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('"') || !lines[i].startsWith('Report')) {
      headerIdx = i;
      break;
    }
  }

  const headers = parseCsvLine(lines[headerIdx]);
  const rows    = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    if (vals.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Gap detectors (exported for testing) ─────────────────────────────────────

/**
 * Identify keywords with Quality Score below 5.
 * @param {Array} rows - parsed CSV rows from keyword performance report
 * @returns {Array}
 */
function detectLowQualityScoreKeywords(rows) {
  return rows
    .filter((row) => {
      const qs = parseInt(row['Quality Score'] || row['QualityScore'] || '0', 10);
      return Number.isFinite(qs) && qs > 0 && qs < 5;
    })
    .map((row) => ({
      type:             'low_quality_score',
      keyword:          row['Keyword'] || row['keyword'] || 'unknown',
      matchType:        row['Match Type'] || row['MatchType'] || 'UNKNOWN',
      qualityScore:     parseInt(row['Quality Score'] || row['QualityScore'] || '0', 10),
      campaignId:       row['Campaign Id'] || row['CampaignId'] || null,
      campaignName:     row['Campaign'] || row['CampaignName'] || null,
      adGroupName:      row['Ad Group'] || row['AdGroupName'] || null,
      impressions:      parseInt(row['Impressions'] || '0', 10),
      recommendation:   `QS ${row['Quality Score'] || row['QualityScore']}/10 — review landing page relevance for "${row['Keyword'] || 'keyword'}"`,
    }))
    .sort((a, b) => a.qualityScore - b.qualityScore);
}

/**
 * Identify campaigns with impression share loss to budget above 20%.
 * @param {Array} rows - parsed CSV rows from campaign performance report
 * @returns {Array}
 */
function detectBudgetImpShareLoss(rows) {
  return rows
    .filter((row) => {
      const val = row['Budget Lost IS (Search)'] || row['ImpressionShareLostToBudget'] || '0%';
      const pct = parseFloat(val.replace('%', ''));
      return Number.isFinite(pct) && pct > 20;
    })
    .map((row) => {
      const val = row['Budget Lost IS (Search)'] || row['ImpressionShareLostToBudget'] || '0%';
      const pct = parseFloat(val.replace('%', ''));
      return {
        type:                    'budget_impression_share_loss',
        campaignId:              row['Campaign Id'] || row['CampaignId'] || null,
        campaignName:            row['Campaign'] || row['CampaignName'] || null,
        budgetLostImpressionShare: pct,
        spend:                   parseFloat((row['Spend'] || row['spend'] || '0').replace(/[^0-9.]/g, '')),
        impressions:             parseInt(row['Impressions'] || '0', 10),
        recommendation:          `${pct.toFixed(0)}% IS lost to budget in "${row['Campaign'] || 'campaign'}" — consider increasing daily budget`,
      };
    })
    .sort((a, b) => b.budgetLostImpressionShare - a.budgetLostImpressionShare);
}

/**
 * Identify campaigns with average position worse than 4.0.
 * @param {Array} rows - parsed CSV rows
 * @returns {Array}
 */
function detectLowAvgPosition(rows) {
  return rows
    .filter((row) => {
      const pos = parseFloat(row['Avg. Position'] || row['AveragePosition'] || '0');
      return Number.isFinite(pos) && pos > 4.0;
    })
    .map((row) => ({
      type:            'low_avg_position',
      campaignId:      row['Campaign Id'] || row['CampaignId'] || null,
      campaignName:    row['Campaign'] || row['CampaignName'] || null,
      avgPosition:     parseFloat(parseFloat(row['Avg. Position'] || row['AveragePosition']).toFixed(1)),
      impressions:     parseInt(row['Impressions'] || '0', 10),
      spend:           parseFloat((row['Spend'] || '0').replace(/[^0-9.]/g, '')),
      recommendation:  `Avg position ${row['Avg. Position'] || row['AveragePosition']} in "${row['Campaign'] || 'campaign'}" — increase bids or improve QS to move up`,
    }))
    .sort((a, b) => b.avgPosition - a.avgPosition);
}

// ── Date range helper ─────────────────────────────────────────────────────────

function bingDateRange() {
  const end   = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - 14);
  const fmt = (d) => {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${d.getUTCFullYear()}-${mm}-${dd}`;
  };
  return { start: fmt(start), end: fmt(end) };
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  const accountId = siteConfig.ad_accounts && siteConfig.ad_accounts.bing_account_id;
  if (!accountId) {
    console.log(`[bing-ads] No bing_account_id for ${siteConfig.name}, skipping.`);
    return { skipped: true };
  }

  const accessToken      = await fetchAccessToken();
  const { start, end }   = bingDateRange();

  const timeRange = {
    CustomDateRangeStart: { Day: parseInt(start.slice(8)), Month: parseInt(start.slice(5, 7)), Year: parseInt(start.slice(0, 4)) },
    CustomDateRangeEnd:   { Day: parseInt(end.slice(8)),   Month: parseInt(end.slice(5, 7)),   Year: parseInt(end.slice(0, 4)) },
  };

  // Keyword Quality Score report
  const kwRequestId = await submitReportRequest({
    ReportName:    'KeywordPerformance',
    ReportType:    'KeywordPerformanceReport',
    Aggregation:   'Summary',
    Time:          { ...timeRange, PredefinedTime: null },
    Columns:       ['CampaignId', 'CampaignName', 'AdGroupName', 'Keyword', 'MatchType', 'QualityScore', 'Impressions', 'Clicks', 'Spend'],
    Filter:        null,
    Format:        'Csv',
    ReturnOnlyCompleteData: false,
  }, accessToken);

  // Campaign performance report (for IS loss + avg position)
  const campRequestId = await submitReportRequest({
    ReportName:    'CampaignPerformance',
    ReportType:    'CampaignPerformanceReport',
    Aggregation:   'Summary',
    Time:          { ...timeRange, PredefinedTime: null },
    Columns:       ['CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Spend', 'AveragePosition', 'ImpressionShareLostToBudget'],
    Filter:        null,
    Format:        'Csv',
    ReturnOnlyCompleteData: false,
  }, accessToken);

  // Poll both in parallel
  const [kwUrl, campUrl] = await Promise.all([
    pollReportStatus(kwRequestId,   accessToken),
    pollReportStatus(campRequestId, accessToken),
  ]);

  // Download and parse
  const [kwRows, campRows] = await Promise.all([
    downloadAndParseCsv(kwUrl),
    downloadAndParseCsv(campUrl),
  ]);

  const lowQs      = detectLowQualityScoreKeywords(kwRows);
  const budgetLoss = detectBudgetImpShareLoss(campRows);
  const lowPos     = detectLowAvgPosition(campRows);

  const report = {
    site:     siteConfig.name,
    date:     new Date().toISOString().slice(0, 10),
    dateRange: { start, end },
    summary: {
      lowQualityScoreKeywords:   lowQs.length,
      budgetImpressionShareLoss: budgetLoss.length,
      lowAvgPositionCampaigns:   lowPos.length,
    },
    findings: [
      ...lowQs,
      ...budgetLoss,
      ...lowPos,
    ],
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const today   = new Date().toISOString().slice(0, 10);
  const outFile = path.join(REPORTS_DIR, `${siteConfig.name}-bing-ads-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(
    `[bing-ads] ${siteConfig.name}: ` +
    `${lowQs.length} low-QS keywords, ` +
    `${budgetLoss.length} budget IS loss, ` +
    `${lowPos.length} low-position campaigns → ${outFile}`
  );

  return report;
}

module.exports = {
  run,
  detectLowQualityScoreKeywords,
  detectBudgetImpShareLoss,
  detectLowAvgPosition,
  parseCsvLine,
};
