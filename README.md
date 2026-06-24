# Layout QA

[![npm](https://img.shields.io/npm/v/@trylayout/qa?label=npm)](https://www.npmjs.com/package/@trylayout/qa)
[![CI](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

Layout QA is an open source frontend QA protocol for coding agents.

It gives agents a repeatable way to set up a frontend, run browser checks,
capture screenshots, and report concrete visual, UX, and state issues from the
active coding session.

## Primary Agent Flow

Set up the repo once:

```bash
npx @trylayout/qa setup
```

Run a QA pass:

```bash
npx @trylayout/qa test "test the changed checkout flow" --json
```

Each run writes:

```text
.layout/runs/<timestamp-scenario-viewport>/
  index.html
  result.json
  screenshots/
```

The CLI exits `0` on pass and `1` on failure.

## Commands

Primary commands:

```text
trylayout setup [options]
trylayout test "intent" [options]
```

Remote PR check commands:

```text
trylayout pr setup [options]
trylayout pr run "intent" --repo <owner/repo> --ref <branch> [options]
trylayout pr status <run_id> [options]
```

Protocol commands:

```text
trylayout init [options]
trylayout check [flow_id ...] [options]
trylayout install-browsers
trylayout mock-api [options]
trylayout run --target-url <url> [options]
```

Use `npx @trylayout/qa <command>` when running without installing. The
`layout-qa` package and binary are equivalent aliases.

## Common Options

```text
--json             Print machine-readable JSON.
--open             Open generated local HTML reports. With setup, open docs.
--intent <text>    Natural-language QA intent metadata.
--timeout <ms>     Browser run timeout.
--branch <name>    Branch name for report metadata.
--commit-sha <sha> Commit SHA metadata.
```

Remote PR options:

```text
--api-url <url>    Layout API base URL. Defaults to https://api.trylayout.com/v1/qa.
--api-key <key>    Layout organization API key. Defaults to LAYOUT_API_KEY.
--repo <name>      Repository full name, e.g. owner/repo.
--ref <name>       Branch/ref for a PR check. Defaults to --branch.
--run-id <id>      Layout run id for status checks.
--wait             Poll until the PR check is ready.
```

Protocol/local options:

```text
--target-url <url> URL of an already-running frontend to test.
--scenario <name>  Scenario to activate. Defaults to happy_path.
--flows <path>     Flow manifest path. Defaults to .layout/qa.json.
--app <name>       App key from manifest apps.<name>.
--mock-root <path> Mock service root.
--port <number>    Port for mock-api or a single service.
--out <path>       Artifact directory. Defaults to .layout/runs.
--viewport <value> Viewport preset or size: desktop, tablet, mobile, or WIDTHxHEIGHT.
--headed           Show the browser instead of running headless.
--start-app        Start the app from .layout/qa.json before local checks.
--serve-mocks      Start manifest services before local checks.
--skip-install     With --start-app, skip app.install.
--force            Overwrite starter protocol files during setup/init.
```

## Protocol Manifest

Default path: `.layout/qa.json`.

`trylayout setup` creates a starter manifest and starter mock API scenarios.
Edit the app command, QA environment, and flows so future agents can reproduce
the same checks.

```json
{
  "version": 1,
  "apps": {
    "app": {
      "root": ".",
      "install": "npm ci",
      "start": "npm run dev -- --host 127.0.0.1 --port $PORT",
      "healthUrl": "http://127.0.0.1:$PORT/",
      "services": {
        "api": {
          "type": "generated",
          "root": ".layout/api",
          "scenario": "happy_path"
        }
      },
      "env": {
        "VITE_API_BASE_URL": "$services.api.url"
      },
      "flows": [
        {
          "id": "smoke",
          "label": "Smoke",
          "steps": [
            {"visit": "/"},
            {"screenshot": "Home loaded", "expect": {"noConsoleErrors": true}}
          ]
        }
      ]
    }
  },
  "viewports": ["desktop"]
}
```

## Running Against An Existing Server

If the app is already running, skip the manifest start command:

```bash
npx @trylayout/qa test "check the current page" \
  --target-url http://localhost:5173 \
  --json
```

## Remote PR Checks

The hosted product is a GitHub PR check, not a dashboard workflow. GitHub is the
system of record; the Layout dashboard is only for inspecting screenshots, logs,
and run details when a compact PR check is not enough.

Generate a GitHub Actions workflow:

```bash
npx @trylayout/qa pr setup
```

Add `LAYOUT_API_KEY` as a GitHub repository secret, then open a pull request.
The generated workflow calls Layout remotely and fails the GitHub check when
Layout finds issues or cannot complete the run.

Run the same remote check manually:

```bash
npx @trylayout/qa pr run "test this pull request" \
  --repo owner/repo \
  --ref feature-branch \
  --wait \
  --json
```

## Lower-Level Checks

Run explicit manifest flows:

```bash
npx @trylayout/qa check smoke --start-app --skip-install --json
```

Start only the built-in mock API:

```bash
npx @trylayout/qa mock-api --scenario happy_path
```

Install Chromium if Playwright asks for a browser:

```bash
npx @trylayout/qa install-browsers
```

## Package Names

- Canonical npm package: `@trylayout/qa`
- Convenience npm alias: `layout-qa`
- CLI binaries: `trylayout` and `layout-qa`

Issues and examples are welcome in [GitHub Issues](https://github.com/Layout-App/layout-qa/issues).
