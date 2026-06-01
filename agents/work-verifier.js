'use strict';

// agents/work-verifier.js - Work Verifier
//
// Runs after pr-creator (and after auto-merge by batch-vettor).
// Confirms that every improvement that was supposed to apply is actually
// present in the repo file on main.
//
// Checks:
//   1. For each passed improvement, fetch the file from main and confirm
//      `proposed` text is present (proves the edit was committed and merged)
//   2. Confirm the PR is in state `merged` (not open or closed-unmerged)
//   3. Flag any improvement where the proposed text is NOT found (partial apply)
//
// Output:
//   reports/{site}-verification-{date}.json
//
// Returns a structured result so the run summary can show verified/failed counts.

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

async function getOctokit() {
  const token = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN / CULTIVAI_GITHUB_TOKEN');
  const { Octokit } = require('@octokit/rest');
  return new Octokit({ auth: token });
}

// ── Verify a single file's improvements on main ───────────────────────────────

async function verifyFileImprovements(octokit, owner, repo, filePath, improvements, ref) {
  let content;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref });
    content = Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    return improvements.map((imp) => ({
      improvement: imp,
      verified:    false,
      reason:      `Could not fetch ${filePath} from ${ref}: ${err.message}`,
    }));
  }

  return improvements.map((imp) => {
    const found = content.includes(imp.proposed);
    return {
      improvement: imp,
      verified:    found,
      reason:      found ? 'proposed text found in file' : `proposed text NOT found in ${filePath} on ${ref}`,
    };
  });
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig, { prResult = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  // Load the vetted improvements (batch-vettor overwrites the improvements file)
  const impFile = path.join(REPORTS_DIR, `${siteConfig.name}-improvements-${today}.json`);
  if (!fs.existsSync(impFile)) {
    console.log(`[work-verifier] No improvements file for ${siteConfig.name} — skipping.`);
    return { skipped: true };
  }

  const impData      = JSON.parse(fs.readFileSync(impFile, 'utf-8'));
  const improvements = impData.improvements || [];

  if (improvements.length === 0) {
    console.log(`[work-verifier] No improvements to verify for ${siteConfig.name}.`);
    return { verified: 0, failed: 0, skipped: true, reason: 'no_improvements' };
  }

  if (!prResult || !prResult.prNumber) {
    console.log(`[work-verifier] No PR result for ${siteConfig.name} — cannot verify merge.`);
    return { skipped: true, reason: 'no_pr_result' };
  }

  const token = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;
  if (!token || !siteConfig.github_repo) {
    console.warn('[work-verifier] No GitHub token or repo — skipping verification.');
    return { skipped: true, reason: 'no_github_config' };
  }

  const octokit       = await getOctokit();
  const [owner, repo] = siteConfig.github_repo.split('/');
  const baseBranch    = siteConfig.github_branch || 'main';

  // 1. Check PR merge status
  let prMerged = false;
  let prState  = 'unknown';
  try {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prResult.prNumber });
    prState  = pr.state;
    prMerged = pr.merged;
    console.log(`[work-verifier] PR #${prResult.prNumber} state=${pr.state}, merged=${pr.merged}`);
  } catch (err) {
    console.warn(`[work-verifier] Could not check PR #${prResult.prNumber}: ${err.message}`);
  }

  // 2. Verify each improvement's proposed text is in the base branch
  // Group improvements by file
  const byFile = {};
  for (const imp of improvements) {
    if (!imp.file) continue;
    if (!byFile[imp.file]) byFile[imp.file] = [];
    byFile[imp.file].push(imp);
  }

  const allResults = [];
  for (const [filePath, fileImps] of Object.entries(byFile)) {
    const results = await verifyFileImprovements(octokit, owner, repo, filePath, fileImps, baseBranch);
    allResults.push(...results);
  }

  const verified = allResults.filter((r) => r.verified);
  const failed   = allResults.filter((r) => !r.verified);

  // Log
  if (failed.length > 0) {
    console.error(`[work-verifier] ${siteConfig.name}: ${failed.length} improvement(s) NOT confirmed in ${baseBranch}:`);
    for (const f of failed) {
      console.error(`  - [${f.improvement.type}] ${f.improvement.file} — ${f.reason}`);
    }
  }
  console.log(`[work-verifier] ${siteConfig.name}: ${verified.length}/${allResults.length} improvements verified on ${baseBranch}`);

  const report = {
    site:       siteConfig.name,
    date:       today,
    prNumber:   prResult.prNumber,
    prUrl:      prResult.prUrl,
    prMerged,
    prState,
    total:      allResults.length,
    verified:   verified.length,
    failed:     failed.length,
    allClean:   failed.length === 0 && prMerged,
    results:    allResults,
    verifiedAt: new Date().toISOString(),
  };

  const outFile = path.join(REPORTS_DIR, `${siteConfig.name}-verification-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  return report;
}

module.exports = { run, verifyFileImprovements };
