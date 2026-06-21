# Layout QA

[![npm](https://img.shields.io/npm/v/@trylayout/qa?label=npm)](https://www.npmjs.com/package/@trylayout/qa)
[![CI](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/Layout-App/layout-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

Layout QA is an API oracle for frontend reliability. Coding agents send Layout a
GitHub repository, branch/ref, and natural-language QA intent. Layout does the
simulation work remotely and returns a verdict with concrete issues when it can
find them.

The package is intentionally small: it is an API client for agents, not a local
test framework or report generator.

## Quick Start

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

Package names:

- Canonical npm package: `@trylayout/qa`
- Convenience npm alias: `layout-qa`
- CLI binaries: `trylayout` and `layout-qa`

These are equivalent:

```bash
npx @trylayout/qa test "test settings" --repo owner/repo --ref branch
npx layout-qa test "test settings" --repo owner/repo --ref branch
```

## Commands

```text
trylayout setup [options]
trylayout test "intent" --repo <owner/repo> --ref <branch> [options]
trylayout status <run_id> [options]
```

Options:

```text
--json             Print machine-readable JSON.
--open             Open the web setup page during setup.
--api-url <url>    Layout API base URL. Defaults to https://api.trylayout.com/v1/qa.
--api-key <key>    Layout organization API key.
--repo <name>      Repository full name, e.g. owner/repo.
--ref <name>       Branch/ref to inspect. Defaults to --branch or the current git branch.
--branch <name>    Alias for --ref.
--commit-sha <sha> Commit SHA metadata.
--run-id <id>      Layout run id for status checks.
--intent <text>    Natural-language QA intent.
--wait             Poll until the verdict is ready.
--timeout <ms>     Wait timeout. Defaults to 600000.
```

Environment fallbacks:

- `LAYOUT_API_URL`
- `LAYOUT_API_KEY`
- `LAYOUT_REPOSITORY`
- `LAYOUT_REF`
- `LAYOUT_BRANCH`
- `LAYOUT_COMMIT_SHA`
- `LAYOUT_INTENT`
- `LAYOUT_RUN_ID`

In GitHub Actions, the CLI also reads `GITHUB_REPOSITORY`, `GITHUB_HEAD_REF`,
`GITHUB_REF_NAME`, and `GITHUB_SHA` when explicit flags are not provided.

## Contract

The public contract is branch in, verdict out:

```json
{
  "repository": "owner/repo",
  "ref": "feature-branch",
  "intent": "test the changed checkout flow"
}
```

Layout may inspect code, infer runnable frontend apps, generate API fixtures,
launch a browser, review source, render isolated surfaces, compare screenshots,
or fall back to code-aware QA review. The caller should not need to maintain a
Layout manifest or local mock API to get useful feedback.

The response is optimized for coding agents:

- run id and status;
- issue count;
- concrete issues with severity, type, message, and evidence when available;
- optional screenshots or generated fixture metadata;
- setup/failure messages when Layout could not simulate enough of the app.

## Removed Local Runner

Earlier versions exposed local commands such as `check`, `run`, `init`,
`mock-api`, and `install-browsers`. Those are no longer part of the primary CLI.
Use Playwright, Vitest, or your app's own CI directly for local testing. Use
Layout when an agent wants an independent QA oracle for a branch.

## Feedback

Issues and examples are welcome in [GitHub Issues](https://github.com/Layout-App/layout-qa/issues).
