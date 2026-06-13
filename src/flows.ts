import fs from 'fs/promises';
import path from 'path';
import {LoadedQaFlow, QaFlowDefinition, QaFlowStep} from './types';

export const DEFAULT_TEST_TIMEOUT_MS = 60 * 1000;
export const SCREENSHOT_LIMIT_BYTES = 300 * 1024;
export const FLOW_MANIFEST_PATH = '.layout/qa.json';
export const QA_DOCS_URL = 'https://github.com/Layout-App/layout-qa#readme';

export function getTestTimeoutMs() {
  const value = Number(process.env.LAYOUT_QA_TEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEST_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string')
    : [];
}

function expectTextArray(value: unknown) {
  if (!isRecord(value)) return [];
  const text = value.text;
  if (typeof text === 'string') return [text];
  return stringArray(text);
}

function isLikelySelector(value: string) {
  return /^(#|\.|\[)/.test(value) || /[#.[\]:>~+]/.test(value);
}

function shortcutStep(
  value: Record<string, unknown>,
  index: number
): Partial<QaFlowStep> | null {
  if (typeof value.visit === 'string') {
    return {
      type: 'goto',
      url: value.visit.trim(),
    };
  }

  if (typeof value.click === 'string') {
    const target = value.click.trim();
    return {
      type: 'click',
      ...(isLikelySelector(target) ? {selector: target} : {text: target}),
    };
  }

  if (typeof value.screenshot === 'string' || value.screenshot === true) {
    return {
      type: 'screenshot',
      label:
        typeof value.screenshot === 'string'
          ? value.screenshot.trim()
          : `Screenshot ${index + 1}`,
      screenshot: true,
    };
  }

  return null;
}

function normalizeFlowStep(value: unknown, index: number): QaFlowStep | null {
  if (!isRecord(value)) return null;
  const shortcut = shortcutStep(value, index);
  const type = stringValue(value.type || shortcut?.type).trim();
  if (!type) return null;
  const expect = isRecord(value.expect) ? value.expect : {};
  const clickTarget = stringValue(value.click).trim();

  return {
    id:
      stringValue(value.id).trim() ||
      `${type.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${index + 1}`,
    type: type === 'visit' ? 'goto' : type,
    label: stringValue(value.label || value.name || shortcut?.label).trim(),
    text: stringValue(value.text || shortcut?.text).trim(),
    expectText: expectTextArray(value.expect),
    expectNoConsoleErrors:
      isRecord(expect) && expect.noConsoleErrors === true ? true : undefined,
    selector:
      stringValue(value.selector || shortcut?.selector).trim() ||
      (clickTarget && isLikelySelector(clickTarget) ? clickTarget : ''),
    value: stringValue(value.value),
    url: stringValue(value.url || value.path || value.visit || shortcut?.url).trim(),
    contains: stringValue(value.contains).trim(),
    exact: booleanValue(value.exact),
    screenshot: booleanValue(
      value.screenshot,
      type === 'screenshot' || shortcut?.screenshot === true
    ),
    timeoutMs: numberValue(value.timeoutMs),
    tolerance: numberValue(value.tolerance),
    minWidth: numberValue(value.minWidth),
    maxWidth: numberValue(value.maxWidth),
    minHeight: numberValue(value.minHeight),
    maxHeight: numberValue(value.maxHeight),
  };
}

function normalizeFlow(value: unknown, index: number): QaFlowDefinition | null {
  if (!isRecord(value)) return null;
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps
    .map((step, stepIndex) => normalizeFlowStep(step, stepIndex))
    .filter((step): step is QaFlowStep => Boolean(step));
  if (steps.length === 0) return null;

  const id = stringValue(value.id).trim() || `flow_${index + 1}`;
  return {
    id,
    name: stringValue(value.label || value.name).trim() || id,
    startUrl: stringValue(value.startUrl).trim() || '/',
    scenarios: stringArray(value.scenarios),
    steps,
  };
}

export function selectFlowFromManifest(raw: unknown, scenario: string) {
  return selectFlowsFromManifest(raw, scenario)[0] || null;
}

export function selectFlowsFromManifest(raw: unknown, scenario: string) {
  if (!isRecord(raw) || !Array.isArray(raw.flows)) return [];
  const flows = raw.flows
    .map((flow, index) => normalizeFlow(flow, index))
    .filter((flow): flow is QaFlowDefinition => Boolean(flow));
  if (flows.length === 0) return [];

  const selected = flows.filter(
    flow => flow.scenarios.length === 0 || flow.scenarios.includes(scenario)
  );
  return selected.length ? selected : [flows[0]];
}

export function parseFlowManifestContent(content: string, scenario: string) {
  const flow = selectFlowFromManifest(JSON.parse(content), scenario);
  return flow ? ({...flow, source: 'manifest'} as LoadedQaFlow) : null;
}

export function parseFlowsManifestContent(content: string, scenario: string) {
  return selectFlowsFromManifest(JSON.parse(content), scenario).map(
    flow => ({...flow, source: 'manifest'} as LoadedQaFlow)
  );
}

export function defaultFlow(): LoadedQaFlow {
  return {
    id: 'target_smoke',
    name: 'Target smoke',
    startUrl: '/',
    scenarios: [],
    source: 'default',
    steps: [
      {
        id: 'initial_screen',
        type: 'screenshot',
        label: 'Initial screen',
        screenshot: true,
      },
    ],
  };
}

async function exists(filePath: string) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

export async function resolveDefaultPath(defaultPath: string) {
  const cwdPath = path.resolve(process.cwd(), defaultPath);
  if (await exists(cwdPath)) return cwdPath;

  const parentPath = path.resolve(process.cwd(), '..', defaultPath);
  if (await exists(parentPath)) return parentPath;

  if (defaultPath === '.layout' || defaultPath.startsWith('.layout/')) {
    const cwdLayoutDir = path.resolve(process.cwd(), '.layout');
    const parentLayoutDir = path.resolve(process.cwd(), '..', '.layout');
    if (await exists(cwdLayoutDir)) return cwdPath;
    if (await exists(parentLayoutDir)) return parentPath;
  }

  return cwdPath;
}

export async function loadFlow(input: {flowsPath: string; scenario: string}) {
  const loaded = await loadFlows(input);
  return {
    flow: loaded.flows[0],
    manifestPath: loaded.manifestPath,
    manifestFound: loaded.manifestFound,
  };
}

export async function loadFlows(input: {flowsPath: string; scenario: string}) {
  const manifestPath = input.flowsPath
    ? path.resolve(process.cwd(), input.flowsPath)
    : await resolveDefaultPath(FLOW_MANIFEST_PATH);
  const content = await fs.readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  if (!content) {
    return {
      flows: [defaultFlow()],
      manifestPath,
      manifestFound: false,
    };
  }

  const flows = parseFlowsManifestContent(content, input.scenario);
  return {
    flows: flows.length ? flows : [defaultFlow()],
    manifestPath,
    manifestFound: flows.length > 0,
  };
}

export function starterFlowManifest() {
  return {
    version: 1,
    baseUrl: '$LAYOUT_BASE_URL',
    viewports: ['desktop'],
    flows: [
      {
        id: 'smoke',
        label: 'Smoke',
        scenarios: ['happy_path'],
        steps: [
          {
            visit: '/',
          },
          {
            screenshot: 'Initial screen',
            expect: {
              noConsoleErrors: true,
            },
          },
        ],
      },
    ],
  };
}
