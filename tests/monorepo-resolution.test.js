const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  FLOW_MANIFEST_PATH,
  loadFlows,
  resolveDefaultPath,
} = require('../build/flows');
const {writeArtifacts} = require('../build/report');

async function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    await callback();
  } finally {
    process.chdir(previous);
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-qa-monorepo-'));
  try {
    const child = path.join(root, 'landing');
    await fs.mkdir(path.join(root, '.layout'), {recursive: true});
    await fs.mkdir(child, {recursive: true});
    await fs.writeFile(
      path.join(root, FLOW_MANIFEST_PATH),
      JSON.stringify(
          {
            version: 1,
            apps: {
              app: {
                root: '.',
                start: 'npm run dev -- --port $PORT',
                flows: [
                  {
                    id: 'main_app_dashboard',
                    steps: [{screenshot: 'Dashboard'}],
                  },
                ],
              },
            },
          },
        null,
        2
      )
    );

    await withCwd(child, async () => {
      const childCwd = process.cwd();
      const manifestPath = await resolveDefaultPath(FLOW_MANIFEST_PATH);
      assert.equal(manifestPath, path.join(childCwd, FLOW_MANIFEST_PATH));

      const loaded = await loadFlows({flowsPath: '', scenario: 'happy_path'});
      assert.equal(loaded.manifestPath, path.join(childCwd, FLOW_MANIFEST_PATH));
      assert.equal(loaded.manifestFound, false);
      assert.equal(loaded.flows[0].id, 'target_smoke');

      await fs.mkdir(path.join(childCwd, '.layout'), {recursive: true});
      await fs.writeFile(
        path.join(childCwd, FLOW_MANIFEST_PATH),
        JSON.stringify(
          {
            version: 1,
            apps: {
              landing: {
                root: '.',
                start: 'npm run dev -- --port $PORT',
                flows: [
                  {
                    id: 'landing_page_smoke',
                    steps: [{screenshot: 'Landing'}],
                  },
                ],
              },
            },
          },
          null,
          2
        )
      );
      const childLoaded = await loadFlows({
        flowsPath: '',
        scenario: 'happy_path',
      });
      assert.equal(
        childLoaded.manifestPath,
        path.join(childCwd, FLOW_MANIFEST_PATH)
      );
      assert.equal(childLoaded.manifestFound, true);
      assert.equal(childLoaded.flows[0].id, 'landing_page_smoke');

      await fs.writeFile(
        path.join(childCwd, FLOW_MANIFEST_PATH),
        JSON.stringify(
          {
            version: 1,
            apps: {
              landing: {
                root: '.',
                start: 'npm run dev -- --port $PORT',
                flows: [
                  {
                    id: 'entry_path_stability',
                    steps: [
                      {visit: '/items/123'},
                      {type: 'reload', timeoutMs: 5000},
                      {
                        type: 'assert_stable_for',
                        timeoutMs: 1200,
                        expect: {
                          text: ['Item details'],
                          noText: ['Loading item'],
                        },
                      },
                      {type: 'assert_not_visible_text', text: 'Item unavailable'},
                    ],
                  },
                ],
              },
            },
          },
          null,
          2
        )
      );
      const stabilityLoaded = await loadFlows({
        flowsPath: '',
        scenario: 'happy_path',
      });
      const stabilitySteps = stabilityLoaded.flows[0].steps;
      assert.equal(stabilitySteps[1].type, 'reload');
      assert.equal(stabilitySteps[2].type, 'assert_stable_for');
      assert.deepEqual(stabilitySteps[2].expectText, ['Item details']);
      assert.deepEqual(stabilitySteps[2].expectNoText, ['Loading item']);
      assert.equal(stabilitySteps[3].type, 'assert_not_visible_text');

      const artifacts = await writeArtifacts({
        outDir: '',
        scenario: 'happy_path',
        targetUrl: 'http://127.0.0.1:5174/',
        manifestPath: loaded.manifestPath,
        manifestFound: loaded.manifestFound,
        result: {
          checks: [],
          issues: [],
          viewport: {id: 'desktop', width: 1440, height: 900},
        },
      });
      assert.equal(
        path.dirname(path.dirname(artifacts.runDir)),
        path.join(childCwd, '.layout')
      );
      const layoutGitignore = await fs.readFile(
        path.join(childCwd, '.layout', '.gitignore'),
        'utf8'
      );
      assert.match(layoutGitignore, /^runs\/$/m);
      assert.match(layoutGitignore, /^\*runs\/$/m);
      assert.match(layoutGitignore, /^manual-qa-\*\/$/m);

      const customArtifacts = await writeArtifacts({
        outDir: '.layout/landing-runs',
        scenario: 'happy_path',
        targetUrl: 'http://127.0.0.1:5174/',
        manifestPath: loaded.manifestPath,
        manifestFound: loaded.manifestFound,
        result: {
          checks: [],
          issues: [],
          viewport: {id: 'desktop', width: 1440, height: 900},
        },
      });
      assert.equal(
        path.dirname(path.dirname(customArtifacts.runDir)),
        path.join(childCwd, '.layout')
      );
    });
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
