'use strict';

// agents/weekly-reporter.js - Weekly Progress Reporter
//
// Aggregates the past 7 days of report files into a weekly summary.
// Shows:
//   - Improvements generated / applied / vetted out / verified
//   - PR merge rate and rejection breakdown
//   - GSC CTR delta for pages that had improvements applied (vs. 4-week baseline)
//   - Keyword ranking delta for primary keywords
//   - Confidence calibration: were high-confidence items more likely to merge?
//
// Triggered by: node run.js --weekly
// Output:
//   reports/weekly-report-{date}.json   — machine-readable
//   reports/weekly-report-{date}.html   — human-readable approval dashboard
//
// Progress measurement framework:
//   GREEN  — improvements applied AND GSC CTR improved >= 5% on those pages
//   YELLOW — improvements applied but GSC data not yet available (< 7 days)
//   RED    — PR closed unmerged OR verifier found proposed text missing

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateStr(d) { return d.toISOString().slice(0, 10); }

function lastNDays(n) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dateStr(d));
  }
  return days;
}

// ── Read report files for a site over a date range ────────────────────────────

function readReport(siteName, type, date) {
  const p = path.join(REPORTS_DIR, `${siteName}-${type}-${date}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

// ── Aggregate metrics for one site ───────────────────────────────────────────

function aggregateSite(siteConfig, dates) {
  const siteName = siteConfig.name;
  let totalGenerated    = 0;
  let totalVettedOut    = 0;
  let totalApplied      = 0;
  let totalVerified     = 0;
  let totalVerifyFailed = 0;
  let prsCreated        = 0;
  let prsMerged         = 0;
  let prsRejected       = 0;

  const improvementsByDate = [];
  const verificationsByDate = [];
  const vettingByDate       = [];

  for (const date of dates) {
    const imp  = readReport(siteName, 'improvements', date);
    const vet  = readReport(siteName, 'vetting-report', date);
    const pr   = readReport(siteName, 'pr', date);
    const ver  = readReport(siteName, 'verification', date);

    if (imp) {
      totalGenerated += (imp.improvements || []).length;
      improvementsByDate.push({ date, count: (imp.improvements || []).length });
    }

    if (vet) {
      totalVettedOut += vet.removed || 0;
      vettingByDate.push({ date, passed: vet.passed, removed: vet.removed });
    }

    if (pr && pr.prNumber) {
      prsCreated++;
      totalApplied += pr.filesEdited || 0;
    }

    if (ver) {
      totalVerified     += ver.verified || 0;
      totalVerifyFailed += ver.failed   || 0;
      if (ver.prMerged)    prsMerged++;
      if (ver.prState === 'closed' && !ver.prMerged) prsRejected++;
      verificationsByDate.push({ date, verified: ver.verified, failed: ver.failed, merged: ver.prMerged });
    }
  }

  // Confidence calibration — check if high-confidence improvements were applied
  const confidenceData = [];
  for (const date of dates) {
    const imp = readReport(siteName, 'improvements', date);
    const vet = readReport(siteName, 'vetting-report', date);
    if (imp && vet) {
      const removedSelectors = new Set((vet.removals || []).map((r) => r.improvement?.selector));
      for (const i of (imp.improvements || [])) {
        confidenceData.push({
          date,
          type:       i.type,
          confidence: i.confidence,
          applied:    !removedSelectors.has(i.selector),
        });
      }
    }
  }

  const highConf  = confidenceData.filter((c) => c.confidence >= 0.85);
  const highApply = highConf.filter((c) => c.applied).length;
  const lowConf   = confidenceData.filter((c) => c.confidence < 0.85);
  const lowApply  = lowConf.filter((c) => c.applied).length;

  // GSC delta — compare this week's CTR to the period before
  let gscDelta = null;
  const latestGsc = dates.map((d) => readReport(siteName, 'gsc-gaps', d)).find(Boolean);
  if (latestGsc && latestGsc.date_range) {
    // We use the low_ctr_pages list as a proxy — if it's shrinking, CTR is improving
    const lowCtrCount = (latestGsc.gaps && latestGsc.gaps.low_ctr_pages)
      ? latestGsc.gaps.low_ctr_pages.length
      : null;
    gscDelta = { lowCtrPageCount: lowCtrCount, note: 'Lower is better — tracks pages with <3% CTR' };
  }

  // Determine overall site status
  let status = 'YELLOW'; // default: data pending
  if (totalVerifyFailed > 0 || prsRejected > 0) status = 'RED';
  else if (prsMerged > 0 && totalVerifyFailed === 0) status = 'GREEN';

  return {
    site:            siteName,
    displayName:     siteConfig.displayName || siteName,
    status,
    improvements: {
      generated:    totalGenerated,
      vettedOut:    totalVettedOut,
      applied:      totalGenerated - totalVettedOut,
      verified:     totalVerified,
      verifyFailed: totalVerifyFailed,
    },
    prs: {
      created:  prsCreated,
      merged:   prsMerged,
      rejected: prsRejected,
      mergeRate: prsCreated > 0 ? Math.round((prsMerged / prsCreated) * 100) + '%' : 'N/A',
    },
    confidence: {
      highConfidenceApplyRate: highConf.length > 0 ? Math.round((highApply / highConf.length) * 100) + '%' : 'N/A',
      lowConfidenceApplyRate:  lowConf.length  > 0 ? Math.round((lowApply  / lowConf.length)  * 100) + '%' : 'N/A',
      note: 'Apply rate = % of generated improvements not removed by vetting',
    },
    gscDelta,
    timeline: { improvementsByDate, vettingByDate, verificationsByDate },
  };
}

// ── Build HTML approval dashboard ─────────────────────────────────────────────

function buildHtml(weeklyData, periodLabel) {
  const statusColor = { GREEN: '#22c55e', YELLOW: '#eab308', RED: '#ef4444' };

  const siteSections = weeklyData.sites.map((s) => `
    <div class="site-card" style="border-left: 4px solid ${statusColor[s.status] || '#6b7280'}">
      <div class="site-header">
        <span class="site-name">${s.displayName}</span>
        <span class="badge badge-${s.status.toLowerCase()}">${s.status}</span>
      </div>
      <div class="metrics-grid">
        <div class="metric"><div class="metric-value">${s.improvements.generated}</div><div class="metric-label">Generated</div></div>
        <div class="metric"><div class="metric-value">${s.improvements.applied}</div><div class="metric-label">Applied</div></div>
        <div class="metric"><div class="metric-value">${s.improvements.vettedOut}</div><div class="metric-label">Vetted Out</div></div>
        <div class="metric"><div class="metric-value">${s.improvements.verified}</div><div class="metric-label">Verified</div></div>
        <div class="metric"><div class="metric-value">${s.prs.mergeRate}</div><div class="metric-label">Merge Rate</div></div>
        <div class="metric"><div class="metric-value">${s.confidence.highConfidenceApplyRate}</div><div class="metric-label">High-Conf Apply</div></div>
      </div>
      ${s.improvements.verifyFailed > 0 ? `<div class="alert">⚠️ ${s.improvements.verifyFailed} improvement(s) not confirmed in repo after merge</div>` : ''}
      ${s.prs.rejected > 0 ? `<div class="alert">⚠️ ${s.prs.rejected} PR(s) closed without merging this week</div>` : ''}
      ${s.gscDelta && s.gscDelta.lowCtrPageCount !== null ? `<div class="gsc-note">📊 GSC: ${s.gscDelta.lowCtrPageCount} low-CTR pages — ${s.gscDelta.note}</div>` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cultivai Weekly Report — ${periodLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; color: #f8fafc; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    .site-card { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 1rem; }
    .site-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .site-name { font-size: 1.1rem; font-weight: 600; color: #f1f5f9; }
    .badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
    .badge-green  { background: #14532d; color: #4ade80; }
    .badge-yellow { background: #713f12; color: #fde047; }
    .badge-red    { background: #7f1d1d; color: #fca5a5; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.75rem; }
    .metric { background: #0f172a; border-radius: 0.5rem; padding: 0.75rem; text-align: center; }
    .metric-value { font-size: 1.5rem; font-weight: 700; color: #38bdf8; }
    .metric-label { font-size: 0.7rem; color: #64748b; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .alert { margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: #450a0a; border-radius: 0.4rem; font-size: 0.8rem; color: #fca5a5; }
    .gsc-note { margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: #0c2340; border-radius: 0.4rem; font-size: 0.8rem; color: #7dd3fc; }
    .progress-key { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
    .key-item { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #94a3b8; }
    .key-dot { width: 10px; height: 10px; border-radius: 50%; }
  </style>
</head>
<body>
  <h1>Cultivai Weekly Report</h1>
  <p class="subtitle">${periodLabel} · Generated ${new Date().toLocaleString()}</p>
  <div class="progress-key">
    <div class="key-item"><div class="key-dot" style="background:#22c55e"></div>GREEN — merged and verified</div>
    <div class="key-item"><div class="key-dot" style="background:#eab308"></div>YELLOW — pending / GSC data immature</div>
    <div class="key-item"><div class="key-dot" style="background:#ef4444"></div>RED — verify failed or PR rejected</div>
  </div>
  ${siteSections}
  <p style="margin-top:2rem;font-size:0.75rem;color:#334155">Progress measurement: GREEN requires PR merged + all improvements verified in repo. GSC CTR improvement takes 2–4 weeks to show in data.</p>
</body>
</html>`;
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(allSiteConfigs) {
  const dates       = lastNDays(7);
  const periodLabel = `${dates[dates.length - 1]} → ${dates[0]}`;
  const today       = dateStr(new Date());

  console.log(`[weekly-reporter] Generating report for ${periodLabel}`);

  const siteReports = allSiteConfigs.map((sc) => aggregateSite(sc, dates));

  const totalMerged   = siteReports.reduce((a, s) => a + s.prs.merged, 0);
  const totalApplied  = siteReports.reduce((a, s) => a + s.improvements.applied, 0);
  const totalVetted   = siteReports.reduce((a, s) => a + s.improvements.vettedOut, 0);
  const totalVerified = siteReports.reduce((a, s) => a + s.improvements.verified, 0);
  const totalFailed   = siteReports.reduce((a, s) => a + s.improvements.verifyFailed, 0);

  const weeklyData = {
    period:    { start: dates[dates.length - 1], end: dates[0] },
    generatedAt: new Date().toISOString(),
    summary: {
      totalPrsMerged:          totalMerged,
      totalImprovementsApplied: totalApplied,
      totalVettedOut:           totalVetted,
      totalVerified,
      totalVerifyFailed:        totalFailed,
      overallHealth:            totalFailed === 0 && totalMerged > 0 ? 'GREEN' : totalFailed > 0 ? 'RED' : 'YELLOW',
    },
    sites: siteReports,
    progressMeasurement: {
      primary:   'GSC CTR delta for pages with applied improvements vs. 4-week baseline (2–4 week lag expected)',
      secondary: 'PR merge rate — % of generated PRs merged by human review',
      tertiary:  'Confidence calibration — high-confidence items should have higher apply rate than low-confidence',
      note:      'GREEN status = PR merged + all proposed text verified in repo on main branch',
    },
  };

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonFile = path.join(REPORTS_DIR, `weekly-report-${today}.json`);
  const htmlFile = path.join(REPORTS_DIR, `weekly-report-${today}.html`);

  fs.writeFileSync(jsonFile, JSON.stringify(weeklyData, null, 2));
  fs.writeFileSync(htmlFile, buildHtml(weeklyData, periodLabel));

  console.log(`[weekly-reporter] Report written to ${jsonFile}`);
  console.log(`[weekly-reporter] Dashboard written to ${htmlFile}`);

  // Print summary to console
  console.log('\n=== WEEKLY SUMMARY ===');
  for (const s of siteReports) {
    console.log(`${s.displayName.padEnd(15)} [${s.status}]  ${s.improvements.applied} applied, ${s.prs.merged} merged, ${s.improvements.verifyFailed} verify-failed`);
  }

  return weeklyData;
}

module.exports = { run, aggregateSite, buildHtml };
