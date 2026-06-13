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
  QaViewport,
} from './types';
import {
  DEFAULT_TEST_TIMEOUT_MS,
  FLOW_MANIFEST_PATH,
  QA_DOCS_URL,
  SCREENSHOT_LIMIT_BYTES,
} from './flows';
import {DEFAULT_VIEWPORT, formatViewport} from './viewports';

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
      label: 'Scenario flag is available',
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
        'Layout could not reach the target page well enough to evaluate deterministic response states.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Start the app or deploy preview URL before running Layout QA.',
        'Use the URL where the frontend is served with the Layout QA env flag enabled.',
        'Retry the same scenario after the target URL is reachable from the runner.',
      ],
    };
  }

  if (failedCheckIds.has('scenario_ready')) {
    return {
      category: 'fixtures',
      title: 'Scenario flag was not active',
      detail:
        'The page loaded, but Layout could not confirm that the requested scenario was available.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Confirm the target is running with the Layout QA env flag set to 1.',
        'Check that the app reads localStorage["layout.qa.scenario"] before API calls run.',
        `Review ${FLOW_MANIFEST_PATH}, the Layout QA docs, and the API/auth response fixtures for missing handlers.`,
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
        'The target loaded with deterministic responses, but a declared QA flow step failed.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        `Inspect ${FLOW_MANIFEST_PATH} and confirm the failing step still matches the app UI.`,
        'Update selectors, visible text assertions, or scenario responses so the flow follows real user behavior.',
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
        'The target loaded with deterministic responses, but browser errors or failed requests were observed.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        'Inspect the issues captured on this QA run.',
        'Add or correct fixtures for unhandled frontend API/auth requests.',
        'Fix app code that throws under the selected scenario, then rerun.',
      ],
    };
  }

  if (appearsToBePublicOrAuthSurface(input.bodyTextSample)) {
    return {
      category: 'auth_boundary',
      title: 'Public surface reached; wire deterministic auth next',
      detail:
        'The run passed the basic browser checks, but the page appears to be a logged-out or public surface. Authenticated flows need a deterministic auth boundary before Layout can test them end to end.',
      docsPath: FLOW_MANIFEST_PATH,
      nextSteps: [
        `Use ${FLOW_MANIFEST_PATH} and the Layout QA docs to add or confirm a central auth boundary for QA runs.`,
        'Expose a deterministic user/session only when the Layout QA env flag is enabled.',
        'Point the next QA run at an authenticated route and rerun happy_path, empty, and error scenarios.',
      ],
    };
  }

  return {
    category: 'ready',
    title: 'Ready for deeper flow coverage',
    detail:
      'The target loaded with the requested scenario and no basic browser issues were detected.',
    docsPath: FLOW_MANIFEST_PATH,
    nextSteps: [
      `Add route-specific Playwright-style flow steps to ${FLOW_MANIFEST_PATH} for the highest-value user path.`,
      'Expand deterministic API/auth responses for any requests encountered by that flow.',
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

function stepLocator(
  page: Page,
  step: QaFlowStep,
  exact: boolean,
  requiredField: string
) {
  if (step.selector) {
    return page.locator(step.selector).first();
  }

  const text = requireStepValue(step.text, requiredField);
  return page.getByText(text, {exact}).first();
}

function formatBox(box: {x: number; y: number; width: number; height: number}) {
  return `${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(
    box.x
  )},${Math.round(box.y)}`;
}

async function assertNoHorizontalOverflow(page: Page, tolerance = 1) {
  const result = (await page.evaluate(checkTolerance => {
    function elementLabel(element: Element) {
      const tagName = element.tagName.toLowerCase();
      const testId =
        element.getAttribute('data-testid') ||
        element.getAttribute('data-qa') ||
        '';
      if (testId) return `${tagName}[data-qa/testid="${testId}"]`;
      if (element.id) return `${tagName}#${element.id}`;
      const className = Array.from(element.classList).slice(0, 3).join('.');
      return className ? `${tagName}.${className}` : tagName;
    }

    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const scrollWidth = Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0);
    const overflowPx = Math.max(0, scrollWidth - viewportWidth);
    const offenders = Array.from(document.body?.querySelectorAll('*') || [])
      .map(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const rightOverflow = Math.max(0, rect.right - viewportWidth);
        const leftOverflow = Math.max(0, -rect.left);
        const elementOverflowPx = Math.max(rightOverflow, leftOverflow);
        if (elementOverflowPx <= checkTolerance) return null;

        return {
          label: elementLabel(element),
          x: Math.round(rect.x),
          width: Math.round(rect.width),
          right: Math.round(rect.right),
          overflowPx: Math.round(elementOverflowPx),
        };
      })
      .filter(
        (
          entry
        ): entry is {
          label: string;
          x: number;
          width: number;
          right: number;
          overflowPx: number;
        } => Boolean(entry)
      )
      .sort((a, b) => b.overflowPx - a.overflowPx)
      .slice(0, 5);

    return {
      viewportWidth,
      scrollWidth,
      overflowPx,
      offenders,
    };
  }, tolerance)) as {
    viewportWidth: number;
    scrollWidth: number;
    overflowPx: number;
    offenders: {
      label: string;
      x: number;
      width: number;
      right: number;
      overflowPx: number;
    }[];
  };

  if (result.overflowPx > tolerance) {
    const offenderDetail = result.offenders.length
      ? ` Offenders: ${result.offenders
          .map(
            offender =>
              `${offender.label} overflowed ${offender.overflowPx}px (x=${offender.x}, width=${offender.width}, right=${offender.right})`
          )
          .join('; ')}.`
      : '';
    throw new Error(
      `Horizontal overflow detected: document width ${result.scrollWidth}px exceeds viewport ${result.viewportWidth}px by ${result.overflowPx}px.${offenderDetail}`
    );
  }

  return `No horizontal overflow: document width ${result.scrollWidth}px, viewport ${result.viewportWidth}px.`;
}

async function assertElementInViewport(input: {
  page: Page;
  step: QaFlowStep;
  exact: boolean;
  timeoutMs: number;
}) {
  const locator = stepLocator(
    input.page,
    input.step,
    input.exact,
    'selector or text'
  );
  await locator.waitFor({state: 'visible', timeout: input.timeoutMs});

  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error('Expected element to have a visible nonzero layout box.');
  }

  const viewport = input.page.viewportSize();
  if (!viewport) {
    throw new Error('Could not read the current browser viewport size.');
  }

  const tolerance = input.step.tolerance ?? 1;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const visibleWidth = Math.min(right, viewport.width) - Math.max(box.x, 0);
  const visibleHeight = Math.min(bottom, viewport.height) - Math.max(box.y, 0);

  if (visibleWidth <= tolerance || visibleHeight <= tolerance) {
    throw new Error(
      `Expected element to intersect viewport ${viewport.width}x${viewport.height}, got box ${formatBox(
        box
      )}.`
    );
  }

  return `Element intersects viewport ${viewport.width}x${viewport.height}: ${formatBox(
    box
  )}.`;
}

function definedBoxConstraints(step: QaFlowStep) {
  return [
    ['minWidth', step.minWidth],
    ['maxWidth', step.maxWidth],
    ['minHeight', step.minHeight],
    ['maxHeight', step.maxHeight],
  ] as const;
}

async function assertElementBox(input: {
  page: Page;
  step: QaFlowStep;
  exact: boolean;
  timeoutMs: number;
}) {
  const constraints = definedBoxConstraints(input.step).filter(
    ([, value]) => value !== undefined
  );
  if (constraints.length === 0) {
    throw new Error(
      'assert_box requires at least one of minWidth, maxWidth, minHeight, or maxHeight.'
    );
  }

  const locator = stepLocator(
    input.page,
    input.step,
    input.exact,
    'selector or text'
  );
  await locator.waitFor({state: 'visible', timeout: input.timeoutMs});

  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error('Expected element to have a visible nonzero layout box.');
  }

  const failures: string[] = [];
  if (input.step.minWidth !== undefined && box.width < input.step.minWidth) {
    failures.push(
      `width ${Math.round(box.width)}px is below minWidth ${
        input.step.minWidth
      }px`
    );
  }
  if (input.step.maxWidth !== undefined && box.width > input.step.maxWidth) {
    failures.push(
      `width ${Math.round(box.width)}px is above maxWidth ${
        input.step.maxWidth
      }px`
    );
  }
  if (input.step.minHeight !== undefined && box.height < input.step.minHeight) {
    failures.push(
      `height ${Math.round(box.height)}px is below minHeight ${
        input.step.minHeight
      }px`
    );
  }
  if (input.step.maxHeight !== undefined && box.height > input.step.maxHeight) {
    failures.push(
      `height ${Math.round(box.height)}px is above maxHeight ${
        input.step.maxHeight
      }px`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Element box ${formatBox(box)} failed constraints: ${failures.join('; ')}.`
    );
  }

  return `Element box matched constraints: ${formatBox(box)}.`;
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
  issues: QaTestRunIssue[];
}) {
  const stepTimeout = input.step.timeoutMs || Math.min(input.timeoutMs, 10000);
  const exact = input.step.exact === true;
  const withExpectations = async (detail: string) => {
    const expectationDetails: string[] = [];

    for (const text of input.step.expectText || []) {
      await input.page
        .getByText(text, {exact})
        .first()
        .waitFor({state: 'visible', timeout: stepTimeout});
      expectationDetails.push(`Visible text found: ${text}`);
    }

    if (input.step.expectNoConsoleErrors) {
      const browserErrors = input.issues.filter(entry =>
        ['console_error', 'page_error'].includes(entry.type)
      );
      if (browserErrors.length > 0) {
        throw new Error(
          `Expected no console/page errors, found ${browserErrors.length}.`
        );
      }
      expectationDetails.push('No console/page errors observed.');
    }

    return [detail, ...expectationDetails].filter(Boolean).join(' ');
  };

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
    return withExpectations(`Navigated to ${target}`);
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
    return withExpectations(`Visible text found: ${text}`);
  }

  if (input.step.type === 'click') {
    if (input.step.selector) {
      await input.page
        .locator(input.step.selector)
        .click({timeout: stepTimeout});
      return withExpectations(`Clicked selector: ${input.step.selector}`);
    }

    const text = requireStepValue(input.step.text, 'text or selector');
    await input.page.getByText(text, {exact}).click({timeout: stepTimeout});
    return withExpectations(`Clicked text: ${text}`);
  }

  if (input.step.type === 'fill') {
    const selector = requireStepValue(input.step.selector, 'selector');
    await input.page
      .locator(selector)
      .fill(input.step.value || '', {timeout: stepTimeout});
    return withExpectations(`Filled selector: ${selector}`);
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
    return withExpectations(`URL matched: ${currentUrl}`);
  }

  if (input.step.type === 'assert_no_horizontal_overflow') {
    return withExpectations(
      await assertNoHorizontalOverflow(input.page, input.step.tolerance ?? 1)
    );
  }

  if (input.step.type === 'assert_in_viewport') {
    return withExpectations(
      await assertElementInViewport({
        page: input.page,
        step: input.step,
        exact,
        timeoutMs: stepTimeout,
      })
    );
  }

  if (input.step.type === 'assert_box') {
    return withExpectations(
      await assertElementBox({
        page: input.page,
        step: input.step,
        exact,
        timeoutMs: stepTimeout,
      })
    );
  }

  if (input.step.type === 'screenshot') {
    return withExpectations('Captured screenshot checkpoint.');
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
        issues: input.issues,
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
  viewport?: QaViewport;
}) {
  const timeoutMs = input.timeoutMs || DEFAULT_TEST_TIMEOUT_MS;
  const viewport = input.viewport || DEFAULT_VIEWPORT;
  const issues: QaTestRunIssue[] = [];
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: input.headless !== false});

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {width: viewport.width, height: viewport.height},
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
      viewport,
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

export function buildRunnerErrorResult(
  message: string,
  viewport: QaViewport = DEFAULT_VIEWPORT
): QaTestRunResult {
  return {
    viewport,
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
        'Confirm the app is served with the Layout QA env flag enabled.',
        'Retry after the target loads consistently in a browser.',
        `Viewport used for this run: ${formatViewport(viewport)}.`,
      ],
    },
  };
}

export function isQaRunPassed(result: QaTestRunResult) {
  return result.checks.every(check => check.passed);
}
