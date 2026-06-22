# Layout QA

[![npm](https://img.shields.io/npm/v/@trylayout/qa?label=npm)](https://www.npmjs.com/package/@trylayout/qa)
[![CI](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

Layout QA is frontend QA for coding agents.

The paid product is API-first: send Layout a GitHub repository, branch/ref, and
natural-language intent. Get back concrete UI, UX, and state issues your agent
can fix.

The open-source package also includes a local QA protocol and runner. Repos can
add `.layout/qa.json` when they want faster, deterministic, higher-confidence
local or hosted QA. The protocol is optional for the API, but useful when a team
wants to make its frontend easier for agents and CI to verify.

## Primary Agent Flow

Get an API key:

```bash
npx @trylayout/qa setup --open
export LAYOUT_API_KEY="lqa_key_..."
```

Ask Layout for a verdict:

```bash
npx @trylayout/qa test "test the changed checkout flow" \
  --repo owner/repo \
  --ref feature-branch \
  --wait \
  --json
```

Check progress later:

```bash
npx @trylayout/qa status <run_id> --wait --json
```

## Optional Open Protocol

Use the local protocol when you want deterministic browser checks without a
Layout account, or when you want the hosted API to have a clearer repo contract.

Create starter protocol files:

```bash
npx @trylayout/qa init
```

Run the whole manifest-defined local session:

```bash
npx @trylayout/qa install-browsers
npx @trylayout/qa check --start-app --skip-install --open
```

Run against an already-running app:

```bash
npx @trylayout/qa check \
  --target-url http://localhost:5173 \
  --scenario happy_path \
  --open
```

Start only the built-in mock API:

```bash
npx @trylayout/qa mock-api --scenario happy_path
```

Each local run writes:

```text
.layout/runs/<timestamp-scenario-viewport>/
  index.html
  result.json
  screenshots/
```

The CLI exits `0` on pass and `1` on failure.

## Commands

Primary API commands:

```text
trylayout setup [options]
trylayout test "intent" --repo <owner/repo> --ref <branch> [options]
trylayout status <run_id> [options]
```

Open protocol commands:

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
--open             Open the web setup page or generated local HTML report.
--api-url <url>    Layout API base URL. Defaults to https://api.trylayout.com/v1/qa.
--api-key <key>    Layout organization API key.
--repo <name>      Repository full name, e.g. owner/repo.
--ref <name>       Branch/ref for an API run. Defaults to --branch.
--branch <name>    Alias for --ref.
--commit-sha <sha> Commit SHA metadata.
--run-id <id>      Layout run id for status checks.
--intent <text>    Natural-language QA intent.
--wait             Poll until the verdict is ready.
--timeout <ms>     Wait timeout.
```

Protocol/local options:

```text
--target-url <url> URL of the running frontend to test.
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
--force            Overwrite an existing flow file during init.
```

## Protocol Manifest

Default path: `.layout/qa.json`.

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
            {"screenshot": "Home loaded", "expect": {"text": ["Dashboard"]}}
          ]
        }
      ]
    }
  }
}
```

The protocol gives Layout and local agents a deterministic way to know how to
start the frontend, provide safe API data, and capture important UI states.

## Package Names

- Canonical npm package: `@trylayout/qa`
- Convenience npm alias: `layout-qa`
- CLI binaries: `trylayout` and `layout-qa`

Issues and examples are welcome in [GitHub Issues](https://github.com/Layout-App/layout-qa/issues).
