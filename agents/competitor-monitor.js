'use strict';

// agents/competitor-monitor.js - Competitor Monitor
// Output: reports/{site}-competitor-diff-{date}.json

const fs = require('fs');
const path = require('path');

async function firecrawlScrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY env var is required');
  // Use Node 18+ built-in fetch; node-fetch@3 causes ESM/node-domexception
  // resolution failure on Node 24 via fetch-blob dependency.
  const res = await fetch('https://api.firecrawl.dev/v0/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ url, pageOptions: { onlyMainContent: false, includeHtml: true, waitFor: 1500 } }),
  });
  if (!res.ok) { const b = await res.text(); throw new Error('Firecrawl ' + res.status + ': ' + b); }
  const data = await res.json();
  if (!data.success) throw new Error('Firecrawl success=false for ' + url);
  return (data.data && data.data.html) ? data.data.html : '';
}

function hostnameOf(url) {
  try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname; }
  catch (e) { return url.replace(/[^a-zA-Z0-9.-]/g, '_'); }
}

function snapshotPath(hostname) {
  const dir = path.join(__dirname, '..', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hostname.replace(/[^a-zA-Z0-9.-]/g, '_') + '-last.html');
}

function loadSnapshot(hostname) {
  const p = snapshotPath(hostname);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function saveSnapshot(hostname, html) { fs.writeFileSync(snapshotPath(hostname), html, 'utf-8'); }

function extractTags(html, tag) {
  const rx = new RegExp('<' + tag + '[^>]*>([^<]*(?:<(?!\\/' + tag + '>)[^<]*)*)<\\/' + tag + '>', 'gi');
  const out = []; let m;
  while ((m = rx.exec(html)) !== null) {
    const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

function extractLinks(html) {
  const rx = /href=["']([^"'#?]+)["']/gi;
  const s = new Set(); let m;
  while ((m = rx.exec(html)) !== null) s.add(m[1].trim());
  return Array.from(s);
}

function extractPrices(html) {
  const rx = /(?:[$\xA3€]\s*\d[\d,.]*)|\b\d[\d,.]*\s*(?:\/mo|\/month|per\s+month)\b/gi;
  const s = new Set(); let m;
  while ((m = rx.exec(html)) !== null) s.add(m[0].trim());
  return Array.from(s);
}

function extractCTAs(html) {
  const s = new Set(); let m;
  const b = /<button[^>]*>([^<]{2,60})<\/button>/gi;
  while ((m = b.exec(html)) !== null) { const t = m[1].trim(); if (t) s.add(t); }
  const l = /<a[^>]+class=["'][^"']*(?:cta|btn|button)[^"']*["'][^>]*>([^<]{2,60})<\/a>/gi;
  while ((m = l.exec(html)) !== null) { const t = m[1].trim(); if (t) s.add(t); }
  return Array.from(s);
}

function arrayDiff(a, b) {
  const as = new Set(a), bs = new Set(b);
  return { added: b.filter(function(x) { return !as.has(x); }), removed: a.filter(function(x) { return !bs.has(x); }) };
}

function diffHtml(oldHtml, newHtml, competitorUrl) {
  const changes = [];
  const h1d = arrayDiff(extractTags(oldHtml, 'h1'), extractTags(newHtml, 'h1'));
  if (h1d.added.length || h1d.removed.length) changes.push({ category: 'heading_change', tag: 'h1', added: h1d.added, removed: h1d.removed });
  const h2d = arrayDiff(extractTags(oldHtml, 'h2'), extractTags(newHtml, 'h2'));
  if (h2d.added.length || h2d.removed.length) changes.push({ category: 'heading_change', tag: 'h2', added: h2d.added, removed: h2d.removed });
  const h3d = arrayDiff(extractTags(oldHtml, 'h3'), extractTags(newHtml, 'h3'));
  if (h3d.added.length) changes.push({ category: 'new_feature_copy', tag: 'h3', added: h3d.added });
  const pd = arrayDiff(extractPrices(oldHtml), extractPrices(newHtml));
  if (pd.added.length || pd.removed.length) changes.push({ category: 'price_change', added: pd.added, removed: pd.removed });
  const cd = arrayDiff(extractCTAs(oldHtml), extractCTAs(newHtml));
  if (cd.added.length) changes.push({ category: 'new_cta', added: cd.added });
  const ld = arrayDiff(extractLinks(oldHtml), extractLinks(newHtml));
  const hostname = hostnameOf(competitorUrl);
  const newLinks = ld.added.filter(function(l) { return !l.startsWith('http') || l.includes(hostname); });
  if (newLinks.length) changes.push({ category: 'new_pages_or_links', added: newLinks.slice(0, 20) });
  return changes;
}

function dateString(d) { return d.toISOString().slice(0, 10); }

async function run(siteConfig) {
  const name = siteConfig.name;
  const competitors = siteConfig.competitors || [];
  const today = dateString(new Date());
  const outPath = path.join(__dirname, '..', 'reports', name + '-competitor-diff-' + today + '.json');
  if (fs.existsSync(outPath)) return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const results = [];
  for (let i = 0; i < competitors.length; i++) {
    const comp = competitors[i];
    const url = comp.startsWith('http') ? comp : 'https://' + comp;
    const hostname = hostnameOf(url);
    try {
      const newHtml = await firecrawlScrape(url);
      const oldHtml = loadSnapshot(hostname);
      let changes = [], status = 'unchanged';
      if (!oldHtml) {
        status = 'first_run';
        changes = [
          { category: 'baseline_h1', values: extractTags(newHtml, 'h1') },
          { category: 'baseline_h2', values: extractTags(newHtml, 'h2').slice(0, 10) },
          { category: 'baseline_prices', values: extractPrices(newHtml) },
          { category: 'baseline_ctas', values: extractCTAs(newHtml).slice(0, 10) },
        ];
      } else {
        changes = diffHtml(oldHtml, newHtml, url);
        status = changes.length ? 'changed' : 'unchanged';
      }
      saveSnapshot(hostname, newHtml);
      results.push({ competitor: url, hostname, status, changes_count: changes.filter(function(c) { return !c.category.startsWith('baseline'); }).length, changes, scraped_at: new Date().toISOString() });
    } catch (err) {
      results.push({ competitor: url, hostname, status: 'error', error: err.message, changes_count: 0, changes: [], scraped_at: new Date().toISOString() });
    }
  }
  const report = {
    site: name, date: today,
    competitors_monitored: competitors.length,
    competitors_changed: results.filter(function(r) { return r.status === 'changed'; }).length,
    competitors_errored: results.filter(function(r) { return r.status === 'error'; }).length,
    results,
  };
  fs.mkdirSync(path.join(__dirname, '..', 'reports'), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

module.exports = { run, diffHtml, extractTags, extractPrices, extractCTAs, extractLinks };
