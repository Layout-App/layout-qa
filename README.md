# Layout QA

Layout QA is a local browser QA protocol and runner for AI-built frontends. It runs deterministic flows against a local or preview URL, captures screenshots at meaningful checkpoints, checks browser health, and writes a static HTML report.

The core loop is intentionally local:

```bash
npx @trylayout/qa init
npx @trylayout/qa run --target-url http://localhost:5173 --scenario happy_path --open
```

No account, upload, hosted service, or external docs are required.

## Why This Exists

Frontend agents can move faster when they have a visual feedback loop they can run themselves. Layout gives the agent a small protocol:

- Wire deterministic API/auth mocks behind a local env flag such as `VITE_LAYOUT_QA_MOCKS=1`.
- Switch mock states with `localStorage["layout.qa.scenario"]`.
- Declare high-value browser flows in `.layout/qa-flows.json`.
- Run the CLI locally and inspect the generated screenshots/report.

The goal is not to replace Playwright. The goal is to make the browser QA loop simple enough for a coding agent to set up, run, and iterate on while building a frontend branch.

## Install

Use it directly with `npx`:

```bash
npx @trylayout/qa run --target-url http://localhost:5173
```

Or install it in a project:

```bash
npm install --save-dev @trylayout/qa
npx trylayout run --target-url http://localhost:5173
```

The package uses Playwright. If your environment does not already have Chromium installed for Playwright, run:

```bash
npx playwright install chromium
```

## Quick Start

Create a starter flow manifest:

```bash
npx @trylayout/qa init
```

Start your app with whatever mock flag your project uses:

```bash
VITE_LAYOUT_QA_MOCKS=1 npm run dev
```

Run a scenario:

```bash
npx @trylayout/qa run \
  --target-url http://localhost:5173 \
  --scenario happy_path \
  --open
```

Each run writes:

```text
.layout/runs/<timestamp-scenario>/
  index.html
  result.json
  screenshots/
    01-<step>.jpg
    final.jpg
```

The process exits `0` on pass and `1` on failure, so the same command can run in CI.

## Commands

```text
trylayout init [options]
trylayout run --target-url <url> [options]
```

Options:

```text
--target-url <url>     URL of the running frontend to test.
--scenario <name>      Mock scenario to activate. Defaults to happy_path.
--flows <path>         Flow manifest path. Defaults to .layout/qa-flows.json.
--out <path>           Artifact directory. Defaults to .layout/runs.
--timeout <ms>         Browser run timeout. Defaults to 60000.
--headed               Show the browser instead of running headless.
--open                 Open the generated local HTML report after the run.
--json                 Print machine-readable JSON.
--force                Overwrite an existing flow file during init.
```

## Flow Manifest

Default path: `.layout/qa-flows.json`.

```json
{
  "schemaVersion": 1,
  "flows": [
    {
      "id": "workspace_smoke",
      "name": "Workspace smoke",
      "startUrl": "/",
      "scenarios": ["happy_path"],
      "steps": [
        {
          "id": "workspace_loaded",
          "type": "assert_visible_text",
          "text": "Dashboard",
          "screenshot": true
        },
        {
          "id": "open_settings",
          "type": "click",
          "text": "Settings",
          "screenshot": true
        }
      ]
    }
  ]
}
```

Top-level fields:

- `schemaVersion`: currently `1`.
- `flows`: array of flow definitions.

Flow fields:

- `id`: stable machine-readable flow id.
- `name`: human-readable report title.
- `startUrl`: path or absolute URL where the flow starts.
- `scenarios`: scenario names this flow can run against. Use an empty array to allow all scenarios.
- `steps`: ordered browser steps.

Step fields:

- `id`: stable machine-readable step id.
- `type`: step type.
- `label`: optional human-readable report label.
- `screenshot`: set `true` to capture a screenshot after the step.
- `timeoutMs`: optional per-step timeout.

Supported step types:

- `goto`: navigate to `url`.
- `click`: click by `selector` or visible `text`.
- `fill`: fill a `selector` with `value`.
- `assert_visible_text`: require visible `text`.
- `wait_for_text`: alias for a visible text wait.
- `assert_url`: require current URL to equal `url` or contain `contains`.
- `screenshot`: capture a screenshot checkpoint.

Examples:

```json
{ "id": "open_settings", "type": "click", "text": "Settings" }
```

```json
{ "id": "email", "type": "fill", "selector": "input[name='email']", "value": "layout@example.com" }
```

```json
{ "id": "settings_url", "type": "assert_url", "contains": "/settings" }
```

## Mock Scenarios

Before the app loads, the runner sets:

```js
localStorage.setItem("layout.qa.scenario", "<scenario>");
sessionStorage.setItem("layout.qa.runner", "1");
```

Your app can use `layout.qa.scenario` to switch deterministic mock states:

- `happy_path`: normal populated data.
- `empty`: successful responses with empty states.
- `error`: failed or error responses that should render recovery UI.

The `layout.qa.runner` flag is useful for hiding local-only QA switchers from screenshots.

## Agent Setup Prompt

Paste this into your coding agent inside the frontend repo:

```text
Set up Layout QA for this web app.

Goal:
Create a local-only browser QA loop that an agent can run while changing frontend code.

Rules:
- Do not add a standalone mock server.
- Do not require a hosted Layout service.
- Keep all mock data local to this app.
- Gate mocks behind a local-only env flag such as VITE_LAYOUT_QA_MOCKS=1, NEXT_PUBLIC_LAYOUT_QA_MOCKS=1, or the framework-appropriate equivalent.
- Use localStorage["layout.qa.scenario"] to select at least happy_path, empty, and error mock states.
- Hide any local QA switcher or debug controls when sessionStorage["layout.qa.runner"] === "1".

Implementation:
- Add deterministic API fixtures for the highest-value frontend route.
- If the app has a central auth/session abstraction, add a deterministic mock user only when the Layout QA env flag is enabled.
- If auth is scattered or provider-SDK-only, leave a clear note in the PR/code comments and start with public or logged-out flows.
- Add .layout/qa-flows.json with one smoke flow for the most important page.
- Prefer visible text and stable selectors.
- Add screenshot checkpoints after meaningful user-visible states.

Run:
npx @trylayout/qa run --target-url <local app url> --scenario happy_path --open
npx @trylayout/qa run --target-url <local app url> --scenario empty --open
npx @trylayout/qa run --target-url <local app url> --scenario error --open
```

## CI Example

```yaml
name: Layout QA

on:
  pull_request:

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install chromium
      - run: VITE_LAYOUT_QA_MOCKS=1 npm run dev -- --host 127.0.0.1 --port 5173 &
      - run: npx @trylayout/qa run --target-url http://127.0.0.1:5173 --scenario happy_path
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: layout-qa-report
          path: .layout/runs
```

## Current Scope

This package is intentionally small:

- It does run Playwright against an already-running frontend.
- It does write local screenshots and an HTML report.
- It does support deterministic scenario switching.
- It does not build or host your app.
- It does not upload results.
- It does not perform AI review by itself.

Those hosted/reporting layers can be added later without changing the local protocol.
