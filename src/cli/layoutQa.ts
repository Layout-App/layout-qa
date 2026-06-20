#!/usr/bin/env node

import {spawn, type ChildProcess} from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import {createRequire} from 'module';
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
import {ensureLayoutGitignore} from '../gitignore';
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

const requireFromHere = createRequire(__filename);
const REMOTE_TEST_DOCS_URL = 'https://trylayout.com/docs/qa#remote-ai-tests';
const WEB_SETUP_URL = 'https://app.trylayout.com/qa/setup';

type CliOptions = {
  command: string;
  intentText: string;
  flowNames: string[];
  app: string;
  targetUrl: string;
  scenario: string;
  flowsPath: string;
  mockRoot: string;
  port?: number;
  outDir: string;
  apiUrl: string;
  apiKey: string;
  repo: string;
  branch: string;
  commitSha: string;
  runId: string;
  mode: 'scripted' | 'exploratory';
  intent: string;
  workflowId: string;
  viewport: QaViewport;
  timeoutMs?: number;
  headed: boolean;
  startApp: boolean;
  serveMocks: boolean;
  skipInstall: boolean;
  wait: boolean;
  json: boolean;
  open: boolean;
  force: boolean;
  help: boolean;
};

function printHelp() {
  process.stdout.write(`Layout QA CLI

Usage:
  trylayout setup [options]
  trylayout init [options]
  trylayout test "intent" --repo <owner/repo> --ref <branch> [options]
  trylayout status <run_id> [options]
  trylayout check [flow_id ...] [options]
  trylayout install-browsers
  trylayout mock-api [options]
  trylayout run --target-url <url> [options]
  trylayout remote run --repo <owner/repo> --ref <branch> [options]
  trylayout remote status <run_id> [options]
  layout-qa setup [options]
  layout-qa test "intent" --repo <owner/repo> --ref <branch> [options]
  layout-qa status <run_id> [options]
  layout-qa check [flow_id ...] [options]
  layout-qa mock-api [options]
  layout-qa run --target-url <url> [options]
  npx @trylayout/qa test "intent" --repo <owner/repo> --ref <branch> [options]
  npx @trylayout/qa setup [options]
  npx @trylayout/qa status <run_id> [options]
  npx @trylayout/qa check [flow_id ...] [options]
  npx @trylayout/qa install-browsers
  npx @trylayout/qa mock-api [options]
  npx @trylayout/qa run --target-url <url> [options]
  npx @trylayout/qa remote run --repo <owner/repo> --ref <branch> [options]
  npx @trylayout/qa remote status <run_id> [options]
  npx layout-qa setup [options]
  npx layout-qa test "intent" --repo <owner/repo> --ref <branch> [options]
  npx layout-qa status <run_id> [options]
  npx layout-qa check [flow_id ...] [options]
  npx layout-qa mock-api [options]
  npx layout-qa run --target-url <url> [options]

Commands:
  setup                Check remote QA setup and show API key instructions.
  init                  Write a starter .layout/qa.json.
  test                  Ask Layout to run AI browser QA remotely.
  status                Check a queued/running/completed remote run.
  check                 Run local/CI scripted manifest checks.
  install-browsers      Install Chromium for local/CI browser checks.
  mock-api              Start a Layout mock service from manifest apps.<app>.services.api.
  run                   Run browser QA and write a local HTML report.
  remote run            Ask Layout to run browser QA against a repo/ref.
  remote status         Check a queued/running/completed remote run.

Options:
  --target-url <url>     URL of the running frontend to test.
  --scenario <name>      Scenario to activate. Defaults to happy_path.
  --flows <path>         Flow manifest path. Defaults to .layout/qa.json.
  --app <name>           App key from manifest apps.<name>.
  --mock-root <path>     Mock service root. Defaults from .layout/qa.json apps.<app>.services.api.root.
  --port <number>        Port for mock-api or a single service. Defaults to an available local port.
  --out <path>           Artifact directory. Defaults to .layout/runs.
  --viewport <value>     Viewport preset or size. Use desktop, tablet, mobile, or WIDTHxHEIGHT. Defaults to desktop.
  --timeout <ms>         Browser run timeout. Defaults to LAYOUT_QA_TEST_TIMEOUT_MS or 60000.
  --headed               Show the browser instead of running headless.
  --open                 Open the web setup page or generated local HTML report.
  --json                 Print machine-readable JSON.
  --api-url <url>        Layout API base URL. Defaults to https://api.trylayout.com/v1/qa.
  --api-key <key>        Layout organization API key for remote runs.
  --repo <name>          Repository full name, e.g. owner/repo.
  --branch <name>        Branch name for report metadata.
  --ref <name>           Branch/ref for a remote run. Defaults to --branch.
  --commit-sha <sha>     Commit SHA for remote run metadata.
  --run-id <id>          Remote Layout run id for status checks.
  --mode <value>         scripted or ai. Defaults to ai for remote run.
  --intent <text>        Natural-language intent for AI testing remote runs.
  --workflow-id <file>   Workflow id metadata. Defaults to layout-verify.yml.
  --wait                 Wait for a remote run to finish before printing the result.
  --start-app            Start the app from .layout/qa.json before local checks.
  --serve-mocks          Start manifest services before local checks. Automatic with --start-app.
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
  '--app',
  '--mock-root',
  '--port',
  '--out',
  '--viewport',
  '--timeout',
  '--api-url',
  '--api-key',
  '--repo',
  '--branch',
  '--ref',
  '--commit-sha',
  '--run-id',
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

function inferBranch() {
  return envValue('GITHUB_HEAD_REF') || envValue('GITHUB_REF_NAME');
}

function normalizeGithubRepository(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!httpsMatch) return '';
  return `${httpsMatch[1]}/${httpsMatch[2]}`;
}

function captureChildCommand(input: {
  command: string;
  args: string[];
  cwd?: string;
}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `Command failed (${code ?? 'signal'}): ${[
            input.command,
            ...input.args,
          ].join(' ')}`
        )
      );
    });
  });
}

async function inferGitBranch() {
  return captureChildCommand({
    command: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: process.cwd(),
  }).catch(() => '');
}

async function inferGitRepository() {
  const remoteUrl = await captureChildCommand({
    command: 'git',
    args: ['config', '--get', 'remote.origin.url'],
    cwd: process.cwd(),
  }).catch(() => '');
  return remoteUrl ? normalizeGithubRepository(remoteUrl) : '';
}

function openUrl(url: string) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args =
    process.platform === 'darwin'
      ? [url]
      : process.platform === 'win32'
        ? ['/c', 'start', '', url]
        : [url];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.unref();
    resolve();
  });
}

function parseArgs(args: string[]): CliOptions {
  const firstCommand = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const command =
    firstCommand === 'remote' && args[1] === 'run'
      ? 'remote-run'
      : firstCommand === 'remote' && args[1] === 'status'
        ? 'remote-status'
        : firstCommand;
  const positional = positionalArgs(
    args,
    command === 'remote-run' || command === 'remote-status' ? 2 : 1
  );
  const timeoutValue = readFlag(args, '--timeout');
  const parsedTimeoutMs = timeoutValue ? Number(timeoutValue) : undefined;
  const portValue = readFlag(args, '--port');
  const parsedPort = portValue ? Number(portValue) : undefined;

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
    app: readFlag(args, '--app') || envValue('LAYOUT_QA_APP'),
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
    runId:
      readFlag(args, '--run-id') ||
      (command === 'status' || command === 'remote-status'
        ? positional[0]
        : '') ||
      envValue('LAYOUT_RUN_ID'),
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
    wait: hasFlag(args, '--wait'),
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
  name: string;
  root: string;
  install?: string;
  start: string;
  healthUrl?: string;
  env: Record<string, string>;
  services: Record<string, unknown>;
};

type ServiceConfig = {
  name: string;
  type: 'mock' | 'command' | 'external';
  root: string;
  install?: string;
  start?: string;
  healthUrl?: string;
  url?: string;
  scenario?: string;
  env: Record<string, string>;
};

type RunningService = {
  name: string;
  url: string;
  close: () => Promise<void>;
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

async function readManifest(manifestPath: string) {
  const content = await fs.readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return content ? (JSON.parse(content) as Record<string, unknown>) : null;
}

function selectManifestApp(
  manifest: Record<string, unknown>,
  manifestPath: string,
  appName?: string
): {name: string; config: Record<string, unknown>} | null {
  if (!isRecord(manifest.apps)) return null;
  const entries = Object.entries(manifest.apps).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
  );
  if (entries.length === 0) return null;

  if (appName) {
    const match = entries.find(([name]) => name === appName);
    return match ? {name: match[0], config: match[1]} : null;
  }

  if (entries.length === 1) return {name: entries[0][0], config: entries[0][1]};

  const defaultApp = entries.find(([, app]) => app.default === true);
  if (defaultApp) return {name: defaultApp[0], config: defaultApp[1]};

  const namedApp = entries.find(([name]) => name === 'app');
  if (namedApp) return {name: namedApp[0], config: namedApp[1]};

  throw new Error(
    `Multiple apps found in ${manifestPath}. Pass --app <name> to choose one.`
  );
}

async function loadAppConfig(manifestPath: string, appName?: string) {
  const manifest = await readManifest(manifestPath);
  if (!manifest) return null;
  const selected = selectManifestApp(manifest, manifestPath, appName);
  if (!selected) return null;

  const app = selected.config;
  const start = typeof app.start === 'string' ? app.start.trim() : '';
  if (!start) return null;

  return {
    name: selected.name,
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
    services: isRecord(app.services) ? app.services : {},
  } satisfies AppConfig;
}

async function loadServiceConfigs(manifestPath: string, appName?: string) {
  const app = await loadAppConfig(manifestPath, appName);
  if (!app) return [];

  return Object.entries(app.services)
    .map(([name, raw]): ServiceConfig | null => {
      if (!isRecord(raw)) return null;
      const type = raw.type === 'command' || raw.type === 'external' ? raw.type : 'mock';
      return {
        name,
        type,
        root: typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : '.',
        install:
          typeof raw.install === 'string' && raw.install.trim()
            ? raw.install.trim()
            : undefined,
        start:
          typeof raw.start === 'string' && raw.start.trim()
            ? raw.start.trim()
            : undefined,
        healthUrl:
          typeof raw.healthUrl === 'string' && raw.healthUrl.trim()
            ? raw.healthUrl.trim()
            : undefined,
        url:
          typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : undefined,
        scenario:
          typeof raw.scenario === 'string' && raw.scenario.trim()
            ? raw.scenario.trim()
            : undefined,
        env: stringRecord(raw.env),
      };
    })
    .filter((service): service is ServiceConfig => Boolean(service));
}

function expandVariables(value: string, variables: Record<string, string>) {
  return Object.entries(variables).reduce((expanded, [key, variableValue]) => {
    return expanded
      .split(`$${key}`)
      .join(variableValue)
      .split(`\${${key}}`)
      .join(variableValue);
  }, value);
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

function runChildCommand(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  silent?: boolean;
}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: input.silent ? 'ignore' : 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command failed (${code ?? 'signal'}): ${[
            input.command,
            ...input.args,
          ].join(' ')}`
        )
      );
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

function serviceVariables(services: RunningService[]) {
  return services.reduce<Record<string, string>>((variables, service) => {
    variables[`services.${service.name}.url`] = service.url;
    variables[`${service.name}.url`] = service.url;
    return variables;
  }, {});
}

function serviceRoot(manifestPath: string, service: ServiceConfig) {
  return path.resolve(repoRootFromManifest(manifestPath), service.root);
}

async function startCommandService(input: {
  manifestPath: string;
  service: ServiceConfig;
  variables: Record<string, string>;
  options: CliOptions;
}) {
  if (!input.service.start) {
    throw new Error(`services.${input.service.name}.start is required for command services.`);
  }

  const port = await getAvailablePort();
  const variables = {...input.variables, PORT: String(port)};
  const root = serviceRoot(input.manifestPath, input.service);
  const env = {
    ...process.env,
    ...expandEnv(input.service.env, variables),
    PORT: String(port),
  };

  if (input.service.install && !input.options.skipInstall) {
    await runShellCommand({
      command: expandVariables(input.service.install, variables),
      cwd: root,
      env,
      silent: input.options.json,
    });
  }

  const startCommand = expandVariables(input.service.start, variables);
  const child = spawn(startCommand, {
    cwd: root,
    env,
    shell: true,
    stdio: input.options.json ? 'ignore' : 'inherit',
  });
  child.on('error', error => {
    process.stderr.write(
      `Layout service "${input.service.name}" start failed: ${error.message}\n`
    );
  });

  const healthUrl = expandVariables(
    input.service.healthUrl || `http://127.0.0.1:${port}/`,
    variables
  );
  await waitForUrl(healthUrl, input.options.timeoutMs || getTestTimeoutMs());

  return {
    name: input.service.name,
    url: new URL(healthUrl).origin,
    close: () => stopChild(child),
  } satisfies RunningService;
}

async function startMockService(input: {
  manifestPath: string;
  service: ServiceConfig;
  options: CliOptions;
}) {
  const root = path.resolve(repoRootFromManifest(input.manifestPath), input.service.root);
  const server = await startQaMockApiServer({
    root,
    scenario: input.options.scenario || input.service.scenario || 'happy_path',
    port: input.options.port,
  });
  if (!input.options.json) {
    process.stdout.write(
      `Layout mock service "${input.service.name}" listening at ${server.url}\n`
    );
  }
  return {
    name: input.service.name,
    url: server.url,
    close: () => server.close(),
  } satisfies RunningService;
}

async function startServices(input: {
  manifestPath: string;
  options: CliOptions;
}) {
  const configs = await loadServiceConfigs(input.manifestPath, input.options.app);
  const running: RunningService[] = [];

  try {
    for (const service of configs) {
      const variables = serviceVariables(running);
      if (service.type === 'external') {
        if (!service.url) {
          throw new Error(`services.${service.name}.url is required for external services.`);
        }
        const url = expandVariables(service.url, variables);
        if (service.healthUrl) {
          await waitForUrl(
            expandVariables(service.healthUrl, {
              ...variables,
              [`services.${service.name}.url`]: url,
              [`${service.name}.url`]: url,
            }),
            input.options.timeoutMs || getTestTimeoutMs()
          );
        }
        running.push({
          name: service.name,
          url,
          close: async () => undefined,
        });
      } else if (service.type === 'command') {
        running.push(
          await startCommandService({
            manifestPath: input.manifestPath,
            service,
            variables,
            options: input.options,
          })
        );
      } else {
        running.push(
          await startMockService({
            manifestPath: input.manifestPath,
            service,
            options: input.options,
          })
        );
      }
    }
  } catch (error) {
    for (const service of running.slice().reverse()) {
      await service.close().catch(() => undefined);
    }
    throw error;
  }

  return running;
}

async function startLocalCheckSession(input: {
  options: CliOptions;
  manifestPath: string;
}) {
  const services: RunningService[] = [];
  let appProcess: ChildProcess | undefined;

  const close = async () => {
    await stopChild(appProcess);
    for (const service of services.slice().reverse()) {
      await service.close().catch(() => {
        // Best-effort shutdown.
      });
    }
  };

  const app = input.options.startApp
    ? await loadAppConfig(input.manifestPath, input.options.app)
    : null;

  if (input.options.startApp && !app) {
    await close();
    throw new Error(
      '--start-app requires an apps.<name>.start block in .layout/qa.json.'
    );
  }

  if (input.options.startApp || input.options.serveMocks) {
    services.push(
      ...(await startServices({
        manifestPath: input.manifestPath,
        options: input.options,
      }))
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

  if (!app) {
    await close();
    throw new Error(
      '--start-app requires an apps.<name>.start block in .layout/qa.json.'
    );
  }

  const port = await getAvailablePort();
  const variables = {
    ...serviceVariables(services),
    PORT: String(port),
  };
  const appEnv = expandEnv(app.env, variables);

  const appRoot = path.resolve(repoRootFromManifest(input.manifestPath), app.root);
  const env = {
    ...process.env,
    ...appEnv,
    PORT: String(port),
  };

  if (app.install && !input.options.skipInstall) {
    await runShellCommand({
      command: expandVariables(app.install, variables),
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
  const layoutGitignorePath = await ensureLayoutGitignore(layoutDir);
  const mockRoot = path.resolve(
    path.dirname(path.dirname(manifestPath)),
    '.layout',
    'api',
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
  process.stdout.write(`Created starter mock service scenarios in ${mockRoot}\n`);
  process.stdout.write(
    `Updated ${layoutGitignorePath} to ignore generated Layout artifacts\n`
  );
}

async function setupCommand(options: CliOptions) {
  const manifestPath = options.flowsPath
    ? path.resolve(process.cwd(), options.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);
  const manifestExists = await exists(manifestPath);
  const repository = options.repo || (await inferGitRepository());
  const ref = options.branch || (await inferGitBranch());
  const hasApiKey = Boolean(options.apiKey);
  const ready = Boolean(hasApiKey && repository && ref && manifestExists);
  const nextTestCommand = [
    'trylayout test "test this branch"',
    repository ? `--repo ${repository}` : '--repo owner/repo',
    ref ? `--ref ${ref}` : '--ref branch',
    '--wait',
    '--json',
  ].join(' ');
  const setup = {
    ready,
    checks: {
      apiKey: hasApiKey,
      repository: Boolean(repository),
      ref: Boolean(ref),
      manifest: manifestExists,
    },
    repository: repository || undefined,
    ref: ref || undefined,
    manifestPath,
    setupUrl: WEB_SETUP_URL,
    docsUrl: REMOTE_TEST_DOCS_URL,
    nextCommands: {
      setApiKey: 'export LAYOUT_API_KEY="lqa_key_..."',
      initManifest: 'trylayout init',
      test: nextTestCommand,
    },
  };

  if (options.open) {
    await openUrl(WEB_SETUP_URL).catch(error => {
      process.stderr.write(
        `Could not open ${WEB_SETUP_URL}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(setup, null, 2)}\n`);
    process.exitCode = ready ? 0 : 1;
    return;
  }

  process.stdout.write('Layout remote QA setup\n\n');
  process.stdout.write(
    `${hasApiKey ? '✓' : '•'} API key: ${
      hasApiKey ? 'found in --api-key/LAYOUT_API_KEY' : 'missing'
    }\n`
  );
  process.stdout.write(
    `${repository ? '✓' : '•'} Repository: ${repository || 'not detected'}\n`
  );
  process.stdout.write(`${ref ? '✓' : '•'} Ref: ${ref || 'not detected'}\n`);
  process.stdout.write(
    `${manifestExists ? '✓' : '•'} Manifest: ${
      manifestExists ? manifestPath : `${manifestPath} not found`
    }\n\n`
  );

  if (!hasApiKey) {
    process.stdout.write('Get an API key:\n');
    process.stdout.write(`  ${WEB_SETUP_URL}\n\n`);
    process.stdout.write('Then add it to your shell:\n');
    process.stdout.write('  export LAYOUT_API_KEY="lqa_key_..."\n\n');
  }
  if (!manifestExists) {
    process.stdout.write('Create a starter manifest:\n');
    process.stdout.write('  trylayout init\n\n');
  }
  if (!repository || !ref) {
    process.stdout.write('If repo/ref were not detected, pass them explicitly:\n');
    process.stdout.write('  --repo owner/repo --ref branch\n\n');
  }

  process.stdout.write(`Docs: ${REMOTE_TEST_DOCS_URL}\n\n`);
  process.stdout.write('Next command:\n');
  process.stdout.write(`  ${nextTestCommand}\n`);
  process.exitCode = ready ? 0 : 1;
}

async function installBrowsersCommand(options: CliOptions) {
  const playwrightPackagePath = requireFromHere.resolve('playwright/package.json');
  const playwrightCliPath = path.join(path.dirname(playwrightPackagePath), 'cli.js');

  if (!options.json) {
    process.stdout.write('Installing Chromium for Layout QA browser checks...\n');
  }

  await runChildCommand({
    command: process.execPath,
    args: [playwrightCliPath, 'install', 'chromium'],
    cwd: process.cwd(),
    env: process.env,
    silent: options.json,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({status: 'installed', browser: 'chromium'}, null, 2)}\n`
    );
  } else {
    process.stdout.write('Chromium is ready for Layout QA.\n');
  }
}

async function mockApiCommand(options: CliOptions) {
  const manifestPath = options.flowsPath
    ? path.resolve(process.cwd(), options.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);
  const manifestConfig = await loadQaMockApiConfig({
    manifestPath,
    scenario: options.scenario,
    app: options.app,
  });
  const root = options.mockRoot
    ? path.resolve(process.cwd(), options.mockRoot)
    : manifestConfig?.root;

  if (!root) {
    throw new Error(
      'No mock service root found. Add apps.<app>.services.api with type "mock" to .layout/qa.json or pass --mock-root.'
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
    process.stdout.write(`Layout mock service listening at ${server.url}\n`);
    process.stdout.write(`Service URL: ${server.url}\n`);
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
    // Keep the mock service process alive until it receives a termination signal.
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

function isMissingPlaywrightBrowserError(message: string) {
  return (
    /Executable doesn't exist/i.test(message) &&
    /playwright install/i.test(message)
  );
}

function layoutBrowserInstallMessage(originalMessage: string) {
  if (!isMissingPlaywrightBrowserError(originalMessage)) return originalMessage;

  return [
    'Layout QA could not find the Playwright Chromium browser.',
    'Run `npx @trylayout/qa install-browsers` once, then retry this check.',
    'In GitHub Actions, add `npx @trylayout/qa install-browsers` before `npx @trylayout/qa check`.',
    '',
    `Original Playwright error: ${originalMessage}`,
  ].join('\n');
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

type JsonResponseParseResult =
  | {ok: true; body: Record<string, unknown>}
  | {ok: false; error: string};

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
          const parsed = parseJsonResponseBody(responseBody);
          if (!parsed.ok) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${
                  parsed.error
                }`
              )
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${
                  parsed.body.message || parsed.body.error || responseBody
                }`
              )
            );
            return;
          }
          resolve(parsed.body);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonResponseBody(responseBody: string): JsonResponseParseResult {
  if (!responseBody) return {ok: true, body: {} as Record<string, unknown>};
  try {
    return {
      ok: true,
      body: JSON.parse(responseBody) as Record<string, unknown>,
    };
  } catch {
    return {
      ok: false,
      error: responseBody.trim().slice(0, 500) || 'Non-JSON response',
    };
  }
}

function getJson(input: {url: string; token: string}) {
  const target = new URL(input.url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.token}`,
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
          const parsed = parseJsonResponseBody(responseBody);
          if (!parsed.ok) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${
                  parsed.error
                }`
              )
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${
                  parsed.body.message || parsed.body.error || responseBody
                }`
              )
            );
            return;
          }
          resolve(parsed.body);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runBrowserChecks(input: {options: CliOptions; targetUrl: string}) {
  const {flows, manifestPath, manifestFound} = await loadFlows({
    flowsPath: input.options.flowsPath,
    scenario: input.options.scenario,
    app: input.options.app,
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
      const message = layoutBrowserInstallMessage(
        error instanceof Error ? error.message : String(error)
      );
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function remoteRunSetupError(missing: string[]) {
  return [
    `Layout remote test needs ${missing.join(', ')}.`,
    `Docs: ${REMOTE_TEST_DOCS_URL}`,
  ].join('\n');
}

function remoteRunRecord(response: Record<string, unknown>) {
  return isRecord(response.run) ? response.run : response;
}

function remoteRunId(response: Record<string, unknown>) {
  const run = remoteRunRecord(response);
  return String(response.runId || run.id || response.id || '');
}

function remoteRunStatus(response: Record<string, unknown>) {
  const run = remoteRunRecord(response);
  return String(run.status || response.status || 'unknown');
}

function remoteRunIssueCount(response: Record<string, unknown>) {
  const run = remoteRunRecord(response);
  return Number(run.issueCount || response.issueCount || 0);
}

function isTerminalRemoteStatus(status: string) {
  return ['passed', 'warning', 'failed', 'error', 'cancelled'].includes(status);
}

async function getRemoteRun(options: CliOptions, runId: string) {
  return getJson({
    url: apiEndpoint(options.apiUrl, `/remote-runs/${encodeURIComponent(runId)}`),
    token: options.apiKey,
  });
}

async function waitForRemoteRun(
  options: CliOptions,
  runId: string,
  initialResponse: Record<string, unknown>
) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const startedAt = Date.now();
  let response = initialResponse;

  while (!isTerminalRemoteStatus(remoteRunStatus(response))) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out waiting for Layout run ${runId} after ${timeoutMs}ms.`
      );
    }
    if (!options.json) {
      const run = remoteRunRecord(response);
      const phase = String(run.phase || response.phase || 'queued');
      const message = String(run.phaseMessage || response.phaseMessage || '');
      process.stderr.write(
        `Layout run ${remoteRunStatus(response)} · ${phase}${
          message ? ` · ${message}` : ''
        }\n`
      );
    }
    await sleep(5000);
    response = await getRemoteRun(options, runId);
  }

  return response;
}

async function remoteRunCommand(options: CliOptions) {
  const intent =
    options.command === 'test'
      ? options.intentText.trim()
      : options.intentText.trim() || options.intent.trim();
  if (options.command === 'test' && !intent) {
    throw new Error(
      remoteRunSetupError([
        'an intent, e.g. npx @trylayout/qa test "test this branch"',
      ])
    );
  }

  const missing: string[] = [];
  if (!options.repo) missing.push('--repo owner/repo');
  if (!options.branch) missing.push('--ref branch');
  if (!options.apiKey) missing.push('--api-key or LAYOUT_API_KEY');
  if (missing.length > 0) {
    throw new Error(remoteRunSetupError(missing));
  }

  let response = await postJson({
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
  const runId = remoteRunId(response);

  if (options.wait) {
    if (!runId) throw new Error('Layout API did not return a run id.');
    response = await waitForRemoteRun(options, runId, response);
    const status = remoteRunStatus(response);
    if (status !== 'passed' || remoteRunIssueCount(response) > 0) {
      process.exitCode = 1;
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    options.wait
      ? `Layout remote run ${remoteRunStatus(response)}\n`
      : 'Layout remote run queued\n'
  );
  process.stdout.write(`Run: ${runId}\n`);
  if (response.runUrl || response.reportUrl) {
    process.stdout.write(
      `Report: ${String(response.runUrl || response.reportUrl)}\n`
    );
  }
}

function remoteRunIssues(response: Record<string, unknown>) {
  const run = remoteRunRecord(response);
  const issues = (isRecord(response) && Array.isArray(response.issues)
    ? response.issues
    : (run as {issues?: unknown}).issues);
  return Array.isArray(issues) ? issues : [];
}

async function remoteStatusCommand(options: CliOptions) {
  const missing: string[] = [];
  if (!options.runId) missing.push('run id');
  if (!options.apiKey) missing.push('--api-key or LAYOUT_API_KEY');
  if (missing.length > 0) {
    throw new Error(remoteRunSetupError(missing));
  }

  const response = await getRemoteRun(options, options.runId);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  const run = remoteRunRecord(response);
  const status = remoteRunStatus(response);
  const phase = String(run.phase || response.phase || 'unknown');
  const phaseStatus = String(run.phaseStatus || response.phaseStatus || '');
  const phaseMessage = String(run.phaseMessage || response.phaseMessage || '');
  const screenCount = Number(run.screenCount || response.screenCount || 0);
  const issueCount = Number(run.issueCount || response.issueCount || 0);
  process.stdout.write(`Layout remote run ${status}\n`);
  process.stdout.write(`Run: ${String(response.runId || options.runId)}\n`);
  process.stdout.write(
    `Phase: ${phase}${phaseStatus ? ` (${phaseStatus})` : ''}\n`
  );
  if (phaseMessage) {
    process.stdout.write(`Message: ${phaseMessage}\n`);
  }
  process.stdout.write(`Screens: ${screenCount}\n`);
  process.stdout.write(`Issues: ${issueCount}\n`);
  if (response.runUrl || response.reportUrl) {
    process.stdout.write(
      `Report: ${String(response.runUrl || response.reportUrl)}\n`
    );
  }

  const issues = remoteRunIssues(response).slice(0, 5);
  if (issues.length) {
    process.stdout.write('Top issues:\n');
    for (const issue of issues) {
      const item = issue as {
        severity?: unknown;
        type?: unknown;
        message?: unknown;
      };
      process.stdout.write(
        `- ${String(item.severity || 'issue')} ${String(
          item.type || 'unknown'
        )}: ${String(item.message || '')}\n`
      );
    }
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

  if (options.command === 'setup') {
    await setupCommand(options);
    return;
  }

  if (options.command === 'install-browsers') {
    await installBrowsersCommand(options);
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

  if (options.command === 'remote-status' || options.command === 'status') {
    await remoteStatusCommand(options);
    return;
  }

  throw new Error(`Unsupported command: ${options.command}`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({error: message}, null, 2)}\n`);
  } else {
    process.stderr.write(`Layout QA failed: ${message}\n`);
  }
  process.exitCode = 1;
});
