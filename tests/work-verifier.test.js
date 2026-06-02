'use strict';

// work-verifier exports verifyFileImprovements — the pure logic function
// that checks whether proposed text is present in fetched file content.
// We test it by mocking the octokit call.

const { verifyFileImprovements } = require('../agents/work-verifier');

const IMPROVEMENTS = [
  {
    type:     'meta',
    file:     'src/pages/index.astro',
    selector: 'meta[name="description"]',
    current:  'Trading for everyone.',
    proposed: 'Institutional-grade trading signals for professional traders.',
    confidence: 0.88,
  },
  {
    type:     'heading',
    file:     'src/pages/index.astro',
    selector: 'h1',
    current:  'Our Platform',
    proposed: 'Real-Time AI Trading Signals',
    confidence: 0.82,
  },
];

function makeOctokit(contentMap) {
  return {
    repos: {
      getContent: async ({ path: filePath }) => {
        const text = contentMap[filePath];
        if (text === undefined) {
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
        }
        return {
          data: { content: Buffer.from(text).toString('base64') },
        };
      },
    },
  };
}

describe('verifyFileImprovements — all proposed text present', function () {
  it('returns verified=true for each improvement when proposed text is found', async function () {
    const fileContent =
      'Institutional-grade trading signals for professional traders.\n' +
      'Real-Time AI Trading Signals\n';
    const octokit = makeOctokit({ 'src/pages/index.astro': fileContent });
    const results = await verifyFileImprovements(octokit, 'owner', 'repo', 'src/pages/index.astro', IMPROVEMENTS, 'main');

    expect(results).toHaveLength(2);
    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(true);
  });
});

describe('verifyFileImprovements — some proposed text missing', function () {
  it('returns verified=false when proposed text is absent', async function () {
    const fileContent = 'Institutional-grade trading signals for professional traders.\n';
    const octokit = makeOctokit({ 'src/pages/index.astro': fileContent });
    const results = await verifyFileImprovements(octokit, 'owner', 'repo', 'src/pages/index.astro', IMPROVEMENTS, 'main');

    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(false);
    expect(results[1].reason).toMatch(/NOT found/);
  });
});

describe('verifyFileImprovements — file not found on ref', function () {
  it('marks all improvements as failed when file cannot be fetched', async function () {
    const octokit = makeOctokit({}); // no files
    const results = await verifyFileImprovements(octokit, 'owner', 'repo', 'src/pages/index.astro', IMPROVEMENTS, 'main');

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.verified === false)).toBe(true);
    expect(results[0].reason).toMatch(/Could not fetch/);
  });
});

describe('verifyFileImprovements — empty improvements list', function () {
  it('returns an empty array without fetching', async function () {
    const octokit = makeOctokit({ 'src/pages/index.astro': 'anything' });
    const results = await verifyFileImprovements(octokit, 'owner', 'repo', 'src/pages/index.astro', [], 'main');
    expect(results).toEqual([]);
  });
});

describe('verifyFileImprovements — result shape', function () {
  it('attaches the improvement object to each result', async function () {
    const fileContent = 'Institutional-grade trading signals for professional traders.\n';
    const octokit = makeOctokit({ 'src/pages/index.astro': fileContent });
    const results = await verifyFileImprovements(octokit, 'owner', 'repo', 'src/pages/index.astro', [IMPROVEMENTS[0]], 'main');

    expect(results[0]).toHaveProperty('improvement');
    expect(results[0].improvement).toMatchObject({ type: 'meta' });
    expect(results[0]).toHaveProperty('verified');
    expect(results[0]).toHaveProperty('reason');
  });
});
