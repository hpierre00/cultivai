'use strict';

// agents/gsc-gap.js - Google Search Console Gap Detector
// Output: reports/{site}-gsc-gaps-{date}.json

const fs = require('fs');
const path = require('path');

function buildAuthClient() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GSC_SERVICE_ACCOUNT_JSON env var is required');
  let credentials;
  try { credentials = JSON.parse(raw); }
  catch (e) { throw new Error('GSC_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  const { google } = require('googleapis');
  const subject = process.env.GSC_SUBJECT_EMAIL;
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    subject: subject || undefined,
  });
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function withRetry(fn, label) {
  let lastErr;
  for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < RETRY_ATTEMPTS) {
        const d = RETRY_BASE_MS * Math.pow(2, i - 1);
        console.warn('[gsc-gap] ' + label + ' attempt ' + i + ' failed: ' + err.message + '. Retry in ' + d + 'ms');
        await sleep(d);
      }
    }
  }
  throw lastErr;
}

async function fetchReport(sc, property, dimensions, startDate, endDate, rowLimit) {
  return withRetry(async function() {
    const res = await sc.searchanalytics.query({
      siteUrl: property,
      requestBody: { startDate, endDate, dimensions, rowLimit: rowLimit || 5000, dataState: 'final' },
    });
    return res.data.rows || [];
  }, 'fetchReport[' + dimensions.join(',') + ']');
}

function dateString(d) { return d.toISOString().slice(0, 10); }

function getDateRange(days) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - (days || 28));
  return { startDate: dateString(start), endDate: dateString(end) };
}

function getCachePath(siteName, date) {
  return path.join(__dirname, '..', 'reports', siteName + '-gsc-gaps-' + date + '.json');
}

function loadFromCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      const d = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (d._cached) return d;
    }
  } catch (e) {}
  return null;
}

function detectLowCtrPages(pageRows) {
  return pageRows
    .filter(function(r) { return r.impressions > 100 && r.ctr < 0.03; })
    .map(function(r) {
      return {
        type: 'low_ctr_page',
        page: r.keys[0],
        impressions: r.impressions,
        ctr: +(r.ctr * 100).toFixed(2),
        clicks: r.clicks,
        position: +r.position.toFixed(1),
        recommendation: 'Improve meta title and description to increase click-through rate',
      };
    })
    .sort(function(a, b) { return b.impressions - a.impressions; });
}

function detectPage2Opportunities(pageRows) {
  return pageRows
    .filter(function(r) { return r.position >= 11 && r.position <= 20; })
    .map(function(r) {
      return {
        type: 'page_2_opportunity',
        page: r.keys[0],
        position: +r.position.toFixed(1),
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: +(r.ctr * 100).toFixed(2),
        recommendation: 'Content expansion or on-page SEO could push this to page 1',
      };
    })
    .sort(function(a, b) { return b.impressions - a.impressions; });
}

function detectQueryWithoutPage(queryRows, pageQueryRows) {
  var homepagePattern = /^https?:\/\/[^/]+(\/)?$/;
  var queryPageMap = {};
  pageQueryRows.forEach(function(r) {
    var page = r.keys[0], query = r.keys[1];
    if (!queryPageMap[query]) queryPageMap[query] = new Set();
    queryPageMap[query].add(page);
  });
  return queryRows
    .filter(function(r) {
      if (r.impressions <= 50) return false;
      var query = r.keys[0];
      var pages = queryPageMap[query];
      if (!pages || pages.size === 0) return true;
      var arr = Array.from(pages);
      return arr.length > 3 || (arr.length === 1 && homepagePattern.test(arr[0]));
    })
    .map(function(r) {
      var query = r.keys[0];
      return {
        type: 'missing_landing_page',
        query: query,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: +(r.ctr * 100).toFixed(2),
        position: +r.position.toFixed(1),
        pages: Array.from(queryPageMap[query] || []),
        recommendation: 'Create a dedicated landing page targeting this query',
      };
    })
    .sort(function(a, b) { return b.impressions - a.impressions; });
}

async function run(siteConfig) {
  var name = siteConfig.name;
  var gsc_property = siteConfig.gsc_property;
  var range = getDateRange(28);
  var today = dateString(new Date());
  var cachePath = getCachePath(name, today);
  var cached = loadFromCache(cachePath);
  if (cached) { console.log('[gsc-gap] Cache hit: ' + name); return cached; }
  var auth = buildAuthClient();
  var { google } = require('googleapis');
  var sc = google.searchconsole({ version: 'v1', auth });
  var results = await Promise.all([
    fetchReport(sc, gsc_property, ['page'], range.startDate, range.endDate),
    fetchReport(sc, gsc_property, ['query'], range.startDate, range.endDate),
    fetchReport(sc, gsc_property, ['page', 'query'], range.startDate, range.endDate, 10000),
  ]);
  var lowCtrPages = detectLowCtrPages(results[0]);
  var page2 = detectPage2Opportunities(results[0]);
  var missing = detectQueryWithoutPage(results[1], results[2]);
  var report = {
    site: name, gsc_property, date: today,
    date_range: { startDate: range.startDate, endDate: range.endDate },
    summary: { low_ctr_pages: lowCtrPages.length, page_2_opportunities: page2.length, missing_landing_pages: missing.length, total_gaps: lowCtrPages.length + page2.length + missing.length },
    gaps: { low_ctr_pages: lowCtrPages, page_2_opportunities: page2, missing_landing_pages: missing },
    _cached: false,
  };
  fs.mkdirSync(path.join(__dirname, '..', 'reports'), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(Object.assign({}, report, { _cached: true }), null, 2));
  return report;
}

module.exports = { run, detectLowCtrPages, detectPage2Opportunities, detectQueryWithoutPage };
