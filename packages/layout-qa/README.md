# layout-qa

`layout-qa` is a convenience alias for the canonical package `@trylayout/qa`.

Both package names expose the same open source frontend QA protocol:

```bash
npx layout-qa setup
npx @trylayout/qa setup
npx layout-qa test "test checkout recovery" --json
npx @trylayout/qa test "test checkout recovery" --json
npx layout-qa check --target-url http://localhost:5173 --scenario happy_path --open
npx @trylayout/qa check --target-url http://localhost:5173 --scenario happy_path --open
npx layout-qa mock-api --scenario happy_path
npx @trylayout/qa mock-api --scenario happy_path
```

Use the main README for full documentation:

https://github.com/Layout-App/layout-qa#readme
