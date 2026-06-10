export type QaTestRunCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
};

export type QaTestRunIssue = {
  type: 'console_error' | 'page_error' | 'request_failed' | 'assertion';
  message: string;
  source?: string;
};

export type QaTestRunNextAction = {
  category:
    | 'ready'
    | 'auth_boundary'
    | 'fixtures'
    | 'flow'
    | 'target_unreachable'
    | 'browser_errors';
  title: string;
  detail: string;
  nextSteps: string[];
  docsPath?: string;
};

export type QaTestRunFlowStepResult = {
  id: string;
  type: string;
  label?: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
  url?: string;
  durationMs?: number;
  screenshotDataUrl?: string;
  screenshotBytes?: number;
};

export type QaViewport = {
  id: string;
  width: number;
  height: number;
};

export type QaTestRunFlowResult = {
  id: string;
  name: string;
  source: 'manifest' | 'default';
  steps: QaTestRunFlowStepResult[];
};

export type QaTestRunResult = {
  finalUrl?: string;
  title?: string;
  scenarioActive?: string;
  controlsPresent?: boolean;
  screenshotDataUrl?: string;
  screenshotBytes?: number;
  bodyTextSample?: string;
  viewport?: QaViewport;
  checks: QaTestRunCheck[];
  issues: QaTestRunIssue[];
  flow?: QaTestRunFlowResult;
  nextAction?: QaTestRunNextAction;
};

export type QaFlowStep = {
  id: string;
  type: string;
  label?: string;
  text?: string;
  selector?: string;
  value?: string;
  url?: string;
  contains?: string;
  exact?: boolean;
  screenshot?: boolean;
  timeoutMs?: number;
  tolerance?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
};

export type QaFlowDefinition = {
  id: string;
  name: string;
  startUrl: string;
  scenarios: string[];
  steps: QaFlowStep[];
};

export type LoadedQaFlow = QaFlowDefinition & {
  source: 'manifest' | 'default';
};

export type ArtifactSummary = {
  runDir: string;
  resultPath: string;
  reportPath: string;
  screenshots: string[];
};
