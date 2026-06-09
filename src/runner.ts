import type {Page} from 'playwright';
import {URL} from 'url';
import {
  LoadedQaFlow,
  QaFlowStep,
  QaTestRunCheck,
  QaTestRunFlowResult,
  QaTestRunFlowStepResult,
  QaTestRunIssue,
  QaTestRunNextAction,
  QaTestRunResult,
} from './types';
import {
  DEFAULT_TEST_TIMEOUT_MS,
  FLOW_MANIFEST_PATH,
  QA_DOCS_URL,
  SCREENSHOT_LIMIT_BYTES,
} from './flows';

function truncate(value: string, maxLength = 1000) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function issue(input: QaTestRunIssue): QaTestRunIssue {
  return {
    ...input,
    message: truncate(input.message, 1200),
    source: input.source ? truncate(input.source, 600) : undefined,
  };
}

function isExpectedMockErrorScenarioConsole(input: {
  scenario: string;
  message: string;
  source?: string;
}) {
  return (
    input.scenario === 'error' &&
    /^Failed to load resource: the server responded with a status of [45]\d\d\b/.test(
      input.message
    ) &&
    /\/api\//.test(input.source || '')
  );
}

function buildChecks(input: {
  responseStatus: number | null;
  bodyTextSample: string;
  controlsPresent: boolean;
  scenarioActive: string;
  scenario: string;
  issues: QaTestRunIssue[];
  flow?: QaTestRunFlowResult;
}) {
  const pageLoaded =
    input.responseStatus === null ||
    (input.responseStatus >= 200 && input.responseStatus < 500);
  const appRendered = input.bodyTextSample.trim().length > 20;
  const scenarioReady =
    input.scenarioActive === input.scenario || input.controlsPresent;
  const consoleErrorCount = input.issues.filter(
    entry => entry.type === 'console_error'
  ).length;
  const pageErrorCount = input.issues.filter(
    entry => entry.type === 'page_error'
  ).length;
  const failedRequestCount = input.issues.filter(
    entry => entry.type === 'request_failed'
  ).length;
  const flowSteps = input.flow?.steps || [];
  const failedFlowStepCount = flowSteps.filter(
    step => step.status === 'failed'
  ).length;

  const checks: QaTestRunCheck[] = [
    {
      id: 'page_loaded',
      label: 'Target page loaded',
      passed: pageLoaded,
      detail:
        input.responseStatus === null
          ? 'No HTTP response status was available after navigation.'
          : `HTTP ${input.responseStatus}`,
    },
    {
      id: 'app_rendered',
      label: 'Page rendered visible content',
      passed: appRendered,
      detail: `${input.bodyTextSample.trim().length} visible text characters`,
    },
    {
      id: 'scenario_ready',
      label: 'Mock scenario is available',
      passed: scenarioReady,
      detail: input.controlsPresent
        ? `Layout QA controls detected; requested ${input.scenario}.`
        : `Active scenario: ${input.scenarioActive || 'unknown'}`,
    },
    {
      id: 'no_page_errors',
      label: 'No uncaught browser errors',
      passed: pageErrorCount === 0,
      detail: `${pageErrorCount} page errors`,
    },
    {
      id: 'no_console_errors',
      label: 'No console errors',
      passed: consoleErrorCount === 0,
      detail: `${consoleErrorCount} console errors`,
    },
    {
      id: 'no_failed_requests',
      label: 'No failed network requests',
      passed: failedRequestCount === 0,
      detail: `${failedRequestCount} failed requests`,
    },
  ];

  if (flowSteps.length > 0) {
    checks.push({
      id: 'flow_steps',
      label: 'Flow steps passed',
      passed: failedFlowStepCount === 0,
      detail: `${flowSteps.length - failedFlowStepCount}/${
        flowSteps.length
      } flow steps passed`,
    });
  }

  return checks;
}

function appearsToBePublicOrAuthSurface(bodyText: string) {
  return /(^|\b)(sign in|sign up|log in|get started|continue with google|create account)(\b|$)/i.test(
    bodyText
  );
}

function buildNextAction(input: {
  checks: QaTestRunCheck[];
  issues: QaTestRunIssue[];
  bodyTextSample: string;
  scenario: string;
  scenarioActive: string;
  controlsPresent: boolean;
  flow?: QaTestRunFlowResult;
}): QaTestRunNextAction {
  const failedChecks = input.checks.filter(check => !check.passed);
  const failedCheckIds = new Set(failedChecks.map(check => check.id));

  if (failedCheckIds.has('page_loaded')) {
    return {
      category: 'target_unreachable',
      title: 'Target URL did not load cleanly',
      detail:
        'Layout could not reach the target page well enough to evaluate mock states.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Start the app or deploy preview URL before running Layout QA.',
        'Use the URL where the frontend is served with the Layout mock env flag enabled.',
        'Retry the same scenario after the target URL is reachable from the runner.',
      ],
    };
  }

  if (failedCheckIds.has('scenario_ready')) {
    return {
      category: 'fixtures',
      title: 'Mock scenario was not active',
      detail:
        'The page loaded, but Layout could not confirm that the requested mock scenario was available.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Confirm the target is running with the Layout mock env flag set to 1.',
        'Check that the app reads localStorage["layout.qa.scenario"] before API calls run.',
        `Review ${FLOW_MANIFEST_PATH}, the Layout QA docs, and the fixture file for missing handlers.`,
      ],
    };
  }

  if (failedCheckIds.has('flow_steps')) {
    const failedStep = input.flow?.steps.find(step => step.status === 'failed');
    return {
      category: 'flow',
      title: 'Flow step needs review',
      detail:
        failedStep?.detail ||
        'The target loaded with mocks, but a declared QA flow step failed.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        `Inspect ${FLOW_MANIFEST_PATH} and confirm the failing step still matches the app UI.`,
        'Update selectors, visible text assertions, or scenario fixtures so the flow follows real user behavior.',
        `Use ${QA_DOCS_URL} for the supported flow step schema.`,
      ],
    };
  }

  if (
    failedCheckIds.has('no_page_errors') ||
    failedCheckIds.has('no_console_errors') ||
    failedCheckIds.has('no_failed_requests')
  ) {
    return {
      category: 'browser_errors',
      title: 'Browser errors need review',
      detail:
        'The target loaded with mocks, but browser errors or failed requests were observed.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Inspect the issues captured on this QA run.',
        'Add or correct fixtures for unhandled frontend API requests.',
        'Fix app code that throws under the selected mock scenario, then rerun.',
      ],
    };
  }

  if (appearsToBePublicOrAuthSurface(input.bodyTextSample)) {
    return {
      category: 'auth_boundary',
      title: 'Public surface reached; wire mock auth next',
      detail:
        'The run passed the basic mock-browser checks, but the page appears to be a logged-out or public surface. Authenticated flows need a mockable auth boundary before Layout can test them end to end.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        `Use ${FLOW_MANIFEST_PATH} and the Layout QA docs to add or confirm a central mock auth boundary.`,
        'Expose a deterministic mock user/session only when the Layout mock env flag is enabled.',
        'Point the next QA run at an authenticated route and rerun happy_path, empty, and error scenarios.',
      ],
    };
  }

  return {
    category: 'ready',
    title: 'Ready for deeper flow coverage',
    detail:
      'The target loaded with the requested mock scenario and no basic browser issues were detected.',
    docsPath: FLOW_MANIFEST_PATH,
    nextSteps: [
      `Add route-specific Playwright-style flow steps to ${FLOW_MANIFEST_PATH} for the highest-value user path.`,
      'Expand fixtures for any API calls encountered by that flow.',
      'Run the same flow across happy_path, empty, and error scenarios.',
    ],
  };
}

function resolveTargetUrl(targetUrl: string, stepUrl: string) {
  if (/^https?:\/\//i.test(stepUrl)) return stepUrl;
  const base = new URL(targetUrl);
  if (stepUrl.startsWith('/')) {
    return `${base.origin}${stepUrl}`;
  }
  return new URL(stepUrl || '.', targetUrl).toString();
}

async function captureStepScreenshot(page: Page) {
  const screenshot = await page.screenshot({
    type: 'jpeg',
    quality: 65,
    fullPage: false,
  });

  return {
    screenshotBytes: screenshot.byteLength,
    screenshotDataUrl:
      screenshot.byteLength <= SCREENSHOT_LIMIT_BYTES
        ? `data:image/jpeg;base64,${screenshot.toString('base64')}`
        : undefined,
  };
}

function requireStepValue(value: string | undefined, field: string) {
  if (!value) {
    throw new Error(`Flow step is missing required ${field}.`);
  }
  return value;
}

async function caseSensitiveGoto(
  page: Page,
  targetUrl: string,
  timeoutMs: number
) {
  return page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
}

async function executeFlowStep(input: {
  page: Page;
  step: QaFlowStep;
  targetUrl: string;
  timeoutMs: number;
}) {
  const stepTimeout = input.step.timeoutMs || Math.min(input.timeoutMs, 10000);
  const exact = input.step.exact === true;

  if (input.step.type === 'goto') {
    const target = resolveTargetUrl(
      input.targetUrl,
      requireStepValue(input.step.url, 'url')
    );
    await caseSensitiveGoto(input.page, target, stepTimeout);
    await input.page
      .waitForLoadState('networkidle', {timeout: 5000})
      .catch(() => {
        // DOM assertions after the step are the source of truth.
      });
    return `Navigated to ${target}`;
  }

  if (
    input.step.type === 'assert_visible_text' ||
    input.step.type === 'wait_for_text'
  ) {
    const text = requireStepValue(input.step.text, 'text');
    await input.page
      .getByText(text, {exact})
      .first()
      .waitFor({state: 'visible', timeout: stepTimeout});
    return `Visible text found: ${text}`;
  }

  if (input.step.type === 'click') {
    if (input.step.selector) {
      await input.page
        .locator(input.step.selector)
        .click({timeout: stepTimeout});
      return `Clicked selector: ${input.step.selector}`;
    }

    const text = requireStepValue(input.step.text, 'text or selector');
    await input.page.getByText(text, {exact}).click({timeout: stepTimeout});
    return `Clicked text: ${text}`;
  }

  if (input.step.type === 'fill') {
    const selector = requireStepValue(input.step.selector, 'selector');
    await input.page
      .locator(selector)
      .fill(input.step.value || '', {timeout: stepTimeout});
    return `Filled selector: ${selector}`;
  }

  if (input.step.type === 'assert_url') {
    const currentUrl = input.page.url();
    if (input.step.contains && !currentUrl.includes(input.step.contains)) {
      throw new Error(
        `Expected URL to contain ${input.step.contains}, got ${currentUrl}.`
      );
    }
    if (
      input.step.url &&
      currentUrl !== resolveTargetUrl(input.targetUrl, input.step.url)
    ) {
      throw new Error(`Expected URL ${input.step.url}, got ${currentUrl}.`);
    }
    return `URL matched: ${currentUrl}`;
  }

  if (input.step.type === 'screenshot') {
    return 'Captured screenshot checkpoint.';
  }

  throw new Error(`Unsupported flow step type: ${input.step.type}`);
}

async function runFlow(input: {
  page: Page;
  flow: LoadedQaFlow;
  targetUrl: string;
  timeoutMs: number;
  issues: QaTestRunIssue[];
}): Promise<QaTestRunFlowResult> {
  const steps: QaTestRunFlowStepResult[] = [];

  for (const step of input.flow.steps) {
    const startedAt = Date.now();
    const result: QaTestRunFlowStepResult = {
      id: step.id,
      type: step.type,
      label: step.label,
      status: 'passed',
    };

    try {
      result.detail = await executeFlowStep({
        page: input.page,
        step,
        targetUrl: input.targetUrl,
        timeoutMs: input.timeoutMs,
      });
      result.url = input.page.url();

      if (step.screenshot || step.type === 'screenshot') {
        Object.assign(result, await captureStepScreenshot(input.page));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.detail = message;
      result.url = input.page.url();
      Object.assign(result, await captureStepScreenshot(input.page));
      input.issues.push(
        issue({
          type: 'assertion',
          message,
          source: `${FLOW_MANIFEST_PATH}#${input.flow.id}.${step.id}`,
        })
      );
      steps.push({
        ...result,
        durationMs: Date.now() - startedAt,
      });
      break;
    }

    steps.push({
      ...result,
      durationMs: Date.now() - startedAt,
    });
  }

  return {
    id: input.flow.id,
    name: input.flow.name,
    source: input.flow.source,
    steps,
  };
}

export async function runLayoutQaBrowser(input: {
  targetUrl: string;
  scenario: string;
  flow: LoadedQaFlow;
  timeoutMs?: number;
  headless?: boolean;
}) {
  const timeoutMs = input.timeoutMs || DEFAULT_TEST_TIMEOUT_MS;
  const issues: QaTestRunIssue[] = [];
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: input.headless !== false});

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {width: 1280, height: 900},
    });
    await context.addInitScript({
      content: `
        window.localStorage.setItem('layout.qa.scenario', ${JSON.stringify(
          input.scenario
        )});
        window.sessionStorage.setItem('layout.qa.runner', '1');
      `,
    });

    const page = await context.newPage();
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (
        isExpectedMockErrorScenarioConsole({
          scenario: input.scenario,
          message: message.text(),
          source: message.location().url,
        })
      ) {
        return;
      }
      issues.push(
        issue({
          type: 'console_error',
          message: message.text(),
          source: message.location().url,
        })
      );
    });
    page.on('pageerror', error => {
      issues.push(
        issue({
          type: 'page_error',
          message: error.message,
          source: error.stack,
        })
      );
    });
    page.on('requestfailed', request => {
      const url = request.url();
      if (/\/favicon\.(ico|png|svg)$/i.test(url)) return;
      issues.push(
        issue({
          type: 'request_failed',
          message: request.failure()?.errorText || 'Request failed',
          source: url,
        })
      );
    });

    const response = await caseSensitiveGoto(
      page,
      resolveTargetUrl(input.targetUrl, input.flow.startUrl),
      timeoutMs
    );
    await page.waitForLoadState('networkidle', {timeout: 8000}).catch(() => {
      // Many apps keep long-lived connections open; DOM checks below are enough.
    });
    const flowResult = await runFlow({
      page,
      flow: input.flow,
      targetUrl: input.targetUrl,
      timeoutMs,
      issues,
    });
    const pageState = (await page.evaluate(`(() => {
        const scenarioStorageKey = 'layout.qa.scenario';
        const bodyText = document.body?.innerText || '';
        const controls = document.getElementById(
          'layout-qa-scenario-controls'
        );
        return {
          title: document.title,
          finalUrl: window.location.href,
          bodyTextSample: bodyText.trim().slice(0, 1200),
          controlsPresent: Boolean(controls),
          scenarioActive:
            window.localStorage.getItem(scenarioStorageKey) || '',
        };
      })()`)) as {
      title: string;
      finalUrl: string;
      bodyTextSample: string;
      controlsPresent: boolean;
      scenarioActive: string;
    };
    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 65,
      fullPage: false,
    });
    const screenshotDataUrl =
      screenshot.byteLength <= SCREENSHOT_LIMIT_BYTES
        ? `data:image/jpeg;base64,${screenshot.toString('base64')}`
        : undefined;
    const checks = buildChecks({
      responseStatus: response?.status() || null,
      bodyTextSample: pageState.bodyTextSample,
      controlsPresent: pageState.controlsPresent,
      scenarioActive: pageState.scenarioActive,
      scenario: input.scenario,
      issues,
      flow: flowResult,
    });

    return {
      finalUrl: pageState.finalUrl,
      title: pageState.title,
      scenarioActive: pageState.scenarioActive,
      controlsPresent: pageState.controlsPresent,
      screenshotDataUrl,
      screenshotBytes: screenshot.byteLength,
      bodyTextSample: pageState.bodyTextSample,
      checks,
      issues: issues.slice(0, 20),
      flow: flowResult,
      nextAction: buildNextAction({
        checks,
        issues,
        bodyTextSample: pageState.bodyTextSample,
        scenario: input.scenario,
        scenarioActive: pageState.scenarioActive,
        controlsPresent: pageState.controlsPresent,
        flow: flowResult,
      }),
    };
  } finally {
    await browser.close().catch(() => {
      // Best-effort cleanup.
    });
  }
}

export function buildRunnerErrorResult(message: string): QaTestRunResult {
  return {
    checks: [
      {
        id: 'runner_error',
        label: 'Runner completed',
        passed: false,
        detail: message,
      },
    ],
    issues: [
      issue({
        type: 'assertion',
        message,
      }),
    ],
    nextAction: {
      category: 'target_unreachable',
      title: 'Runner could not complete',
      detail: message,
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Confirm the target URL is reachable by the runner.',
        'Confirm the app is served with the Layout mock env flag enabled.',
        'Retry after the target loads consistently in a browser.',
      ],
    },
  };
}

export function isQaRunPassed(result: QaTestRunResult) {
  return result.checks.every(check => check.passed);
}
