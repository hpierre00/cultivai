'use strict';

// run.js - Cultivai Orchestrator
//
// Usage:
//   node run.js --site tradolux [--ads] [--dry-run]
//   node run.js --all [--ads] [--dry-run]
//   node run.js --outcomes
//   node run.js --weekly
//
// Flags:
//   --site <name>   Run agents for a single site
//   --all           Run agents for all configured sites
//   --ads           Also run Google Ads, Meta Ads, and Bing Ads agents
//   --dry-run       Write improvements JSON to reports/ instead of creating a PR
//   --outcomes      Run the outcome tracker only
//   --weekly        Generate the weekly progress report and HTML dashboard

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const SITES_DIR   = path.join(__dirname, 'sites');
const TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes per agent

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function loadSiteConfig(name) {
  const filePath = path.join(SITES_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Site config not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadAllSiteConfigs() {
  return fs.readdirSync(SITES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadSiteConfig(path.basename(f, '.json')));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    site:     null,
    all:      false,
    ads:      false,
    dryRun:   false,
    outcomes: false,
    weekly:   false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--site':     flags.site     = args[++i]; break;
      case '--all':      flags.all      = true;       break;
      case '--ads':      flags.ads      = true;       break;
      case '--dry-run':  flags.dryRun   = true;       break;
      case '--outcomes': flags.outcomes = true;       break;
      case '--weekly':   flags.weekly   = true;       break;
      default:
        console.warn(`Unknown flag: ${args[i]}`);
    }
  }

  return flags;
}

// ââ Run a single agent with timeout + error isolation âââââââââââââââââââââââââ

async function runAgent(name, fn, label) {
  console.log(`  [${label}] Starting...`);
  try {
    const result = await withTimeout(fn(), TIMEOUT_MS, label);
    console.log(`  [${label}] Done.`);
    return { agent: name, status: 'fulfilled', result };
  } catch (err) {
    console.error(`  [${label}] Failed: ${err.message}`);
    return { agent: name, status: 'rejected', reason: err.message };
  }
}

// ââ Run all agents for one site âââââââââââââââââââââââââââââââââââââââââââââââ

async function runSite(siteConfig, { ads, dryRun }) {
  console.log(`\n=== ${siteConfig.displayName || siteConfig.name} (${siteConfig.url}) ===`);

  const gscGap           = require('./agents/gsc-gap');
  const competitorMonitor = require('./agents/competitor-monitor');
  const serpIntent       = require('./agents/serp-intent');
  const improvGenerator  = require('./agents/improvement-generator');
  const batchVettor      = require('./agents/batch-vettor');
  const prCreator        = require('./agents/pr-creator');
  const workVerifier     = require('./agents/work-verifier');

  // Phase 1: data collection agents (run in parallel)
  const dataAgents = [
    runAgent('gsc-gap',            () => gscGap.run(siteConfig),            'gsc-gap'),
    runAgent('competitor-monitor', () => competitorMonitor.run(siteConfig), 'competitor-monitor'),
    runAgent('serp-intent',        () => serpIntent.run(siteConfig),        'serp-intent'),
  ];

  if (ads) {
    const googleAds = require('./agents/google-ads');
    const metaAds   = require('./agents/meta-ads');
    const bingAds   = require('./agents/bing-ads');

    dataAgents.push(
      runAgent('google-ads', () => googleAds.run(siteConfig), 'google-ads'),
      runAgent('meta-ads',   () => metaAds.run(siteConfig),   'meta-ads'),
      runAgent('bing-ads',   () => bingAds.run(siteConfig),   'bing-ads')
    );
  }

  const dataResults = await Promise.all(dataAgents);

  const dataFailures = dataResults.filter((r) => r.status === 'rejected');
  if (dataFailures.length > 0) {
    console.warn(`  ${dataFailures.length} data agent(s) failed â proceeding with available data`);
  }

  // Phase 2: improvement generation (sequential â depends on data)
  const improvResult = await runAgent(
    'improvement-generator',
    () => improvGenerator.run(siteConfig),
    'improvement-generator'
  );

  if (improvResult.status === 'rejected') {
    console.error(`  Improvement generation failed â skipping PR for ${siteConfig.name}`);
    return { site: siteConfig.name, dataResults, improvResult, prResult: null, vettingResult: null, verifyResult: null };
  }

  // Phase 2b: batch vetting â fix content mismatches and filter bad improvements
  const vettingResult = await runAgent(
    'batch-vettor',
    () => batchVettor.run(siteConfig),
    'batch-vettor'
  );

  if (vettingResult.status === 'fulfilled' && vettingResult.result && vettingResult.result.passed === 0) {
    console.warn(`  [batch-vettor] All improvements removed after vetting â skipping PR for ${siteConfig.name}`);
    return { site: siteConfig.name, dataResults, improvResult, vettingResult, prResult: null, verifyResult: null };
  }

  // Phase 3: PR creation (sequential â depends on vetted improvements)
  const prResult = await runAgent(
    'pr-creator',
    () => prCreator.run(siteConfig, { dryRun }),
    'pr-creator'
  );

  // Phase 3b: auto-merge if batch is clean and PR was created
  if (!dryRun && prResult.status === 'fulfilled' && prResult.result && prResult.result.prNumber) {
    await runAgent(
      'batch-vettor-merge',
      () => batchVettor.autoMerge(
        siteConfig,
        prResult.result,
        vettingResult.status === 'fulfilled' ? vettingResult.result : { passed: 0, removed: 0 }
      ),
      'batch-vettor/auto-merge'
    );
  }

  // Phase 4: verify that improvements landed in the repo after merge
  let verifyResult = null;
  if (!dryRun && prResult.status === 'fulfilled' && prResult.result && prResult.result.prNumber) {
    verifyResult = await runAgent(
      'work-verifier',
      () => workVerifier.run(siteConfig, { prResult: prResult.result }),
      'work-verifier'
    );
  }

  return { site: siteConfig.name, dataResults, improvResult, vettingResult, prResult, verifyResult };
}

// ââ Main entry point ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function main() {
  const flags = parseArgs(process.argv);

  // Weekly reporter mode
  if (flags.weekly) {
    console.log('Generating weekly progress report...');
    const weeklyReporter = require('./agents/weekly-reporter');
    const configs = loadAllSiteConfigs();
    const report = await weeklyReporter.run(configs);
    console.log(`\nOverall health: ${report.summary.overallHealth}`);
    console.log(`PRs merged: ${report.summary.totalPrsMerged}, improvements applied: ${report.summary.totalImprovementsApplied}, verified: ${report.summary.totalVerified}`);
    return;
  }

  // Outcome tracker mode
  if (flags.outcomes) {
    console.log('Running outcome tracker...');
    const outcomeTracker = require('./agents/outcome-tracker');
    const configs = loadAllSiteConfigs();
    for (const config of configs) {
      await outcomeTracker.run(config).catch((err) => {
        console.error(`[outcome-tracker] ${config.name}: ${err.message}`);
      });
    }
    console.log('Outcome tracking complete.');
    return;
  }

  if (!flags.site && !flags.all) {
    console.error('Usage: node run.js --site <name> | --all [--ads] [--dry-run]');
    process.exit(1);
  }

  const configs = flags.all
    ? loadAllSiteConfigs()
    : [loadSiteConfig(flags.site)];

  console.log(`Cultivai run: ${configs.map((c) => c.name).join(', ')} | ads=${flags.ads} | dry-run=${flags.dryRun}`);

  const siteResults = [];
  for (const config of configs) {
    const result = await runSite(config, { ads: flags.ads, dryRun: flags.dryRun });
    siteResults.push(result);
  }

  // Summary
  console.log('\n=== Run Summary ===');
  for (const sr of siteResults) {
    const dataFailed  = sr.dataResults.filter((r) => r.status === 'rejected').length;
    const improvOk    = sr.improvResult  && sr.improvResult.status  === 'fulfilled';
    const vettingOk   = sr.vettingResult && sr.vettingResult.status === 'fulfilled';
    const prOk        = sr.prResult      && sr.prResult.status      === 'fulfilled';
    const verifyOk    = sr.verifyResult  && sr.verifyResult.status  === 'fulfilled';

    const vettingTag  = vettingOk
      ? `vetted(${sr.vettingResult.result.passed}/${sr.vettingResult.result.total} passed)`
      : (sr.vettingResult ? 'vet-failed' : 'no-vet');

    const verifyTag   = flags.dryRun ? 'dry-run' : (verifyOk ? `verified(${sr.verifyResult.result.verified}/${sr.verifyResult.result.total})` : 'not-verified');

    console.log(
      `${sr.site}: data=${sr.dataResults.length - dataFailed}/${sr.dataResults.length} ok | ` +
      `improvement=${improvOk ? 'ok' : 'failed'} | ` +
      `${vettingTag} | ` +
      `pr=${prOk ? (sr.prResult.result.prNumber ? `#${sr.prResult.result.prNumber}` : 'ok') : (flags.dryRun ? 'dry-run' : 'failed')} | ` +
      `verify=${verifyTag}`
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
