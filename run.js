'use strict';

// run.js - Cultivai Orchestrator
//
// Usage:
//   node run.js --site tradolux [--ads] [--dry-run]
//   node run.js --all [--ads] [--dry-run]
//   node run.js --outcomes
//
// Flags:
//   --site <name>   Run agents for a single site
//   --all           Run agents for all configured sites
//   --ads           Also run Google Ads, Meta Ads, and Bing Ads agents
//   --dry-run       Write improvements JSON to reports/ instead of creating a PR
//   --outcomes      Run the outcome tracker only

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const SITES_DIR   = path.join(__dirname, 'sites');
const TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes per agent

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--site':     flags.site     = args[++i]; break;
      case '--all':      flags.all      = true;       break;
      case '--ads':      flags.ads      = true;       break;
      case '--dry-run':  flags.dryRun   = true;       break;
      case '--outcomes': flags.outcomes = true;       break;
      default:
        console.warn(`Unknown flag: ${args[i]}`);
    }
  }

  return flags;
}

// ── Run a single agent with timeout + error isolation ─────────────────────────

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

// ── Run all agents for one site ───────────────────────────────────────────────

async function runSite(siteConfig, { ads, dryRun }) {
  console.log(`\n=== ${siteConfig.displayName || siteConfig.name} (${siteConfig.url}) ===`);

  const gscGap           = require('./agents/gsc-gap');
  const competitorMonitor = require('./agents/competitor-monitor');
  const serpIntent       = require('./agents/serp-intent');
  const improvGenerator  = require('./agents/improvement-generator');
  const prCreator        = require('./agents/pr-creator');

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
    console.warn(`  ${dataFailures.length} data agent(s) failed — proceeding with available data`);
  }

  // Phase 2: improvement generation (sequential — depends on data)
  const improvResult = await runAgent(
    'improvement-generator',
    () => improvGenerator.run(siteConfig),
    'improvement-generator'
  );

  if (improvResult.status === 'rejected') {
    console.error(`  Improvement generation failed — skipping PR for ${siteConfig.name}`);
    return { site: siteConfig.name, dataResults, improvResult, prResult: null };
  }

  // Phase 3: PR creation (sequential — depends on improvements)
  const prResult = await runAgent(
    'pr-creator',
    () => prCreator.run(siteConfig, { dryRun }),
    'pr-creator'
  );

  return { site: siteConfig.name, dataResults, improvResult, prResult };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);

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
    const dataFailed = sr.dataResults.filter((r) => r.status === 'rejected').length;
    const improvOk   = sr.improvResult && sr.improvResult.status === 'fulfilled';
    const prOk       = sr.prResult    && sr.prResult.status === 'fulfilled';

    console.log(
      `${sr.site}: data=${sr.dataResults.length - dataFailed}/${sr.dataResults.length} ok, ` +
      `improvement=${improvOk ? 'ok' : 'failed'}, ` +
      `pr=${prOk ? 'ok' : (flags.dryRun ? 'dry-run' : 'failed')}`
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
