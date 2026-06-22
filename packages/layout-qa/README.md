# layout-qa

`layout-qa` is a convenience alias for the canonical package `@trylayout/qa`.

Both commands are equivalent:

```bash
npx layout-qa setup --open
npx @trylayout/qa setup --open
npx layout-qa test "test checkout recovery" --repo owner/repo --ref feature-branch --api-key "$LAYOUT_API_KEY"
npx @trylayout/qa test "test checkout recovery" --repo owner/repo --ref feature-branch --api-key "$LAYOUT_API_KEY"
npx layout-qa status <run_id> --api-key "$LAYOUT_API_KEY" --json
npx @trylayout/qa status <run_id> --api-key "$LAYOUT_API_KEY" --json
npx layout-qa install-browsers
npx @trylayout/qa install-browsers
npx layout-qa check --target-url http://localhost:5173 --scenario happy_path --open
npx @trylayout/qa check --target-url http://localhost:5173 --scenario happy_path --open
npx layout-qa mock-api --scenario happy_path
npx @trylayout/qa mock-api --scenario happy_path
```

Use the main README for full documentation:

https://github.com/Layout-App/layout-qa#readme
