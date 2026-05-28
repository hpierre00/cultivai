'use strict';

// agents/google-ads.js - Google Ads Performance Agent
//
// Fetches from Google Ads REST API v14 using OAuth2.
// Identifies:
//   1. Keywords with Quality Score below 5
//   2. Ad groups with CTR below account average
//   3. Campaigns with Search Impression Share loss to budget above 20%
//
// Output: reports/{site}-google-ads-{date}.json

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR   = path.join(__dirname, '..', 'reports');
const API_BASE      = 'https://googleads.googleapis.com/v14';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const LOOKBACK_DAYS = 14;

// ── OAuth2 token exchange ─────────────────────────────────────────────────────

async function fetchAccessToken() {
  const {
    GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN,
  } = process.env;

  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN) {
    throw new Error('Missing Google Ads OAuth2 env vars (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)');
  }

  const body = new URLSearchParams({
    client_id:     GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  });

  const resp = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ── GAQL query helper ─────────────────────────────────────────────────────────

async function gaqlQuery(customerId, query, accessToken) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const loginId  = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  if (!devToken) throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');

  const headers = {
    'Authorization':           `Bearer ${accessToken}`,
    'developer-token':         devToken,
    'Content-Type':            'application/json',
  };
  if (loginId) headers['login-customer-id'] = loginId;

  const url  = `${API_BASE}/customers/${customerId}/googleAds:searchStream`;
  const resp = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GAQL query failed ${resp.status}: ${text}`);
  }

  // searchStream returns NDJSON batches
  const text  = await resp.text();
  const rows  = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[' || trimmed === ']') continue;
    // Strip leading comma if present
    const clean = trimmed.replace(/^,/, '');
    if (!clean) continue;
    try {
      const batch = JSON.parse(clean);
      if (batch.results) rows.push(...batch.results);
    } catch {
      // partial line or metadata — skip
    }
  }

  return rows;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateString(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function gaqlDateRange() {
  const end   = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - LOOKBACK_DAYS);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// ── Gap detectors (exported for testing) ─────────────────────────────────────

/**
 * Identify keywords with Quality Score below 5.
 * @param {Array} rows - raw GAQL result rows
 * @returns {Array} flagged keyword objects
 */
function detectLowQualityScoreKeywords(rows) {
  const flagged = [];

  for (const row of rows) {
    const qs = row.adGroupCriterion && row.adGroupCriterion.qualityInfo
      ? row.adGroupCriterion.qualityInfo.qualityScore
      : null;

    if (qs === null || qs === undefined) continue;

    const score = Number(qs);
    if (!Number.isFinite(score) || score >= 5) continue;

    const keyword    = row.adGroupCriterion && row.adGroupCriterion.keyword
      ? row.adGroupCriterion.keyword.text
      : 'unknown';
    const matchType  = row.adGroupCriterion && row.adGroupCriterion.keyword
      ? row.adGroupCriterion.keyword.matchType
      : 'UNKNOWN';
    const adGroupId  = row.adGroup   ? row.adGroup.id          : null;
    const campaignId = row.campaign  ? row.campaign.id         : null;

    const expCtr  = row.adGroupCriterion.qualityInfo.searchExpectedCtr;
    const adRel   = row.adGroupCriterion.qualityInfo.adRelevance;
    const lpExp   = row.adGroupCriterion.qualityInfo.landingPageExperience;

    flagged.push({
      type:                   'low_quality_score',
      keyword,
      matchType,
      qualityScore:           score,
      adGroupId,
      campaignId,
      expectedCtr:            expCtr   || null,
      adRelevance:            adRel    || null,
      landingPageExperience:  lpExp    || null,
      recommendation:         `QS ${score}/10 — review ad copy relevance and landing page experience for "${keyword}"`,
    });
  }

  return flagged.sort((a, b) => a.qualityScore - b.qualityScore);
}

/**
 * Identify ad groups with CTR below account average.
 * @param {Array} rows - raw GAQL result rows with metrics
 * @returns {Array} flagged ad group objects
 */
function detectLowCtrAdGroups(rows) {
  if (!rows.length) return [];

  // Compute total clicks and impressions for account average
  let totalClicks      = 0;
  let totalImpressions = 0;

  const adGroupMap = {};

  for (const row of rows) {
    const clicks      = Number(row.metrics && row.metrics.clicks       || 0);
    const impressions = Number(row.metrics && row.metrics.impressions  || 0);
    const adGroupId   = row.adGroup ? row.adGroup.id   : 'unknown';
    const adGroupName = row.adGroup ? row.adGroup.name : 'unknown';
    const campaignId  = row.campaign ? row.campaign.id : null;

    totalClicks      += clicks;
    totalImpressions += impressions;

    if (!adGroupMap[adGroupId]) {
      adGroupMap[adGroupId] = { adGroupId, adGroupName, campaignId, clicks: 0, impressions: 0 };
    }
    adGroupMap[adGroupId].clicks      += clicks;
    adGroupMap[adGroupId].impressions += impressions;
  }

  const accountAvgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  const flagged = [];

  for (const ag of Object.values(adGroupMap)) {
    if (ag.impressions < 100) continue; // insufficient data
    const ctr = ag.clicks / ag.impressions;
    if (ctr >= accountAvgCtr) continue;

    flagged.push({
      type:           'low_ctr_ad_group',
      adGroupId:      ag.adGroupId,
      adGroupName:    ag.adGroupName,
      campaignId:     ag.campaignId,
      clicks:         ag.clicks,
      impressions:    ag.impressions,
      ctr:            parseFloat((ctr * 100).toFixed(2)),
      accountAvgCtr:  parseFloat((accountAvgCtr * 100).toFixed(2)),
      recommendation: `CTR ${(ctr * 100).toFixed(2)}% vs account avg ${(accountAvgCtr * 100).toFixed(2)}% — review ad copy and targeting for "${ag.adGroupName}"`,
    });
  }

  return flagged.sort((a, b) => a.ctr - b.ctr);
}

/**
 * Identify campaigns with Search Impression Share loss to budget above 20%.
 * @param {Array} rows - raw GAQL result rows with IS metrics
 * @returns {Array} flagged campaign objects
 */
function detectBudgetImpShareLoss(rows) {
  const flagged = [];

  for (const row of rows) {
    const lossRaw = row.metrics && row.metrics.searchBudgetLostImpressionShare;
    if (lossRaw === null || lossRaw === undefined) continue;

    const loss = Number(lossRaw);
    if (!Number.isFinite(loss) || loss <= 0.2) continue;

    const campaignId   = row.campaign ? row.campaign.id     : null;
    const campaignName = row.campaign ? row.campaign.name   : 'unknown';
    const budget       = row.campaign && row.campaign.campaignBudget
      ? row.campaign.campaignBudget
      : null;
    const impressionShare = row.metrics && row.metrics.searchImpressionShare
      ? Number(row.metrics.searchImpressionShare)
      : null;

    flagged.push({
      type:                    'budget_impression_share_loss',
      campaignId,
      campaignName,
      budgetLostImpressionShare: parseFloat((loss * 100).toFixed(2)),
      impressionShare:           impressionShare !== null
        ? parseFloat((impressionShare * 100).toFixed(2))
        : null,
      recommendation: `${(loss * 100).toFixed(0)}% IS lost to budget in "${campaignName}" — consider increasing daily budget or narrowing targeting`,
    });
  }

  return flagged.sort((a, b) => b.budgetLostImpressionShare - a.budgetLostImpressionShare);
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  const customerId = siteConfig.ad_accounts && siteConfig.ad_accounts.google_ads_customer_id;
  if (!customerId) {
    console.log(`[google-ads] No google_ads_customer_id for ${siteConfig.name}, skipping.`);
    return { skipped: true };
  }

  const accessToken = await fetchAccessToken();
  const { start, end } = gaqlDateRange();
  const dateRange = `segments.date BETWEEN '${start}' AND '${end}'`;

  // Query 1: Keyword Quality Score (last 14 days, include QS components)
  const qsQuery = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.search_expected_ctr,
      ad_group_criterion.quality_info.ad_relevance,
      ad_group_criterion.quality_info.landing_page_experience
    FROM keyword_view
    WHERE ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.status != 'REMOVED'
      AND ${dateRange}
  `.trim();

  // Query 2: Ad group CTR
  const adGroupQuery = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.name,
      metrics.clicks,
      metrics.impressions
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'
      AND ${dateRange}
  `.trim();

  // Query 3: Campaign impression share
  const isQuery = `
    SELECT
      campaign.id,
      campaign.name,
      metrics.search_impression_share,
      metrics.search_budget_lost_impression_share
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND ${dateRange}
  `.trim();

  const [qsRows, adGroupRows, isRows] = await Promise.all([
    gaqlQuery(customerId, qsQuery,      accessToken),
    gaqlQuery(customerId, adGroupQuery, accessToken),
    gaqlQuery(customerId, isQuery,      accessToken),
  ]);

  const lowQs        = detectLowQualityScoreKeywords(qsRows);
  const lowCtrGroups = detectLowCtrAdGroups(adGroupRows);
  const budgetLoss   = detectBudgetImpShareLoss(isRows);

  const report = {
    site:      siteConfig.name,
    date:      new Date().toISOString().slice(0, 10),
    lookbackDays: LOOKBACK_DAYS,
    dateRange: { start, end },
    summary: {
      lowQualityScoreKeywords:    lowQs.length,
      lowCtrAdGroups:             lowCtrGroups.length,
      budgetImpressionShareLoss:  budgetLoss.length,
    },
    findings: [
      ...lowQs,
      ...lowCtrGroups,
      ...budgetLoss,
    ],
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const today    = new Date().toISOString().slice(0, 10);
  const outFile  = path.join(REPORTS_DIR, `${siteConfig.name}-google-ads-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(
    `[google-ads] ${siteConfig.name}: ` +
    `${lowQs.length} low-QS keywords, ` +
    `${lowCtrGroups.length} low-CTR ad groups, ` +
    `${budgetLoss.length} budget IS loss campaigns → ${outFile}`
  );

  return report;
}

module.exports = {
  run,
  fetchAccessToken,
  detectLowQualityScoreKeywords,
  detectLowCtrAdGroups,
  detectBudgetImpShareLoss,
};
