'use strict';

// agents/meta-ads.js - Meta Ads Performance Agent
//
// Fetches from Meta Marketing API v18 using a long-lived access token.
// Identifies:
//   1. Ad sets with relevance score / quality ranking below threshold
//   2. Ad sets with frequency above 3.0 (audience fatigue risk)
//   3. Campaigns with CPM trending up more than 20% week-over-week
//
// Output: reports/{site}-meta-ads-{date}.json

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const API_BASE    = 'https://graph.facebook.com/v18.0';

// ── API helper ────────────────────────────────────────────────────────────────

async function metaGet(endpoint, params = {}) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) throw new Error('Missing META_ACCESS_TOKEN env var');

  const qs = new URLSearchParams({ access_token: accessToken, ...params });
  const url = `${API_BASE}${endpoint}?${qs.toString()}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Meta API ${resp.status} for ${endpoint}: ${text}`);
  }

  return resp.json();
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoDate(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ── Gap detectors (exported for testing) ─────────────────────────────────────

/**
 * Flag ad sets where quality_ranking or engagement_rate_ranking is BELOW_AVERAGE.
 * Meta replaced numeric relevance score with ranking enums in v8+.
 * @param {Array} adSets
 * @returns {Array}
 */
function detectLowRelevanceAdSets(adSets) {
  const BELOW_VALUES = new Set([
    'BELOW_AVERAGE_10',
    'BELOW_AVERAGE_20',
    'BELOW_AVERAGE_35',
  ]);

  return adSets
    .filter((ad) => {
      const qr  = ad.quality_ranking;
      const er  = ad.engagement_rate_ranking;
      const cvr = ad.conversion_rate_ranking;
      return (
        BELOW_VALUES.has(qr) ||
        BELOW_VALUES.has(er) ||
        BELOW_VALUES.has(cvr)
      );
    })
    .map((ad) => ({
      type:                   'low_relevance_ad_set',
      adSetId:                ad.id,
      adSetName:              ad.name,
      campaignId:             ad.campaign_id,
      qualityRanking:         ad.quality_ranking          || null,
      engagementRanking:      ad.engagement_rate_ranking  || null,
      conversionRanking:      ad.conversion_rate_ranking  || null,
      spend:                  parseFloat(ad.spend || 0),
      impressions:            parseInt(ad.impressions || 0, 10),
      recommendation:         `Ad set "${ad.name}" has below-average rankings — refresh creatives or tighten audience targeting`,
    }));
}

/**
 * Flag ad sets with frequency above 3.0 (audience fatigue).
 * @param {Array} adSets
 * @returns {Array}
 */
function detectHighFrequencyAdSets(adSets) {
  return adSets
    .filter((ad) => {
      const freq = parseFloat(ad.frequency || 0);
      return freq > 3.0;
    })
    .map((ad) => ({
      type:           'high_frequency_ad_set',
      adSetId:        ad.id,
      adSetName:      ad.name,
      campaignId:     ad.campaign_id,
      frequency:      parseFloat(parseFloat(ad.frequency || 0).toFixed(2)),
      spend:          parseFloat(ad.spend || 0),
      impressions:    parseInt(ad.impressions || 0, 10),
      reach:          parseInt(ad.reach || 0, 10),
      recommendation: `Frequency ${parseFloat(ad.frequency).toFixed(1)}x in "${ad.name}" — expand audience or rotate creatives to reduce fatigue`,
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Flag campaigns where CPM increased more than 20% week-over-week.
 * Compares this week vs prior week CPM.
 * @param {Array} thisWeek  - campaign insights for most recent 7 days
 * @param {Array} priorWeek - campaign insights for prior 7 days
 * @returns {Array}
 */
function detectCpmTrend(thisWeek, priorWeek) {
  // Index prior week by campaign id
  const priorMap = {};
  for (const row of priorWeek) {
    priorMap[row.campaign_id] = row;
  }

  const flagged = [];

  for (const curr of thisWeek) {
    const prior = priorMap[curr.campaign_id];
    if (!prior) continue;

    const cpmCurr  = parseFloat(curr.cpm  || 0);
    const cpmPrior = parseFloat(prior.cpm || 0);

    if (cpmPrior === 0) continue;

    const changePct = (cpmCurr - cpmPrior) / cpmPrior;
    if (changePct <= 0.2) continue;

    flagged.push({
      type:              'cpm_trend_increase',
      campaignId:        curr.campaign_id,
      campaignName:      curr.campaign_name,
      cpmThisWeek:       parseFloat(cpmCurr.toFixed(2)),
      cpmPriorWeek:      parseFloat(cpmPrior.toFixed(2)),
      changePercent:     parseFloat((changePct * 100).toFixed(1)),
      spendThisWeek:     parseFloat(curr.spend  || 0),
      spendPriorWeek:    parseFloat(prior.spend || 0),
      recommendation:    `CPM rose ${(changePct * 100).toFixed(0)}% week-over-week in "${curr.campaign_name}" — check audience saturation or bid competition`,
    });
  }

  return flagged.sort((a, b) => b.changePercent - a.changePercent);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchAdSetInsights(adAccountId, datePreset) {
  const data = await metaGet(`/act_${adAccountId}/insights`, {
    level:  'adset',
    fields: [
      'adset_id',
      'adset_name',
      'campaign_id',
      'impressions',
      'reach',
      'frequency',
      'spend',
      'quality_ranking',
      'engagement_rate_ranking',
      'conversion_rate_ranking',
    ].join(','),
    date_preset: datePreset,
    limit: '500',
  });

  return (data.data || []).map((row) => ({
    id:                     row.adset_id,
    name:                   row.adset_name,
    campaign_id:            row.campaign_id,
    impressions:            row.impressions,
    reach:                  row.reach,
    frequency:              row.frequency,
    spend:                  row.spend,
    quality_ranking:        row.quality_ranking,
    engagement_rate_ranking: row.engagement_rate_ranking,
    conversion_rate_ranking: row.conversion_rate_ranking,
  }));
}

async function fetchCampaignInsights(adAccountId, since, until) {
  const data = await metaGet(`/act_${adAccountId}/insights`, {
    level:      'campaign',
    fields:     'campaign_id,campaign_name,impressions,spend,cpm',
    time_range: JSON.stringify({ since, until }),
    limit:      '500',
  });
  return data.data || [];
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  const adAccountId = siteConfig.ad_accounts && siteConfig.ad_accounts.meta_ad_account_id;
  if (!adAccountId) {
    console.log(`[meta-ads] No meta_ad_account_id for ${siteConfig.name}, skipping.`);
    return { skipped: true };
  }

  // Fetch ad-set level data (last 14 days for relevance + frequency)
  const adSetData = await fetchAdSetInsights(adAccountId, 'last_14d');

  // Fetch campaign CPM for this week and prior week
  const today       = new Date();
  const thisStart   = isoDate(7);
  const thisEnd     = isoDate(0);
  const priorStart  = isoDate(14);
  const priorEnd    = isoDate(8);

  const [thisWeekCampaigns, priorWeekCampaigns] = await Promise.all([
    fetchCampaignInsights(adAccountId, thisStart, thisEnd),
    fetchCampaignInsights(adAccountId, priorStart, priorEnd),
  ]);

  const lowRelevance = detectLowRelevanceAdSets(adSetData);
  const highFreq     = detectHighFrequencyAdSets(adSetData);
  const cpmTrend     = detectCpmTrend(thisWeekCampaigns, priorWeekCampaigns);

  const report = {
    site:     siteConfig.name,
    date:     today.toISOString().slice(0, 10),
    dateRange: { adSets: 'last_14d', cpmThisWeek: `${thisStart} to ${thisEnd}`, cpmPriorWeek: `${priorStart} to ${priorEnd}` },
    summary: {
      lowRelevanceAdSets:    lowRelevance.length,
      highFrequencyAdSets:   highFreq.length,
      cpmTrendIncreases:     cpmTrend.length,
    },
    findings: [
      ...lowRelevance,
      ...highFreq,
      ...cpmTrend,
    ],
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const outFile = path.join(
    REPORTS_DIR,
    `${siteConfig.name}-meta-ads-${today.toISOString().slice(0, 10)}.json`
  );
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(
    `[meta-ads] ${siteConfig.name}: ` +
    `${lowRelevance.length} low-relevance, ` +
    `${highFreq.length} high-frequency, ` +
    `${cpmTrend.length} CPM trend alerts → ${outFile}`
  );

  return report;
}

module.exports = {
  run,
  detectLowRelevanceAdSets,
  detectHighFrequencyAdSets,
  detectCpmTrend,
};
