#!/usr/bin/env node

import fs from 'fs/promises';
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
import {buildRunnerErrorResult, isQaRunPassed, runLayoutQaBrowser} from '../runner';
import {openReport, writeArtifacts} from '../report';
import {
  ArtifactSummary,
  QaTestRunFlowResult,
  QaTestRunResult,
  QaViewport,
} from '../types';
import {formatViewport, parseViewport} from '../viewports';

type CliOptions = {
  command: string;
  targetUrl: string;
  scenario: string;
  flowsPath: string;
  outDir: string;
  uploadUrl: string;
  uploadToken: string;
  repo: string;
  branch: string;
  commitSha: string;
  prNumber: string;
  runId: string;
  runSource: 'local' | 'github_actions';
  viewport: QaViewport;
  timeoutMs?: number;
  headed: boolean;
  json: boolean;
  open: boolean;
  force: boolean;
  help: boolean;
};

function printHelp() {
  process.stdout.write(`Layout QA CLI

Usage:
  trylayout init [options]
  trylayout run --target-url <url> [options]
  layout-qa run --target-url <url> [options]
  npx @trylayout/qa run --target-url <url> [options]
  npx layout-qa run --target-url <url> [options]

Commands:
  init                  Write a starter .layout/qa.json.
  run                   Run browser QA and write a local HTML report.

Options:
  --target-url <url>     URL of the running frontend to test.
  --scenario <name>      Scenario to activate. Defaults to happy_path.
  --flows <path>         Flow manifest path. Defaults to .layout/qa.json.
  --out <path>           Artifact directory. Defaults to .layout/runs.
  --viewport <value>     Viewport preset or size. Use desktop, tablet, mobile, or WIDTHxHEIGHT. Defaults to desktop.
  --timeout <ms>         Browser run timeout. Defaults to LAYOUT_QA_TEST_TIMEOUT_MS or 60000.
  --headed               Show the browser instead of running headless.
  --open                 Open the generated local HTML report after the run.
  --json                 Print machine-readable JSON.
  --upload-url <url>     Upload completed run JSON/screenshots to Layout.
  --upload-token <token> Layout organization upload token for hosted reports.
  --repo <name>          Repository full name, e.g. owner/repo.
  --branch <name>        Branch name for report metadata.
  --commit-sha <sha>     Commit SHA for report metadata.
  --pr-number <number>   Pull request number for report metadata.
  --run-id <id>          Existing Layout run id to update after workflow_dispatch.
  --run-source <value>   local or github_actions. Defaults from environment.
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
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const timeoutValue = readFlag(args, '--timeout');
  const parsedTimeoutMs = timeoutValue ? Number(timeoutValue) : undefined;
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

  return {
    command,
    targetUrl: readFlag(args, '--target-url'),
    scenario: readFlag(args, '--scenario') || 'happy_path',
    flowsPath: readFlag(args, '--flows'),
    outDir: readFlag(args, '--out'),
    uploadUrl: readFlag(args, '--upload-url') || envValue('LAYOUT_UPLOAD_URL'),
    uploadToken:
      readFlag(args, '--upload-token') || envValue('LAYOUT_UPLOAD_TOKEN'),
    repo:
      readFlag(args, '--repo') ||
      envValue('LAYOUT_REPOSITORY') ||
      envValue('GITHUB_REPOSITORY'),
    branch: readFlag(args, '--branch') || envValue('LAYOUT_BRANCH') || inferBranch(),
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
    viewport: parseViewport(readFlag(args, '--viewport')),
    timeoutMs: parsedTimeoutMs,
    headed: hasFlag(args, '--headed'),
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
  process.stdout.write(`Created ${manifestPath}\n`);
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
                `Upload failed (${res.statusCode || 'unknown'}): ${
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
  if (!input.options.uploadUrl && !input.options.uploadToken) return null;
  if (!input.options.uploadUrl || !input.options.uploadToken) {
    throw new Error('--upload-url and --upload-token must be provided together.');
  }

  const prNumber =
    input.options.prNumber || (await githubEventPullRequestNumber());
  const reportDataUrl = await readFileAsDataUrl(input.artifacts.reportPath);

  return postJson({
    url: input.options.uploadUrl,
    token: input.options.uploadToken,
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

async function runCommand(options: CliOptions) {
  if (!options.targetUrl) {
    throw new Error('--target-url is required.');
  }

  const {flows, manifestPath, manifestFound} = await loadFlows({
    flowsPath: options.flowsPath,
    scenario: options.scenario,
  });
  const results: QaTestRunResult[] = [];

  for (const flow of flows) {
    try {
      results.push(
        await runLayoutQaBrowser({
          targetUrl: options.targetUrl,
          scenario: options.scenario,
          flow,
          timeoutMs: options.timeoutMs || getTestTimeoutMs(),
          headless: !options.headed,
          viewport: options.viewport,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(buildRunnerErrorResult(message, options.viewport));
    }
  }
  const result = combineFlowRunResults(results);

  const artifacts = await writeArtifacts({
    outDir: options.outDir,
    scenario: options.scenario,
    targetUrl: options.targetUrl,
    manifestPath,
    manifestFound,
    result,
  });
  const passed = isQaRunPassed(result);
  const uploadResponse = await uploadRun({
    options,
    result,
    artifacts,
    manifestPath,
    manifestFound,
    passed,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: passed ? 'passed' : 'failed',
          scenario: options.scenario,
          targetUrl: options.targetUrl,
          viewport: options.viewport,
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
      scenario: options.scenario,
      targetUrl: options.targetUrl,
      manifestPath,
      manifestFound,
      artifacts,
    });
  }

  if (options.open) {
    await openReport(artifacts.reportPath);
  }

  if (uploadResponse && !options.json) {
    process.stdout.write(
      `Uploaded: ${String(uploadResponse.reportUrl || uploadResponse.runId)}\n`
    );
  }

  process.exitCode = passed ? 0 : 1;
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

  if (options.command === 'run') {
    await runCommand(options);
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
