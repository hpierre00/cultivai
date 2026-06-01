'use strict';

// agents/batch-vettor.js - Batch Vettor + Auto-Merger
//
// Runs between improvement-generator and pr-creator.
// Responsibilities:
//   1. CONTENT MISMATCH FIX — fetches actual file content from GitHub,
//      removes any improvement whose "current" value isn't found verbatim in the file
//   2. QUALITY VETTING — removes improvements with competitor brand names,
//      low confidence, missing required fields, or incoherent proposed values
//   3. AUTO-MERGE — after pr-creator creates the PR, this agent merges it
//      automatically if the vetted batch is clean
//
// Output:
//   reports/{site}-vetted-improvements-{date}.json  — cleaned improvements
//   reports/{site}-vetting-report-{date}.json       — what was removed and why
//
// Usage: called by run.js; also exported for testing

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getOctokit() {
  const token = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN / CULTIVAI_GITHUB_TOKEN');
  const { Octokit } = require('@octokit/rest');
  return new Octokit({ auth: token });
}

async function fetchFileContent(octokit, owner, repo, filePath, ref) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── Vetting rules ─────────────────────────────────────────────────────────────

// Competitor brand names that must never appear in proposed copy
const COMPETITOR_BRAND_PATTERNS = [
  /\bTradingView\b/i,
  /\bTrade[\s-]?Ideas\b/i,
  /\bBenzinga\b/i,
  /\bCoreLogic\b/i,
  /\bATTOM\b/i,
  /\bRedfin\b/i,
  /\bClio\b/i,
  /\bContractPodAi\b/i,
  /\bIronclad\b/i,
];

function hasCompetitorBrand(text) {
  return COMPETITOR_BRAND_PATTERNS.some((rx) => rx.test(text));
}

/**
 * Vet a single improvement against a set of rules.
 * Returns { pass: true } or { pass: false, reason: string }
 */
function vetImprovement(imp, fileContentMap, minConfidence) {
  const REQUIRED_FIELDS = ['type', 'file', 'selector', 'current', 'proposed', 'confidence', 'source_findings'];

  // 1. Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!imp[field] && imp[field] !== 0) {
      return { pass: false, reason: `missing required field: ${field}` };
    }
  }

  // 2. Confidence threshold
  if (typeof imp.confidence !== 'number' || imp.confidence < minConfidence) {
    return { pass: false, reason: `confidence ${imp.confidence} below threshold ${minConfidence}` };
  }

  // 3. current === proposed (no-op change)
  if (imp.current === imp.proposed) {
    return { pass: false, reason: 'current and proposed are identical — no-op change' };
  }

  // 4. Competitor brand names in proposed
  if (hasCompetitorBrand(imp.proposed)) {
    return { pass: false, reason: `proposed copy contains competitor brand name` };
  }

  // 5. Content mismatch — "current" must exist verbatim in the actual file
  if (fileContentMap && imp.file && fileContentMap[imp.file] !== undefined) {
    const fileContent = fileContentMap[imp.file];
    if (fileContent !== null && !fileContent.includes(imp.current)) {
      return {
        pass: false,
        reason: `content mismatch — "current" text not found verbatim in ${imp.file}`,
      };
    }
  }

  // 6. Proposed must not be empty
  if (!imp.proposed || !imp.proposed.trim()) {
    return { pass: false, reason: 'proposed value is empty' };
  }

  return { pass: true };
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run(siteConfig, { prResult = null } = {}) {
  const today    = new Date().toISOString().slice(0, 10);
  const impFile  = path.join(REPORTS_DIR, `${siteConfig.name}-improvements-${today}.json`);

  if (!fs.existsSync(impFile)) {
    console.log(`[batch-vettor] No improvements file for ${siteConfig.name} today — skipping.`);
    return { skipped: true };
  }

  const impData      = JSON.parse(fs.readFileSync(impFile, 'utf-8'));
  const improvements = impData.improvements || [];
  const minConf      = (siteConfig.improvement_limits && siteConfig.improvement_limits.min_confidence) || 0.7;

  // Fetch actual file content for every unique file referenced
  let fileContentMap = {};
  const token = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;

  if (token && siteConfig.github_repo) {
    const octokit  = await getOctokit();
    const [owner, repo] = siteConfig.github_repo.split('/');
    const branch   = siteConfig.github_branch || 'main';
    const uniqueFiles = [...new Set(improvements.map((i) => i.file).filter(Boolean))];

    for (const filePath of uniqueFiles) {
      const content = await fetchFileContent(octokit, owner, repo, filePath, branch);
      fileContentMap[filePath] = content;
      console.log(`[batch-vettor] Fetched ${filePath}: ${content ? content.length + ' chars' : 'NOT FOUND'}`);
    }
  } else {
    console.warn('[batch-vettor] No GitHub token — skipping content mismatch check');
  }

  // Vet every improvement
  const passed  = [];
  const removed = [];

  for (const imp of improvements) {
    const result = vetImprovement(imp, fileContentMap, minConf);
    if (result.pass) {
      passed.push(imp);
    } else {
      removed.push({ improvement: imp, reason: result.reason });
      console.warn(`[batch-vettor] REMOVED [${imp.type}] ${imp.file} — ${result.reason}`);
    }
  }

  console.log(`[batch-vettor] ${siteConfig.name}: ${passed.length} passed, ${removed.length} removed from batch of ${improvements.length}`);

  // Write vetted improvements (overwrite original so pr-creator uses the clean set)
  const vettedReport = { ...impData, improvements: passed, vetted: true, vettedAt: new Date().toISOString() };
  fs.writeFileSync(impFile, JSON.stringify(vettedReport, null, 2));

  // Write vetting audit log
  const vettingReport = {
    site:       siteConfig.name,
    date:       today,
    total:      improvements.length,
    passed:     passed.length,
    removed:    removed.length,
    removals:   removed,
    clean:      removed.length === 0,
  };

  const vettingFile = path.join(REPORTS_DIR, `${siteConfig.name}-vetting-report-${today}.json`);
  fs.writeFileSync(vettingFile, JSON.stringify(vettingReport, null, 2));

  // Auto-merge if a PR was created and the batch is clean (or became clean after vetting)
  let mergeResult = null;
  if (prResult && prResult.prNumber && token && siteConfig.github_repo && passed.length > 0) {
    mergeResult = await autoMerge(siteConfig, prResult, vettingReport);
  } else if (prResult && prResult.prNumber && passed.length === 0) {
    console.log(`[batch-vettor] All improvements removed — not merging PR #${prResult.prNumber} (empty batch)`);
  }

  return { ...vettingReport, mergeResult };
}

// ── Auto-merge ────────────────────────────────────────────────────────────────

async function autoMerge(siteConfig, prResult, vettingReport) {
  const [owner, repo] = siteConfig.github_repo.split('/');
  const prNumber      = prResult.prNumber;

  console.log(`[batch-vettor] Auto-merging ${owner}/${repo} PR #${prNumber}...`);

  const token   = process.env.GITHUB_TOKEN || process.env.CULTIVAI_GITHUB_TOKEN;
  const octokit = await getOctokit();

  // Check PR is still open before merging
  try {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    if (pr.state !== 'open') {
      console.log(`[batch-vettor] PR #${prNumber} is already ${pr.state} — skipping merge`);
      return { skipped: true, reason: `pr_already_${pr.state}` };
    }
  } catch (err) {
    console.warn(`[batch-vettor] Could not fetch PR #${prNumber}: ${err.message}`);
    return { skipped: true, reason: err.message };
  }

  const removedCount = vettingReport.removed;
  const passedCount  = vettingReport.passed;
  const cleanNote    = removedCount > 0
    ? ` (${removedCount} improvement${removedCount !== 1 ? 's' : ''} removed by batch-vettor before merge)`
    : ' (batch fully clean — no removals)';

  try {
    const { data } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      commit_title:   `[Cultivai] ${siteConfig.displayName || siteConfig.name} — auto-merged ${passedCount} clean improvement${passedCount !== 1 ? 's' : ''}`,
      commit_message: `Auto-merged by batch-vettor after vetting.${cleanNote}\n\nVetting report: ${passedCount} passed, ${removedCount} removed.`,
      merge_method:   'squash',
    });

    console.log(`[batch-vettor] Merged PR #${prNumber}: ${data.sha}`);
    return { merged: true, sha: data.sha, prNumber };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.error(`[batch-vettor] Merge failed for PR #${prNumber}: ${detail}`);
    return { merged: false, error: detail };
  }
}

module.exports = {
  run,
  vetImprovement,
  hasCompetitorBrand,
  autoMerge,
};
