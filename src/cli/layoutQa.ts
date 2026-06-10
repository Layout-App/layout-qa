#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import {
  FLOW_MANIFEST_PATH,
  getTestTimeoutMs,
  loadFlow,
  resolveDefaultPath,
  starterFlowManifest,
} from '../flows';
import {buildRunnerErrorResult, isQaRunPassed, runLayoutQaBrowser} from '../runner';
import {openReport, writeArtifacts} from '../report';
import {ArtifactSummary, QaTestRunResult, QaViewport} from '../types';
import {formatViewport, parseViewport} from '../viewports';

type CliOptions = {
  command: string;
  targetUrl: string;
  scenario: string;
  flowsPath: string;
  outDir: string;
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
  init                  Write a starter .layout/qa-flows.json.
  run                   Run browser QA and write a local HTML report.

Options:
  --target-url <url>     URL of the running frontend to test.
  --scenario <name>      Scenario to activate. Defaults to happy_path.
  --flows <path>         Flow manifest path. Defaults to .layout/qa-flows.json.
  --out <path>           Artifact directory. Defaults to .layout/runs.
  --viewport <value>     Viewport preset or size. Use desktop, tablet, mobile, or WIDTHxHEIGHT. Defaults to desktop.
  --timeout <ms>         Browser run timeout. Defaults to LAYOUT_QA_TEST_TIMEOUT_MS or 60000.
  --headed               Show the browser instead of running headless.
  --open                 Open the generated local HTML report after the run.
  --json                 Print machine-readable JSON.
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

function parseArgs(args: string[]): CliOptions {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const timeoutValue = readFlag(args, '--timeout');
  const parsedTimeoutMs = timeoutValue ? Number(timeoutValue) : undefined;

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

function printHumanSummary(input: {
  result: QaTestRunResult;
  scenario: string;
  targetUrl: string;
  manifestPath: string;
  manifestFound: boolean;
  artifacts: ArtifactSummary;
}) {
  const passed = isQaRunPassed(input.result);
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
      `Flow: ${input.result.flow?.name || 'None'} (${
        input.result.flow?.source || 'none'
      })\n` +
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

  if (input.result.flow?.steps.length) {
    process.stdout.write('\nFlow steps:\n');
    for (const step of input.result.flow.steps) {
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

  const flow = clean.flow as {steps?: Record<string, unknown>[]} | undefined;
  for (const step of flow?.steps || []) {
    delete step.screenshotDataUrl;
  }

  return clean;
}

async function runCommand(options: CliOptions) {
  if (!options.targetUrl) {
    throw new Error('--target-url is required.');
  }

  const {flow, manifestPath, manifestFound} = await loadFlow({
    flowsPath: options.flowsPath,
    scenario: options.scenario,
  });
  let result: QaTestRunResult;

  try {
    result = await runLayoutQaBrowser({
      targetUrl: options.targetUrl,
      scenario: options.scenario,
      flow,
      timeoutMs: options.timeoutMs || getTestTimeoutMs(),
      headless: !options.headed,
      viewport: options.viewport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = buildRunnerErrorResult(message, options.viewport);
  }

  const artifacts = await writeArtifacts({
    outDir: options.outDir,
    scenario: options.scenario,
    targetUrl: options.targetUrl,
    manifestPath,
    manifestFound,
    result,
  });
  const passed = isQaRunPassed(result);

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
