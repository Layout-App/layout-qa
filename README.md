# Layout QA

Layout QA is a local browser QA protocol and runner for AI-built frontends. It runs deterministic Playwright-style flows against a local or preview URL, captures the screenshot sequence, checks browser health, and writes a static HTML report.

The core loop is intentionally local:

```bash
npx @trylayout/qa init
npx @trylayout/qa run --target-url http://localhost:5173 --scenario happy_path --open
```

## Why this exists

Frontend agents can move faster when they have a visual feedback loop they can run themselves. Layout gives the agent a small protocol:

- Wire app mocks behind a local env flag such as `VITE_LAYOUT_QA_MOCKS=1`.
- Keep deterministic API/auth scenarios in the app repo.
- Declare high-value browser flows in `.layout/qa-flows.json`.
- Run the CLI locally and inspect the generated screenshots/report.

Layout does not require uploading screenshots or source code. Hosted reports, PR comments, and AI review notes can be layered on later.

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

The package uses Playwright. If your environment does not already have the browser binaries, run:

```bash
npx playwright install chromium
```

## Commands

Initialize a starter flow file:

```bash
npx @trylayout/qa init
```

Run a flow:

```bash
npx @trylayout/qa run \
  --target-url http://localhost:5173 \
  --scenario happy_path \
  --open
```

Useful options:

```text
--target-url <url>     URL of the running frontend to test.
--scenario <name>      Mock scenario to activate. Defaults to happy_path.
--flows <path>         Flow manifest path. Defaults to .layout/qa-flows.json.
--out <path>           Artifact directory. Defaults to .layout/runs.
--timeout <ms>         Browser run timeout. Defaults to 60000.
--headed               Show the browser instead of running headless.
--open                 Open the generated local HTML report after the run.
--json                 Print machine-readable JSON.
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

## Flow Manifest

Default path: `.layout/qa-flows.json`.

```json
{
  "$schema": "https://trylayout.com/schemas/qa-flows.v1.json",
  "docsUrl": "https://trylayout.com/docs/qa",
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
        }
      ]
    }
  ]
}
```

Supported step types:

- `goto`: navigate to `url`.
- `click`: click by `selector` or visible `text`.
- `fill`: fill a `selector` with `value`.
- `assert_visible_text`: require visible `text`.
- `wait_for_text`: alias for a visible text wait.
- `assert_url`: require current URL to equal `url` or contain `contains`.
- `screenshot`: capture a screenshot checkpoint.

The runner sets these before the app loads:

```js
localStorage.setItem("layout.qa.scenario", "<scenario>");
sessionStorage.setItem("layout.qa.runner", "1");
```

Your app can use `layout.qa.scenario` to switch deterministic mock states. The `layout.qa.runner` flag is useful for hiding local-only QA switchers from screenshots.

## Agent Setup Prompt

Paste this into your coding agent inside the frontend repo:

```text
Set up Layout QA for this web app.

Docs: https://trylayout.com/docs/qa
Flow schema: https://trylayout.com/schemas/qa-flows.v1.json

Add deterministic mock API/auth states behind a local-only env flag such as VITE_LAYOUT_QA_MOCKS=1. Use the scenario key localStorage["layout.qa.scenario"] with at least happy_path, empty, and error states. Keep mocks inside the app test/dev setup; do not add a standalone mock server.

Add .layout/qa-flows.json with one smoke flow for the highest-value page and screenshot checkpoints after meaningful user-visible states. Prefer visible text and stable selectors. Hide any local QA scenario switcher when sessionStorage["layout.qa.runner"] === "1".

Then run:
npx @trylayout/qa run --target-url <local app url> --scenario happy_path --open
```

## npm Publishing

This repo is configured for a public scoped npm package:

```bash
npm login
npm publish --access public
```

If the `@trylayout` npm scope does not exist yet, create it in npm first, then rerun publish from this repo.
