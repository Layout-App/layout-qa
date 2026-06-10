import fs from 'fs/promises';
import path from 'path';
import {spawn} from 'child_process';
import {resolveDefaultPath} from './flows';
import {
  ArtifactSummary,
  QaTestRunFlowStepResult,
  QaTestRunResult,
} from './types';
import {isQaRunPassed} from './runner';
import {formatViewport} from './viewports';

export function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

export function stepScreenshotFileName(index: number, stepId: string) {
  return `${String(index + 1).padStart(2, '0')}-${safeName(stepId)}.jpg`;
}

async function writeDataUrl(filePath: string, dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return false;

  await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
  return true;
}

async function writeStepScreenshot(input: {
  screenshotsDir: string;
  index: number;
  step: QaTestRunFlowStepResult;
}) {
  if (!input.step.screenshotDataUrl) return '';

  const fileName = stepScreenshotFileName(input.index, input.step.id);
  const filePath = path.join(input.screenshotsDir, fileName);
  const written = await writeDataUrl(filePath, input.step.screenshotDataUrl);
  return written ? filePath : '';
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hrefPath(value: string) {
  return value
    .split(path.sep)
    .map(part => encodeURIComponent(part))
    .join('/');
}

function relativeHref(fromDir: string, toPath: string) {
  return hrefPath(path.relative(fromDir, toPath));
}

function renderStatusBadge(status: 'passed' | 'failed' | 'skipped') {
  return `<span class="badge ${status}">${escapeHtml(status)}</span>`;
}

function renderCheckList(result: QaTestRunResult) {
  return result.checks
    .map(
      check => `<li class="row">
        <span class="status ${check.passed ? 'passed' : 'failed'}">${
        check.passed ? 'PASS' : 'FAIL'
      }</span>
        <div>
          <p class="row-title">${escapeHtml(check.label)}</p>
          ${
            check.detail
              ? `<p class="muted">${escapeHtml(check.detail)}</p>`
              : ''
          }
        </div>
      </li>`
    )
    .join('');
}

function renderIssueList(result: QaTestRunResult) {
  if (result.issues.length === 0) {
    return '<p class="empty">No browser issues captured.</p>';
  }

  return `<ul class="stack">${result.issues
    .map(
      issue => `<li class="issue">
        <p class="row-title">${escapeHtml(issue.type)}</p>
        <p>${escapeHtml(issue.message)}</p>
        ${
          issue.source ? `<p class="muted">${escapeHtml(issue.source)}</p>` : ''
        }
      </li>`
    )
    .join('')}</ul>`;
}

function renderStepList(input: {runDir: string; result: QaTestRunResult}) {
  const steps = input.result.flow?.steps || [];
  if (steps.length === 0) return '<p class="empty">No flow steps declared.</p>';

  return steps
    .map((step, index) => {
      const screenshotHref = step.screenshotDataUrl
        ? relativeHref(
            input.runDir,
            path.join(
              input.runDir,
              'screenshots',
              stepScreenshotFileName(index, step.id)
            )
          )
        : '';

      return `<article class="step">
        <header class="step-header">
          <div>
            <p class="eyebrow">${escapeHtml(step.type)}</p>
            <h3>${escapeHtml(step.label || step.id)}</h3>
          </div>
          ${renderStatusBadge(step.status)}
        </header>
        ${step.detail ? `<p class="detail">${escapeHtml(step.detail)}</p>` : ''}
        ${step.url ? `<p class="muted break">${escapeHtml(step.url)}</p>` : ''}
        ${
          screenshotHref
            ? `<a class="screenshot-link" href="${screenshotHref}"><img src="${screenshotHref}" alt="${escapeHtml(
                step.label || step.id
              )} screenshot" /></a>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderReport(input: {
  result: QaTestRunResult;
  scenario: string;
  targetUrl: string;
  manifestPath: string;
  manifestFound: boolean;
  runDir: string;
  resultPath: string;
}) {
  const passed = isQaRunPassed(input.result);
  const finalScreenshotHref = input.result.screenshotDataUrl
    ? relativeHref(
        input.runDir,
        path.join(input.runDir, 'screenshots', 'final.jpg')
      )
    : '';
  const resultHref = relativeHref(input.runDir, input.resultPath);
  const flow = input.result.flow;
  const viewport = input.result.viewport;
  const failedCheckCount = input.result.checks.filter(
    check => !check.passed
  ).length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Layout QA ${escapeHtml(input.scenario)} ${
    passed ? 'passed' : 'failed'
  }</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --panel: #fffdf8;
      --line: #e4e1d8;
      --text: #1b1a17;
      --muted: #65635d;
      --green: #2f7a45;
      --green-bg: #e6f4ea;
      --red: #9b2c2c;
      --red-bg: #fff0f0;
      --amber: #7a5c14;
      --amber-bg: #fff5d6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 56px; }
    header.page { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 24px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1; font-weight: 600; letter-spacing: 0; }
    h2 { font-size: 1rem; font-weight: 650; margin-bottom: 12px; }
    h3 { font-size: 1rem; font-weight: 650; }
    section { margin-top: 28px; }
    a { color: inherit; }
    .eyebrow { color: var(--muted); font-size: .78rem; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-top: 24px; }
    .metric, .panel, .step, .issue {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
    }
    .metric { padding: 14px; min-width: 0; }
    .metric dt { color: var(--muted); font-size: .82rem; }
    .metric dd { margin: 4px 0 0; font-weight: 650; overflow-wrap: anywhere; }
    .panel { padding: 16px; }
    .stack { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
    .row { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
    .row:first-child { border-top: 0; padding-top: 0; }
    .row:last-child { padding-bottom: 0; }
    .row-title { font-weight: 650; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: .92rem; overflow-wrap: anywhere; }
    .detail { margin-top: 8px; color: #3f3d38; overflow-wrap: anywhere; }
    .break { word-break: break-all; }
    .status { font-size: .78rem; font-weight: 750; padding-top: 2px; }
    .status.passed { color: var(--green); }
    .status.failed { color: var(--red); }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 6px;
      border: 1px solid var(--line);
      padding: 4px 8px;
      font-size: .82rem;
      font-weight: 650;
      text-transform: capitalize;
      white-space: nowrap;
    }
    .badge.passed { color: var(--green); background: var(--green-bg); border-color: #c8e6d0; }
    .badge.failed { color: var(--red); background: var(--red-bg); border-color: #f0c9c9; }
    .badge.skipped { color: var(--amber); background: var(--amber-bg); border-color: #f0dc9f; }
    .badge.hero { font-size: .95rem; padding: 8px 12px; }
    .step { padding: 16px; margin-top: 12px; }
    .step-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .screenshot-link { display: block; margin-top: 14px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: white; }
    img { display: block; width: 100%; height: auto; }
    .issue { padding: 12px; border-color: #f0c9c9; background: #fff8f8; }
    .next { border-color: #d9d6cb; }
    .empty { color: var(--muted); }
    .footer { margin-top: 28px; color: var(--muted); font-size: .9rem; }
    @media (max-width: 760px) {
      main { padding: 24px 16px 40px; }
      header.page { display: grid; }
      .summary { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header class="page">
      <div>
        <p class="eyebrow">Layout QA report</p>
        <h1>${passed ? 'Passed' : 'Failed'}</h1>
      </div>
      <span class="badge hero ${passed ? 'passed' : 'failed'}">${
    passed ? 'passed' : 'failed'
  }</span>
    </header>

    <dl class="summary">
      <div class="metric"><dt>Scenario</dt><dd>${escapeHtml(
        input.scenario
      )}</dd></div>
      <div class="metric"><dt>Flow</dt><dd>${escapeHtml(
        flow?.name || 'None'
      )}</dd></div>
      <div class="metric"><dt>Target URL</dt><dd>${escapeHtml(
        input.targetUrl
      )}</dd></div>
      <div class="metric"><dt>Viewport</dt><dd>${escapeHtml(
        viewport ? formatViewport(viewport) : 'unavailable'
      )}</dd></div>
      <div class="metric"><dt>Final URL</dt><dd>${escapeHtml(
        input.result.finalUrl || 'unavailable'
      )}</dd></div>
    </dl>

    <section class="panel">
      <h2>Checks</h2>
      <ul class="stack">${renderCheckList(input.result)}</ul>
    </section>

    <section>
      <h2>${escapeHtml(flow?.name || 'Flow Steps')}</h2>
      ${renderStepList({runDir: input.runDir, result: input.result})}
    </section>

    ${
      finalScreenshotHref
        ? `<section>
      <h2>Final Screenshot</h2>
      <a class="screenshot-link" href="${finalScreenshotHref}"><img src="${finalScreenshotHref}" alt="Final screenshot" /></a>
    </section>`
        : ''
    }

    <section class="panel">
      <h2>Issues</h2>
      ${renderIssueList(input.result)}
    </section>

    ${
      input.result.nextAction
        ? `<section class="panel next">
      <h2>Next Action</h2>
      <p class="row-title">${escapeHtml(input.result.nextAction.title)}</p>
      <p class="detail">${escapeHtml(input.result.nextAction.detail)}</p>
      <ul>
        ${input.result.nextAction.nextSteps
          .map(step => `<li>${escapeHtml(step)}</li>`)
          .join('')}
      </ul>
    </section>`
        : ''
    }

    <p class="footer">
      ${failedCheckCount} failed checks. Manifest ${
    input.manifestFound ? escapeHtml(input.manifestPath) : 'not found'
  }. Raw result: <a href="${resultHref}">result.json</a>.
    </p>
  </main>
</body>
</html>`;
}

export async function writeArtifacts(input: {
  outDir: string;
  scenario: string;
  targetUrl: string;
  manifestPath: string;
  manifestFound: boolean;
  result: QaTestRunResult;
}): Promise<ArtifactSummary> {
  const outRoot = input.outDir
    ? path.resolve(process.cwd(), input.outDir)
    : await resolveDefaultPath('.layout/runs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const viewportId = input.result.viewport?.id || 'viewport_unknown';
  const runDir = path.join(
    outRoot,
    `${stamp}-${safeName(input.scenario)}-${safeName(viewportId)}`
  );
  const screenshotsDir = path.join(runDir, 'screenshots');
  await fs.mkdir(screenshotsDir, {recursive: true});

  const screenshots: string[] = [];
  if (input.result.screenshotDataUrl) {
    const finalPath = path.join(screenshotsDir, 'final.jpg');
    if (await writeDataUrl(finalPath, input.result.screenshotDataUrl)) {
      screenshots.push(finalPath);
    }
  }

  for (const [index, step] of (input.result.flow?.steps || []).entries()) {
    const screenshotPath = await writeStepScreenshot({
      screenshotsDir,
      index,
      step,
    });
    if (screenshotPath) screenshots.push(screenshotPath);
  }

  const resultPath = path.join(runDir, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify(input.result, null, 2));
  const reportPath = path.join(runDir, 'index.html');
  await fs.writeFile(
    reportPath,
    renderReport({
      result: input.result,
      scenario: input.scenario,
      targetUrl: input.targetUrl,
      manifestPath: input.manifestPath,
      manifestFound: input.manifestFound,
      runDir,
      resultPath,
    })
  );
  return {runDir, resultPath, reportPath, screenshots};
}

function fileUrl(filePath: string) {
  const resolved = path.resolve(filePath);
  const withForwardSlashes = resolved.split(path.sep).join('/');
  return `file://${encodeURI(
    process.platform === 'win32' && !withForwardSlashes.startsWith('/')
      ? `/${withForwardSlashes}`
      : withForwardSlashes
  )}`;
}

export async function openReport(reportPath: string) {
  const url = fileUrl(reportPath);
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

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.unref();
    resolve();
  });
}
