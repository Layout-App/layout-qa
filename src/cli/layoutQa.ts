#!/usr/bin/env node

import {spawn, type ChildProcess} from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import {request as httpRequest} from 'http';
import {request as httpsRequest} from 'https';
import {URL} from 'url';
import {
  FLOW_MANIFEST_PATH,
  getTestTimeoutMs,
  loadFlows,
  resolveDefaultPath,
  starterFlowManifest,
} from '../flows';
import {
  loadQaMockApiConfig,
  startQaMockApiServer,
  starterMockScenarios,
} from '../mockApi';
import {buildRunnerErrorResult, isQaRunPassed, runLayoutQaBrowser} from '../runner';
import {openReport, writeArtifacts} from '../report';
import {
  ArtifactSummary,
  LoadedQaFlow,
  QaTestRunFlowResult,
  QaTestRunResult,
  QaViewport,
} from '../types';
import {formatViewport, parseViewport} from '../viewports';

type CliOptions = {
  command: string;
  intentText: string;
  flowNames: string[];
  targetUrl: string;
  scenario: string;
  flowsPath: string;
  mockRoot: string;
  port?: number;
  outDir: string;
  apiUrl: string;
  apiKey: string;
  uploadUrl: string;
  repo: string;
  branch: string;
  commitSha: string;
  prNumber: string;
  runId: string;
  runSource: 'local' | 'github_actions';
  mode: 'scripted' | 'exploratory';
  intent: string;
  workflowId: string;
  viewport: QaViewport;
  timeoutMs?: number;
  headed: boolean;
  startApp: boolean;
  serveMocks: boolean;
  skipInstall: boolean;
  json: boolean;
  open: boolean;
  force: boolean;
  help: boolean;
};

function printHelp() {
  process.stdout.write(`Layout QA CLI

Usage:
  trylayout init [options]
  trylayout test "intent" --repo <owner/repo> --ref <branch> [options]
  trylayout check [flow_id ...] [options]
  trylayout mock-api [options]
  trylayout run --target-url <url> [options]
  trylayout remote run --repo <owner/repo> --ref <branch> [options]
  layout-qa test "intent" --repo <owner/repo> --ref <branch> [options]
  layout-qa check [flow_id ...] [options]
  layout-qa mock-api [options]
  layout-qa run --target-url <url> [options]
  npx @trylayout/qa test "intent" --repo <owner/repo> --ref <branch> [options]
  npx @trylayout/qa check [flow_id ...] [options]
  npx @trylayout/qa mock-api [options]
  npx @trylayout/qa run --target-url <url> [options]
  npx @trylayout/qa remote run --repo <owner/repo> --ref <branch> [options]
  npx layout-qa run --target-url <url> [options]

Commands:
  init                  Write a starter .layout/qa.json.
  test                  Ask Layout to run AI browser QA remotely.
  check                 Run local/CI scripted manifest checks.
  mock-api              Start a Layout mock API server from .layout/mocks.
  run                   Run browser QA and write a local HTML report.
  remote run            Ask Layout to run browser QA against a repo/ref.

Options:
  --target-url <url>     URL of the running frontend to test.
  --scenario <name>      Scenario to activate. Defaults to happy_path.
  --flows <path>         Flow manifest path. Defaults to .layout/qa.json.
  --mock-root <path>     Mock API root. Defaults from .layout/qa.json mockApi.root.
  --port <number>        Port for mock-api. Defaults to an available local port.
  --out <path>           Artifact directory. Defaults to .layout/runs.
  --viewport <value>     Viewport preset or size. Use desktop, tablet, mobile, or WIDTHxHEIGHT. Defaults to desktop.
  --timeout <ms>         Browser run timeout. Defaults to LAYOUT_QA_TEST_TIMEOUT_MS or 60000.
  --headed               Show the browser instead of running headless.
  --open                 Open the generated local HTML report after the run.
  --json                 Print machine-readable JSON.
  --api-url <url>        Layout API base URL. Defaults to https://api.trylayout.com/v1/qa.
  --api-key <key>        Layout organization API key for uploads and remote runs.
  --upload-url <url>     Upload completed run JSON/screenshots to Layout.
  --repo <name>          Repository full name, e.g. owner/repo.
  --branch <name>        Branch name for report metadata.
  --ref <name>           Branch/ref for a remote run. Defaults to --branch.
  --commit-sha <sha>     Commit SHA for report metadata.
  --pr-number <number>   Pull request number for report metadata.
  --run-id <id>          Existing Layout run id to update after workflow_dispatch.
  --run-source <value>   local or github_actions. Defaults from environment.
  --mode <value>         scripted or ai. Defaults to ai for remote run.
  --intent <text>        Natural-language intent for AI testing remote runs.
  --workflow-id <file>   Workflow id metadata. Defaults to layout-verify.yml.
  --start-app            Start the app from .layout/qa.json before local checks.
  --serve-mocks          Start mock API before local checks. Automatic with --start-app.
  --skip-install         With --start-app, skip app.install.
  --force                Overwrite an existing flow file during init.
  --help                 Show this help.
`);
}

function readFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  return args[index + 1] || '';
}

function hasFlag(args: string[], name: string) {
  return args.includes(name);
}

function envValue(name: string) {
  return process.env[name] || '';
}

const VALUE_FLAGS = new Set([
  '--target-url',
  '--scenario',
  '--flows',
  '--mock-root',
  '--port',
  '--out',
  '--viewport',
  '--timeout',
  '--api-url',
  '--api-key',
  '--upload-url',
  '--repo',
  '--branch',
  '--ref',
  '--commit-sha',
  '--pr-number',
  '--run-id',
  '--run-source',
  '--mode',
  '--intent',
  '--workflow-id',
]);

function positionalArgs(args: string[], startIndex: number) {
  const positional: string[] = [];
  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

async function githubEventPullRequestNumber() {
  const eventPath = envValue('GITHUB_EVENT_PATH');
  if (!eventPath) return '';
  const content = await fs.readFile(eventPath, 'utf8').catch(() => '');
  if (!content) return '';
  const event = JSON.parse(content) as {pull_request?: {number?: number}};
  return event.pull_request?.number ? String(event.pull_request.number) : '';
}

function inferGithubPrNumber() {
  const ref = envValue('GITHUB_REF');
  const match = ref.match(/^refs\/pull\/(\d+)\//);
  return match?.[1] || '';
}

function inferBranch() {
  return envValue('GITHUB_HEAD_REF') || envValue('GITHUB_REF_NAME');
}

function parseArgs(args: string[]): CliOptions {
  const firstCommand = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const command =
    firstCommand === 'remote' && args[1] === 'run' ? 'remote-run' : firstCommand;
  const positional = positionalArgs(args, command === 'remote-run' ? 2 : 1);
  const timeoutValue = readFlag(args, '--timeout');
  const parsedTimeoutMs = timeoutValue ? Number(timeoutValue) : undefined;
  const portValue = readFlag(args, '--port');
  const parsedPort = portValue ? Number(portValue) : undefined;
  const rawRunSource =
    readFlag(args, '--run-source') ||
    envValue('LAYOUT_RUN_SOURCE') ||
    (envValue('GITHUB_ACTIONS') === 'true' ? 'github_actions' : 'local');

  if (
    timeoutValue &&
    (!Number.isFinite(parsedTimeoutMs) || Number(parsedTimeoutMs) <= 0)
  ) {
    throw new Error('--timeout must be a positive number of milliseconds.');
  }
  if (portValue && (!Number.isInteger(parsedPort) || Number(parsedPort) <= 0)) {
    throw new Error('--port must be a positive integer.');
  }

  return {
    command,
    intentText:
      command === 'test'
        ? readFlag(args, '--intent') || positional[0] || envValue('LAYOUT_INTENT')
        : readFlag(args, '--intent') || envValue('LAYOUT_INTENT'),
    flowNames: command === 'check' ? positional : [],
    targetUrl: readFlag(args, '--target-url'),
    scenario: readFlag(args, '--scenario') || 'happy_path',
    flowsPath: readFlag(args, '--flows'),
    mockRoot: readFlag(args, '--mock-root'),
    port: parsedPort,
    outDir: readFlag(args, '--out'),
    apiUrl:
      readFlag(args, '--api-url') ||
      envValue('LAYOUT_API_URL') ||
      'https://api.trylayout.com/v1/qa',
    apiKey:
      readFlag(args, '--api-key') ||
      envValue('LAYOUT_API_KEY'),
    uploadUrl: readFlag(args, '--upload-url') || envValue('LAYOUT_UPLOAD_URL'),
    repo:
      readFlag(args, '--repo') ||
      envValue('LAYOUT_REPOSITORY') ||
      envValue('GITHUB_REPOSITORY'),
    branch:
      readFlag(args, '--ref') ||
      readFlag(args, '--branch') ||
      envValue('LAYOUT_REF') ||
      envValue('LAYOUT_BRANCH') ||
      inferBranch(),
    commitSha:
      readFlag(args, '--commit-sha') ||
      envValue('LAYOUT_COMMIT_SHA') ||
      envValue('GITHUB_SHA'),
    prNumber:
      readFlag(args, '--pr-number') ||
      envValue('LAYOUT_PR_NUMBER') ||
      inferGithubPrNumber(),
    runId: readFlag(args, '--run-id') || envValue('LAYOUT_RUN_ID'),
    runSource: rawRunSource === 'github_actions' ? 'github_actions' : 'local',
    mode:
      command === 'test'
        ? 'exploratory'
        : /^(scripted|checks?)$/i.test(readFlag(args, '--mode'))
          ? 'scripted'
          : 'exploratory',
    intent: readFlag(args, '--intent') || envValue('LAYOUT_INTENT'),
    workflowId:
      readFlag(args, '--workflow-id') ||
      envValue('LAYOUT_WORKFLOW_ID') ||
      'layout-verify.yml',
    viewport: parseViewport(readFlag(args, '--viewport')),
    timeoutMs: parsedTimeoutMs,
    headed: hasFlag(args, '--headed'),
    startApp: hasFlag(args, '--start-app'),
    serveMocks: hasFlag(args, '--serve-mocks'),
    skipInstall: hasFlag(args, '--skip-install'),
    json: hasFlag(args, '--json'),
    open: hasFlag(args, '--open'),
    force: hasFlag(args, '--force'),
    help: hasFlag(args, '--help') || command === 'help',
  };
}

async function exists(filePath: string) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

type AppConfig = {
  root: string;
  install?: string;
  start: string;
  healthUrl?: string;
  env: Record<string, string>;
};

type LocalCheckSession = {
  targetUrl: string;
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    })
  );
}

function repoRootFromManifest(manifestPath: string) {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  return path.basename(manifestDir) === '.layout'
    ? path.dirname(manifestDir)
    : manifestDir;
}

async function loadAppConfig(manifestPath: string) {
  const content = await fs.readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  if (!content) return null;

  const manifest = JSON.parse(content) as Record<string, unknown>;
  if (!isRecord(manifest.app)) return null;

  const app = manifest.app;
  const start = typeof app.start === 'string' ? app.start.trim() : '';
  if (!start) return null;

  return {
    root: typeof app.root === 'string' && app.root.trim() ? app.root.trim() : '.',
    install:
      typeof app.install === 'string' && app.install.trim()
        ? app.install.trim()
        : undefined,
    start,
    healthUrl:
      typeof app.healthUrl === 'string' && app.healthUrl.trim()
        ? app.healthUrl.trim()
        : undefined,
    env: stringRecord(app.env),
  } satisfies AppConfig;
}

function expandVariables(value: string, variables: Record<string, string>) {
  return Object.entries(variables).reduce(
    (expanded, [key, variableValue]) =>
      expanded.split(`$${key}`).join(variableValue),
    value
  );
}

function expandEnv(
  env: Record<string, string>,
  variables: Record<string, string>
) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, expandVariables(value, variables)])
  );
}

function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate port.')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  silent?: boolean;
}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: input.env,
      shell: true,
      stdio: input.silent ? 'ignore' : 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code ?? 'signal'}): ${input.command}`));
    });
  });
}

function requestOk(url: string) {
  return new Promise<boolean>(resolve => {
    const target = new URL(url);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: 2500,
      },
      response => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode < 500));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForUrl(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await requestOk(url)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for app health URL: ${url}`);
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startLocalCheckSession(input: {
  options: CliOptions;
  manifestPath: string;
}) {
  let mockServer:
    | Awaited<ReturnType<typeof startQaMockApiServer>>
    | undefined;
  let appProcess: ChildProcess | undefined;

  const close = async () => {
    await stopChild(appProcess);
    await mockServer?.close().catch(() => {
      // Best-effort shutdown.
    });
  };

  const shouldStartMocks = input.options.serveMocks || input.options.startApp;
  const mockConfig = shouldStartMocks
    ? await loadQaMockApiConfig({
        manifestPath: input.manifestPath,
        scenario: input.options.scenario,
      })
    : null;

  if (mockConfig) {
    mockServer = await startQaMockApiServer({
      root: mockConfig.root,
      scenario: input.options.scenario || mockConfig.defaultScenario,
      port: input.options.port,
    });
    if (!input.options.json) {
      process.stdout.write(`Layout mock API listening at ${mockServer.url}\n`);
    }
  } else if (input.options.serveMocks) {
    throw new Error(
      'No mock API root found. Add mockApi.root to .layout/qa.json or omit --serve-mocks.'
    );
  }

  if (!input.options.startApp) {
    if (!input.options.targetUrl) {
      await close();
      throw new Error('--target-url is required unless --start-app is set.');
    }
    return {
      targetUrl: input.options.targetUrl,
      close,
    } satisfies LocalCheckSession;
  }

  const app = await loadAppConfig(input.manifestPath);
  if (!app) {
    await close();
    throw new Error(
      '--start-app requires an app.start block in .layout/qa.json.'
    );
  }

  const port = await getAvailablePort();
  const variables = {
    PORT: String(port),
    LAYOUT_MOCK_API_URL:
      mockServer?.url || process.env.LAYOUT_MOCK_API_URL || '',
  };
  const appEnv = expandEnv(app.env, variables);
  const missingMockUrl = Object.values(app.env).some(value =>
    value.includes('$LAYOUT_MOCK_API_URL')
  );
  if (missingMockUrl && !variables.LAYOUT_MOCK_API_URL) {
    await close();
    throw new Error(
      'app.env references $LAYOUT_MOCK_API_URL, but no mock API server is configured.'
    );
  }

  const appRoot = path.resolve(repoRootFromManifest(input.manifestPath), app.root);
  const env = {
    ...process.env,
    ...appEnv,
    PORT: String(port),
    LAYOUT_MOCK_API_URL: variables.LAYOUT_MOCK_API_URL,
  };

  if (app.install && !input.options.skipInstall) {
    await runShellCommand({
      command: app.install,
      cwd: appRoot,
      env,
      silent: input.options.json,
    });
  }

  const startCommand = expandVariables(app.start, variables);
  const healthUrl = expandVariables(
    app.healthUrl || `http://127.0.0.1:${port}/`,
    variables
  );
  appProcess = spawn(startCommand, {
    cwd: appRoot,
    env,
    shell: true,
    stdio: input.options.json ? 'ignore' : 'inherit',
  });
  appProcess.on('error', error => {
    process.stderr.write(`Layout app start failed: ${error.message}\n`);
  });

  await waitForUrl(healthUrl, input.options.timeoutMs || getTestTimeoutMs());

  return {
    targetUrl: new URL(healthUrl).origin,
    close,
  } satisfies LocalCheckSession;
}

async function initCommand(options: CliOptions) {
  const manifestPath = options.flowsPath
    ? path.resolve(process.cwd(), options.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);

  if ((await exists(manifestPath)) && !options.force) {
    throw new Error(
      `${manifestPath} already exists. Use --force to overwrite it.`
    );
  }

  await fs.mkdir(path.dirname(manifestPath), {recursive: true});
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(starterFlowManifest(), null, 2)}\n`
  );
  const layoutDir = path.dirname(manifestPath);
  const layoutGitignorePath = path.join(layoutDir, '.gitignore');
  if ((await exists(layoutGitignorePath)) && !options.force) {
    // Preserve existing user ignore rules.
  } else {
    await fs.writeFile(
      layoutGitignorePath,
      [
        '# Generated Layout QA reports can be recreated.',
        'runs/',
        '',
      ].join('\n')
    );
  }
  const mockRoot = path.resolve(
    path.dirname(path.dirname(manifestPath)),
    '.layout',
    'mocks',
    'scenarios'
  );
  await fs.mkdir(mockRoot, {recursive: true});
  const scenarios = starterMockScenarios();
  for (const [scenario, routes] of Object.entries(scenarios)) {
    const scenarioPath = path.join(mockRoot, `${scenario}.json`);
    if ((await exists(scenarioPath)) && !options.force) continue;
    await fs.writeFile(scenarioPath, `${JSON.stringify(routes, null, 2)}\n`);
  }
  process.stdout.write(`Created ${manifestPath}\n`);
  process.stdout.write(`Created starter mock API scenarios in ${mockRoot}\n`);
}

async function mockApiCommand(options: CliOptions) {
  const manifestPath = options.flowsPath
    ? path.resolve(process.cwd(), options.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);
  const manifestConfig = await loadQaMockApiConfig({
    manifestPath,
    scenario: options.scenario,
  });
  const root = options.mockRoot
    ? path.resolve(process.cwd(), options.mockRoot)
    : manifestConfig?.root;

  if (!root) {
    throw new Error(
      'No mock API root found. Add mockApi.root to .layout/qa.json or pass --mock-root.'
    );
  }

  const server = await startQaMockApiServer({
    root,
    scenario: options.scenario || manifestConfig?.defaultScenario,
    port: options.port,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          url: server.url,
          port: server.port,
          scenario: server.scenario,
          root: server.root,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(`Layout mock API listening at ${server.url}\n`);
    process.stdout.write(`LAYOUT_MOCK_API_URL=${server.url}\n`);
    process.stdout.write(`Scenario: ${server.scenario}\n`);
    process.stdout.write(`Root: ${server.root}\n`);
  }

  const close = async () => {
    await server.close().catch(() => {
      // Best-effort shutdown.
    });
  };
  process.once('SIGINT', () => {
    close().finally(() => {
      process.exit(0);
    });
  });
  process.once('SIGTERM', () => {
    close().finally(() => {
      process.exit(0);
    });
  });

  await new Promise(() => {
    // Keep the mock API process alive until it receives a termination signal.
  });
}

function statusIcon(passed: boolean) {
  return passed ? 'PASS' : 'FAIL';
}

function formatDurationMs(value: unknown) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return 'unavailable';
  if (duration < 1000) return `${Math.round(duration)}ms`;

  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function printHumanSummary(input: {
  result: QaTestRunResult;
  scenario: string;
  targetUrl: string;
  manifestPath: string;
  manifestFound: boolean;
  artifacts: ArtifactSummary;
}) {
  const passed = isQaRunPassed(input.result);
  const flows = resultFlows(input.result);
  process.stdout.write(
    `\nLayout QA ${passed ? 'passed' : 'failed'}\n` +
      `Scenario: ${input.scenario}\n` +
      `Target: ${input.targetUrl}\n` +
      `Viewport: ${
        input.result.viewport
          ? formatViewport(input.result.viewport)
          : 'unavailable'
      }\n` +
      `Final URL: ${input.result.finalUrl || 'unavailable'}\n` +
      `Duration: ${formatDurationMs(input.result.durationMs)}\n` +
      `Flows: ${flows.length || 0}\n` +
      `Manifest: ${
        input.manifestFound ? input.manifestPath : 'not found; default smoke'
      }\n\n`
  );

  for (const check of input.result.checks) {
    process.stdout.write(
      `${statusIcon(check.passed)} ${check.label}${
        check.detail ? ` - ${check.detail}` : ''
      }\n`
    );
  }

  for (const flow of flows) {
    process.stdout.write('\nFlow steps:\n');
    process.stdout.write(`${flow.name} (${flow.source})\n`);
    for (const step of flow.steps) {
      process.stdout.write(
        `${statusIcon(step.status === 'passed')} ${step.label || step.id}${
          step.detail ? ` - ${step.detail}` : ''
        }\n`
      );
    }
  }

  if (input.result.issues.length) {
    process.stdout.write('\nIssues:\n');
    for (const issue of input.result.issues) {
      process.stdout.write(
        `- ${issue.type}: ${issue.message}${
          issue.source ? ` (${issue.source})` : ''
        }\n`
      );
    }
  }

  if (input.result.nextAction) {
    process.stdout.write(
      `\nNext action: ${input.result.nextAction.title}\n` +
        `${input.result.nextAction.detail}\n`
    );
  }

  process.stdout.write(`\nArtifacts: ${input.artifacts.runDir}\n`);
  process.stdout.write(`Report: ${input.artifacts.reportPath}\n`);
}

function resultForConsole(result: QaTestRunResult) {
  const clean = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  delete clean.screenshotDataUrl;

  const scrubFlow = (flow?: {steps?: Record<string, unknown>[]}) => {
    for (const step of flow?.steps || []) {
      delete step.screenshotDataUrl;
    }
  };

  scrubFlow(clean.flow as {steps?: Record<string, unknown>[]} | undefined);
  const flows = clean.flows as {steps?: Record<string, unknown>[]}[] | undefined;
  for (const flow of flows || []) {
    scrubFlow(flow);
  }

  return clean;
}

function resultFlows(result: QaTestRunResult) {
  return result.flows?.length
    ? result.flows
    : result.flow
      ? [result.flow]
      : [];
}

function combineFlowRunResults(results: QaTestRunResult[]) {
  if (results.length === 1) {
    const [result] = results;
    return {
      ...result,
      flows: resultFlows(result),
    };
  }

  const flows = results
    .map(result => result.flow)
    .filter((flow): flow is QaTestRunFlowResult => Boolean(flow));
  const lastResult = results[results.length - 1];
  const firstFailed = results.find(result => !isQaRunPassed(result));
  const startedAt = results
    .map(result => result.startedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const completedAt = results
    .map(result => result.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .slice(-1)[0];
  const durationMs =
    typeof startedAt === 'string' && typeof completedAt === 'string'
      ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
      : results.reduce((sum, result) => sum + (result.durationMs || 0), 0);

  return {
    finalUrl: lastResult.finalUrl,
    title: lastResult.title,
    scenarioActive: lastResult.scenarioActive,
    controlsPresent: lastResult.controlsPresent,
    screenshotDataUrl: lastResult.screenshotDataUrl,
    screenshotBytes: lastResult.screenshotBytes,
    startedAt,
    completedAt,
    durationMs,
    bodyTextSample: results.map(result => result.bodyTextSample || '').join('\n\n'),
    viewport: lastResult.viewport,
    checks: results.flatMap(result => {
      const flowName = result.flow?.name || 'Flow';
      const flowId = result.flow?.id || 'flow';
      return result.checks.map(check => ({
        ...check,
        id: `${flowId}_${check.id}`,
        label: `${flowName}: ${check.label}`,
      }));
    }),
    issues: results.flatMap(result => result.issues),
    flow: flows[0],
    flows,
    nextAction: firstFailed?.nextAction || lastResult.nextAction,
  } satisfies QaTestRunResult;
}

function normalizeFlowName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function filterFlows(
  flows: LoadedQaFlow[],
  requestedFlowNames: string[],
  manifestPath: string
) {
  if (requestedFlowNames.length === 0) return flows;

  const requested = new Set(requestedFlowNames.map(normalizeFlowName));
  const selected = flows.filter(flow => {
    return (
      requested.has(normalizeFlowName(flow.id)) ||
      requested.has(normalizeFlowName(flow.name))
    );
  });

  if (selected.length === 0) {
    throw new Error(
      `No matching flows found in ${manifestPath}. Available flows: ${flows
        .map(flow => flow.id)
        .join(', ')}.`
    );
  }

  return selected;
}

function readFileAsDataUrl(filePath: string) {
  return fs.readFile(filePath).then(buffer => {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType =
      ext === '.html'
        ? 'text/html'
        : ext === '.json'
          ? 'application/json'
          : 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  });
}

function postJson(input: {
  url: string;
  token: string;
  body: Record<string, unknown>;
}) {
  const target = new URL(input.url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify(input.body);

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': '@trylayout/qa',
        },
      },
      res => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          responseBody += chunk;
        });
        res.on('end', () => {
          const parsed = responseBody
            ? (JSON.parse(responseBody) as Record<string, unknown>)
            : {};
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${
                  parsed.message || parsed.error || responseBody
                }`
              )
            );
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadRun(input: {
  options: CliOptions;
  result: QaTestRunResult;
  artifacts: ArtifactSummary;
  manifestPath: string;
  manifestFound: boolean;
  passed: boolean;
}) {
  if (!input.options.uploadUrl) return null;
  if (!input.options.apiKey) {
    throw new Error('--upload-url requires --api-key.');
  }

  const prNumber =
    input.options.prNumber || (await githubEventPullRequestNumber());
  const reportDataUrl = await readFileAsDataUrl(input.artifacts.reportPath);

  return postJson({
    url: input.options.uploadUrl,
    token: input.options.apiKey,
    body: {
      status: input.passed ? 'passed' : 'failed',
      runSource: input.options.runSource,
      repository: input.options.repo,
      branch: input.options.branch,
      commitSha: input.options.commitSha,
      prNumber: prNumber ? Number(prNumber) : undefined,
      runId: input.options.runId,
      scenario: input.options.scenario,
      targetUrl: input.options.targetUrl,
      startedAt: input.result.startedAt,
      completedAt: input.result.completedAt,
      durationMs: input.result.durationMs,
      manifestPath: input.manifestPath,
      manifestFound: input.manifestFound,
      result: input.result,
      report: {
        fileName: 'index.html',
        dataUrl: reportDataUrl,
      },
    },
  });
}

async function runBrowserChecks(input: {options: CliOptions; targetUrl: string}) {
  const {flows, manifestPath, manifestFound} = await loadFlows({
    flowsPath: input.options.flowsPath,
    scenario: input.options.scenario,
  });
  const selectedFlows = filterFlows(
    flows,
    input.options.flowNames,
    manifestPath
  );
  const results: QaTestRunResult[] = [];

  for (const flow of selectedFlows) {
    try {
      results.push(
        await runLayoutQaBrowser({
          targetUrl: input.targetUrl,
          scenario: input.options.scenario,
          flow,
          timeoutMs: input.options.timeoutMs || getTestTimeoutMs(),
          headless: !input.options.headed,
          viewport: input.options.viewport,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(buildRunnerErrorResult(message, input.options.viewport));
    }
  }
  const result = combineFlowRunResults(results);

  const artifacts = await writeArtifacts({
    outDir: input.options.outDir,
    scenario: input.options.scenario,
    targetUrl: input.targetUrl,
    manifestPath,
    manifestFound,
    result,
  });
  const passed = isQaRunPassed(result);
  const uploadResponse = await uploadRun({
    options: {...input.options, targetUrl: input.targetUrl},
    result,
    artifacts,
    manifestPath,
    manifestFound,
    passed,
  });

  if (input.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: passed ? 'passed' : 'failed',
          scenario: input.options.scenario,
          targetUrl: input.targetUrl,
          viewport: input.options.viewport,
          manifestPath,
          manifestFound,
          artifacts,
          upload: uploadResponse,
          result: resultForConsole(result),
        },
        null,
        2
      )}\n`
    );
  } else {
    printHumanSummary({
      result,
      scenario: input.options.scenario,
      targetUrl: input.targetUrl,
      manifestPath,
      manifestFound,
      artifacts,
    });
  }

  if (input.options.open) {
    await openReport(artifacts.reportPath);
  }

  if (uploadResponse && !input.options.json) {
    process.stdout.write(
      `Uploaded: ${String(uploadResponse.reportUrl || uploadResponse.runId)}\n`
    );
  }

  process.exitCode = passed ? 0 : 1;
}

async function runCommand(options: CliOptions) {
  if (!options.targetUrl) {
    throw new Error('--target-url is required.');
  }

  await runBrowserChecks({options, targetUrl: options.targetUrl});
}

async function checkCommand(options: CliOptions) {
  const manifestPath = options.flowsPath
    ? path.resolve(process.cwd(), options.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);
  const session = await startLocalCheckSession({options, manifestPath});
  const signalHandler = () => {
    session.close().finally(() => {
      process.exit(130);
    });
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  try {
    await runBrowserChecks({options, targetUrl: session.targetUrl});
  } finally {
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    await session.close();
  }
}

function apiEndpoint(baseUrl: string, pathName: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathName.replace(/^\/+/, '')}`;
}

async function remoteRunCommand(options: CliOptions) {
  const intent =
    options.command === 'test'
      ? options.intentText.trim()
      : options.intentText.trim() || options.intent.trim();
  if (options.command === 'test' && !intent) {
    throw new Error('trylayout test requires an intent, e.g. trylayout test "test checkout recovery".');
  }
  if (!options.repo) {
    throw new Error('--repo is required for remote runs.');
  }
  if (!options.branch) {
    throw new Error('--ref or --branch is required for remote runs.');
  }
  if (!options.apiKey) {
    throw new Error('--api-key is required for remote runs.');
  }

  const response = await postJson({
    url: apiEndpoint(options.apiUrl, '/remote-runs'),
    token: options.apiKey,
    body: {
      repository: options.repo,
      ref: options.branch,
      branch: options.branch,
      commitSha: options.commitSha || undefined,
      mode: options.command === 'test' ? 'exploratory' : options.mode,
      intent:
        options.command === 'test' || options.mode === 'exploratory'
          ? intent
          : undefined,
      trigger: 'agent',
      workflowId: options.workflowId,
    },
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  process.stdout.write('Layout remote run queued\n');
  process.stdout.write(`Run: ${String(response.runId || response.id || '')}\n`);
  if (response.runUrl || response.reportUrl) {
    process.stdout.write(
      `Report: ${String(response.runUrl || response.reportUrl)}\n`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.command === 'init') {
    await initCommand(options);
    return;
  }

  if (options.command === 'mock-api') {
    await mockApiCommand(options);
    return;
  }

  if (options.command === 'check') {
    await checkCommand(options);
    return;
  }

  if (options.command === 'run') {
    await runCommand(options);
    return;
  }

  if (options.command === 'remote-run' || options.command === 'test') {
    await remoteRunCommand(options);
    return;
  }

  throw new Error(`Unsupported command: ${options.command}`);
}

main().catch(error => {
  process.stderr.write(
    `Layout QA failed to start: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
