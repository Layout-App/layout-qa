#!/usr/bin/env node

import {spawn} from 'child_process';
import {request as httpRequest} from 'http';
import {request as httpsRequest} from 'https';
import {URL} from 'url';

const REMOTE_TEST_DOCS_URL = 'https://trylayout.com/docs/qa';
const WEB_SETUP_URL = 'https://app.trylayout.com/qa/setup';
const DEFAULT_API_URL = 'https://api.trylayout.com/v1/qa';

type CliCommand = 'setup' | 'test' | 'status' | 'help';

type CliOptions = {
  command: CliCommand;
  intentText: string;
  apiUrl: string;
  apiKey: string;
  repo: string;
  ref: string;
  commitSha: string;
  runId: string;
  timeoutMs?: number;
  wait: boolean;
  json: boolean;
  open: boolean;
  help: boolean;
};

type JsonResponseParseResult =
  | {ok: true; body: Record<string, unknown>}
  | {ok: false; error: string};

class HttpRequestError extends Error {
  statusCode: number;
  retryAfterMs?: number;

  constructor(input: {
    statusCode: number;
    message: string;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.statusCode = input.statusCode;
    this.retryAfterMs = input.retryAfterMs;
  }
}

function printHelp() {
  process.stdout.write(`Layout frontend QA CLI

Usage:
  trylayout setup [options]
  trylayout test "intent" --repo <owner/repo> --ref <branch> [options]
  trylayout status <run_id> [options]

Use npx @trylayout/qa <command> when running without installing.
layout-qa is an equivalent package alias.

Commands:
  setup              Check API setup and show API key instructions.
  test               Ask Layout to inspect a branch and return a QA verdict.
  status             Check a queued/running/completed QA verdict.

Options:
  --json             Print machine-readable JSON.
  --open             Open the web setup page during setup.
  --api-url <url>    Layout API base URL. Defaults to ${DEFAULT_API_URL}.
  --api-key <key>    Layout organization API key.
  --repo <name>      Repository full name, e.g. owner/repo.
  --ref <name>       Branch/ref to inspect. Defaults to --branch or the current git branch.
  --branch <name>    Alias for --ref.
  --commit-sha <sha> Commit SHA metadata.
  --run-id <id>      Layout run id for status checks.
  --intent <text>    Natural-language QA intent.
  --wait             Poll until the verdict is ready.
  --timeout <ms>     Wait timeout. Defaults to 600000.
  --help             Show this help.
`);
}

function envValue(name: string) {
  return process.env[name] || '';
}

function readFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  return args[index + 1] || '';
}

function hasFlag(args: string[], name: string) {
  return args.includes(name);
}

const VALUE_FLAGS = new Set([
  '--api-url',
  '--api-key',
  '--repo',
  '--ref',
  '--branch',
  '--commit-sha',
  '--run-id',
  '--intent',
  '--timeout',
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

function inferBranchFromEnv() {
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
  const command: CliCommand =
    firstCommand === 'setup' ||
    firstCommand === 'test' ||
    firstCommand === 'status'
      ? firstCommand
      : 'help';
  const positional = positionalArgs(args, command === 'help' ? 0 : 1);
  const timeoutValue = readFlag(args, '--timeout');
  const parsedTimeoutMs = timeoutValue ? Number(timeoutValue) : undefined;

  if (
    timeoutValue &&
    (!Number.isFinite(parsedTimeoutMs) || Number(parsedTimeoutMs) <= 0)
  ) {
    throw new Error('--timeout must be a positive number of milliseconds.');
  }

  const removedCommands = [
    'init',
    'check',
    'run',
    'mock-api',
    'install-browsers',
    'remote',
  ];
  if (removedCommands.includes(firstCommand)) {
    throw new Error(
      `${firstCommand} is no longer part of the Layout CLI. Use trylayout test "intent" --repo owner/repo --ref branch.`
    );
  }
  if (firstCommand === 'test' && args[1] === 'script') {
    throw new Error(
      'Scripted manifest runs have been removed from the primary CLI. Use trylayout test "intent" and let Layout choose the QA strategy.'
    );
  }
  if (hasFlag(args, '--mode') || hasFlag(args, '--flow')) {
    throw new Error(
      '--mode and --flow have been removed. Use trylayout test "intent" and let Layout choose the QA strategy.'
    );
  }

  return {
    command,
    intentText:
      command === 'test'
        ? readFlag(args, '--intent') || positional[0] || envValue('LAYOUT_INTENT')
        : readFlag(args, '--intent') || envValue('LAYOUT_INTENT'),
    apiUrl: readFlag(args, '--api-url') || envValue('LAYOUT_API_URL') || DEFAULT_API_URL,
    apiKey: readFlag(args, '--api-key') || envValue('LAYOUT_API_KEY'),
    repo:
      readFlag(args, '--repo') ||
      envValue('LAYOUT_REPOSITORY') ||
      envValue('GITHUB_REPOSITORY'),
    ref:
      readFlag(args, '--ref') ||
      readFlag(args, '--branch') ||
      envValue('LAYOUT_REF') ||
      envValue('LAYOUT_BRANCH') ||
      inferBranchFromEnv(),
    commitSha:
      readFlag(args, '--commit-sha') ||
      envValue('LAYOUT_COMMIT_SHA') ||
      envValue('GITHUB_SHA'),
    runId:
      readFlag(args, '--run-id') ||
      (command === 'status' ? positional[0] : '') ||
      envValue('LAYOUT_RUN_ID'),
    timeoutMs: parsedTimeoutMs,
    wait: hasFlag(args, '--wait'),
    json: hasFlag(args, '--json'),
    open: hasFlag(args, '--open'),
    help: hasFlag(args, '--help') || command === 'help',
  };
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

function retryAfterMs(headerValue: string | string[] | undefined) {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function requestFailure(input: {
  statusCode?: number;
  body: Record<string, unknown>;
  rawBody: string;
  retryAfterMs?: number;
}) {
  const statusCode = input.statusCode || 0;
  const message = `Request failed (${statusCode || 'unknown'}): ${
    input.body.message || input.body.error || input.rawBody
  }`;
  return new HttpRequestError({
    statusCode,
    message,
    retryAfterMs: input.retryAfterMs,
  });
}

function apiEndpoint(baseUrl: string, pathName: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathName.replace(/^\/+/, '')}`;
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
          const parsed = parseJsonResponseBody(responseBody);
          if (!parsed.ok) {
            reject(
              new Error(
                `Request failed (${res.statusCode || 'unknown'}): ${parsed.error}`
              )
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              requestFailure({
                statusCode: res.statusCode,
                body: parsed.body,
                rawBody: responseBody,
                retryAfterMs: retryAfterMs(res.headers['retry-after']),
              })
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
                `Request failed (${res.statusCode || 'unknown'}): ${parsed.error}`
              )
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              requestFailure({
                statusCode: res.statusCode,
                body: parsed.body,
                rawBody: responseBody,
                retryAfterMs: retryAfterMs(res.headers['retry-after']),
              })
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
  return ['passed', 'warning', 'failed', 'error', 'cancelled', 'unavailable'].includes(
    status
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      throw new Error(`Timed out waiting for Layout run ${runId} after ${timeoutMs}ms.`);
    }
    if (!options.json) {
      const run = remoteRunRecord(response);
      const phase = String(run.phase || response.phase || 'queued');
      const message = String(run.phaseMessage || response.phaseMessage || '');
      process.stderr.write(
        `Layout QA ${remoteRunStatus(response)} · ${phase}${
          message ? ` · ${message}` : ''
        }\n`
      );
    }
    await sleep(5000);
    try {
      response = await getRemoteRun(options, runId);
    } catch (error) {
      if (error instanceof HttpRequestError && error.statusCode === 429) {
        const delayMs = error.retryAfterMs || 5000;
        if (!options.json) {
          process.stderr.write(
            `Layout rate limit reached; retrying in ${Math.ceil(delayMs / 1000)}s\n`
          );
        }
        await sleep(delayMs);
        response = await getRemoteRun(options, runId);
        continue;
      }
      throw error;
    }
  }

  return response;
}

function remoteRunIssues(response: Record<string, unknown>) {
  const run = remoteRunRecord(response);
  const issues = (isRecord(response) && Array.isArray(response.issues)
    ? response.issues
    : (run as {issues?: unknown}).issues);
  return Array.isArray(issues) ? issues : [];
}

function setupError(missing: string[]) {
  return [`Layout frontend QA needs ${missing.join(', ')}.`, `Docs: ${REMOTE_TEST_DOCS_URL}`].join('\n');
}

async function setupCommand(options: CliOptions) {
  const repository = options.repo || (await inferGitRepository());
  const ref = options.ref || (await inferGitBranch());
  const hasApiKey = Boolean(options.apiKey);
  const ready = Boolean(hasApiKey && repository && ref);
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
    },
    repository: repository || undefined,
    ref: ref || undefined,
    setupUrl: WEB_SETUP_URL,
    docsUrl: REMOTE_TEST_DOCS_URL,
    nextCommands: {
      setApiKey: 'export LAYOUT_API_KEY="lqa_key_..."',
      test: nextTestCommand,
      status: 'trylayout status <run_id> --wait --json',
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

  process.stdout.write('Layout frontend QA setup\n\n');
  process.stdout.write(
    `${hasApiKey ? 'PASS' : 'TODO'} API key: ${
      hasApiKey ? 'found in --api-key/LAYOUT_API_KEY' : 'missing'
    }\n`
  );
  process.stdout.write(
    `${repository ? 'PASS' : 'TODO'} Repository: ${repository || 'not detected'}\n`
  );
  process.stdout.write(`${ref ? 'PASS' : 'TODO'} Ref: ${ref || 'not detected'}\n\n`);

  if (!hasApiKey) {
    process.stdout.write('Get an API key:\n');
    process.stdout.write(`  ${WEB_SETUP_URL}\n\n`);
    process.stdout.write('Then add it to your shell:\n');
    process.stdout.write('  export LAYOUT_API_KEY="lqa_key_..."\n\n');
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

async function testCommand(options: CliOptions) {
  const intent = options.intentText.trim();
  if (!intent) {
    throw new Error(setupError(['an intent, e.g. trylayout test "test this branch"']));
  }

  const missing: string[] = [];
  if (!options.repo) missing.push('--repo owner/repo');
  if (!options.ref) missing.push('--ref branch');
  if (!options.apiKey) missing.push('--api-key or LAYOUT_API_KEY');
  if (missing.length > 0) throw new Error(setupError(missing));

  let response = await postJson({
    url: apiEndpoint(options.apiUrl, '/remote-runs'),
    token: options.apiKey,
    body: {
      repository: options.repo,
      ref: options.ref,
      branch: options.ref,
      commitSha: options.commitSha || undefined,
      mode: 'exploratory',
      intent,
      trigger: 'agent',
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
      ? `Layout QA ${remoteRunStatus(response)}\n`
      : 'Layout QA queued\n'
  );
  process.stdout.write(`Run: ${runId}\n`);
  if (response.runUrl || response.reportUrl) {
    process.stdout.write(`Result: ${String(response.runUrl || response.reportUrl)}\n`);
  }

  const issues = remoteRunIssues(response).slice(0, 5);
  if (issues.length) {
    process.stdout.write('Issues:\n');
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

async function statusCommand(options: CliOptions) {
  const missing: string[] = [];
  if (!options.runId) missing.push('run id');
  if (!options.apiKey) missing.push('--api-key or LAYOUT_API_KEY');
  if (missing.length > 0) throw new Error(setupError(missing));

  let response = await getRemoteRun(options, options.runId);
  if (options.wait) {
    response = await waitForRemoteRun(options, options.runId, response);
    const status = remoteRunStatus(response);
    if (status !== 'passed' || remoteRunIssueCount(response) > 0) {
      process.exitCode = 1;
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  const run = remoteRunRecord(response);
  const status = remoteRunStatus(response);
  const phase = String(run.phase || response.phase || 'unknown');
  const phaseStatus = String(run.phaseStatus || response.phaseStatus || '');
  const phaseMessage = String(run.phaseMessage || response.phaseMessage || '');
  const issueCount = Number(run.issueCount || response.issueCount || 0);
  process.stdout.write(`Layout QA ${status}\n`);
  process.stdout.write(`Run: ${String(response.runId || options.runId)}\n`);
  process.stdout.write(`Phase: ${phase}${phaseStatus ? ` (${phaseStatus})` : ''}\n`);
  if (phaseMessage) process.stdout.write(`Message: ${phaseMessage}\n`);
  process.stdout.write(`Issues: ${issueCount}\n`);
  if (response.runUrl || response.reportUrl) {
    process.stdout.write(`Result: ${String(response.runUrl || response.reportUrl)}\n`);
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

  if (options.command === 'setup') {
    await setupCommand(options);
    return;
  }

  if (options.command === 'test') {
    await testCommand(options);
    return;
  }

  if (options.command === 'status') {
    await statusCommand(options);
    return;
  }

  printHelp();
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
