'use strict';

// agents/outcome-tracker.js - PR Outcome Tracker
//
// Checks open Cultivai PRs for each site and records:
//   - Merged PRs (improvements accepted)
//   - Closed-without-merge PRs (improvements rejected)
//   - Open PRs still awaiting review
//
// Writes to reports/{site}-outcomes-{date}.json
// Also appends to reports/{site}-outcome-history.json for longitudinal tracking.

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR      = path.join(__dirname, '..', 'reports');
const PR_BRANCH_PREFIX = 'cultivai/';

// ── GitHub API helper ─────────────────────────────────────────────────────────

async function getOctokit() {
  const token = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN / CULTIVAI_GITHUB_TOKEN env var');
  const { Octokit } = require('@octokit/rest');
  return new Octokit({ auth: token });
}

function parseRepo(repoString) {
  const [owner, repo] = repoString.split('/');
  if (!owner || !repo) throw new Error(`Invalid github_repo format: ${repoString}`);
  return { owner, repo };
}

// ── Classify a PR ─────────────────────────────────────────────────────────────

function classifyPr(pr) {
  if (pr.merged_at)                                      return 'merged';
  if (pr.state === 'closed' && !pr.merged_at)           return 'rejected';
  return 'open';
}

/**
 * Compute acceptance rate from outcome history entries.
 * @param {Array} history
 * @returns {{ merged: number, rejected: number, open: number, acceptanceRate: number }}
 */
function computeStats(history) {
  const counts = { merged: 0, rejected: 0, open: 0 };
  for (const entry of history) {
    for (const pr of (entry.prs || [])) {
      if (counts[pr.outcome] !== undefined) counts[pr.outcome]++;
    }
  }
  const decided = counts.merged + counts.rejected;
  return {
    ...counts,
    acceptanceRate: decided > 0 ? parseFloat((counts.merged / decided).toFixed(3)) : null,
  };
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig) {
  if (!siteConfig.github_repo) {
    console.log(`[outcome-tracker] No github_repo for ${siteConfig.name}, skipping.`);
    return { skipped: true };
  }

  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(siteConfig.github_repo);

  // Fetch all PRs (open + closed) with Cultivai branch prefix
  const allPrs = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state: 'all',
      per_page: 100,
      page,
    });

    const cultivaiPrs = data.filter((pr) =>
      pr.head && pr.head.ref && pr.head.ref.startsWith(PR_BRANCH_PREFIX)
    );

    allPrs.push(...cultivaiPrs);

    if (data.length < 100) break;
    page++;
  }

  const classified = allPrs.map((pr) => ({
    prNumber:   pr.number,
    prUrl:      pr.html_url,
    branch:     pr.head.ref,
    title:      pr.title,
    state:      pr.state,
    outcome:    classifyPr(pr),
    createdAt:  pr.created_at,
    mergedAt:   pr.merged_at  || null,
    closedAt:   pr.closed_at  || null,
  }));

  const today  = new Date().toISOString().slice(0, 10);
  const report = {
    site:    siteConfig.name,
    date:    today,
    summary: {
      total:    classified.length,
      merged:   classified.filter((p) => p.outcome === 'merged').length,
      rejected: classified.filter((p) => p.outcome === 'rejected').length,
      open:     classified.filter((p) => p.outcome === 'open').length,
    },
    prs: classified,
  };

  // Load + update history
  const historyPath = path.join(REPORTS_DIR, `${siteConfig.name}-outcome-history.json`);
  let history = [];
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch {}
  }

  // Upsert today's entry
  const existingIdx = history.findIndex((e) => e.date === today);
  if (existingIdx >= 0) {
    history[existingIdx] = report;
  } else {
    history.push(report);
  }

  // Keep last 90 days
  history = history.slice(-90);

  const stats = computeStats(history);
  report.lifetimeStats = stats;

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const outFile = path.join(REPORTS_DIR, `${siteConfig.name}-outcomes-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  console.log(
    `[outcome-tracker] ${siteConfig.name}: ` +
    `${report.summary.merged} merged, ` +
    `${report.summary.rejected} rejected, ` +
    `${report.summary.open} open | ` +
    `acceptance rate: ${stats.acceptanceRate !== null ? (stats.acceptanceRate * 100).toFixed(1) + '%' : 'n/a'} → ${outFile}`
  );

  return report;
}

module.exports = { run, classifyPr, computeStats };
