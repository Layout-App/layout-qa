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
        check.passed ? 'Pass' : 'Fail'
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
      --bg: #ffffff;
      --surface: #f5f5f7;
      --surface-strong: #fbfbfd;
      --line: #d2d2d7;
      --line-soft: #e8e8ed;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --blue: #06c;
      --green: #248a3d;
      --red: #d70015;
      --amber: #b25000;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      line-height: 1.47059;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 56px 28px 72px; }
    header.page {
      display: flex;
      justify-content: space-between;
      gap: 32px;
      align-items: flex-start;
      border-bottom: 1px solid var(--line-soft);
      padding-bottom: 36px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 {
      font-size: clamp(2.75rem, 7vw, 5.5rem);
      line-height: .95;
      font-weight: 500;
      letter-spacing: 0;
    }
    h2 { font-size: 1.375rem; line-height: 1.2; font-weight: 500; margin-bottom: 18px; }
    h3 { font-size: 1.0625rem; line-height: 1.25; font-weight: 500; }
    section { margin-top: 42px; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .eyebrow {
      color: var(--muted);
      font-size: .8125rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 10px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 1px;
      margin-top: 32px;
      border: 1px solid var(--line-soft);
      border-radius: 14px;
      overflow: hidden;
      background: var(--line-soft);
    }
    .metric, .panel, .step, .issue {
      background: var(--surface-strong);
    }
    .metric { padding: 18px 20px; min-width: 0; }
    .metric dt { color: var(--muted); font-size: .8125rem; }
    .metric dd { margin: 5px 0 0; font-weight: 500; overflow-wrap: anywhere; }
    .panel {
      padding: 22px;
      border: 1px solid var(--line-soft);
      border-radius: 14px;
    }
    .stack { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
    .row {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      gap: 16px;
      padding: 14px 0;
      border-top: 1px solid var(--line-soft);
    }
    .row:first-child { border-top: 0; padding-top: 0; }
    .row:last-child { padding-bottom: 0; }
    .row-title { font-weight: 500; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: .9375rem; overflow-wrap: anywhere; }
    .detail { margin-top: 10px; color: #424245; overflow-wrap: anywhere; }
    .break { word-break: break-all; }
    .status { font-size: .8125rem; font-weight: 500; padding-top: 2px; }
    .status.passed { color: var(--green); }
    .status.failed { color: var(--red); }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--line-soft);
      padding: 5px 10px;
      font-size: .875rem;
      font-weight: 500;
      text-transform: capitalize;
      white-space: nowrap;
      background: var(--surface);
    }
    .badge.passed { color: var(--green); }
    .badge.failed { color: var(--red); }
    .badge.skipped { color: var(--amber); }
    .badge.hero { font-size: 1rem; padding: 8px 14px; }
    .step {
      padding: 22px;
      margin-top: 16px;
      border: 1px solid var(--line-soft);
      border-radius: 14px;
    }
    .step-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .screenshot-link {
      display: block;
      margin-top: 18px;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: white;
      box-shadow: 0 12px 36px rgba(0, 0, 0, .06);
    }
    .screenshot-link:hover { text-decoration: none; }
    img { display: block; width: 100%; height: auto; }
    .issue {
      padding: 16px;
      border: 1px solid #ffd7d9;
      border-radius: 12px;
      background: #fff7f7;
    }
    .next { background: var(--surface); }
    .empty { color: var(--muted); }
    .footer {
      margin-top: 42px;
      padding-top: 20px;
      border-top: 1px solid var(--line-soft);
      color: var(--muted);
      font-size: .9375rem;
      overflow-wrap: anywhere;
    }
    ul:not(.stack) { margin: 14px 0 0; padding-left: 1.2rem; color: #424245; }
    li + li { margin-top: 6px; }
    @media (max-width: 760px) {
      main { padding: 34px 18px 48px; }
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
