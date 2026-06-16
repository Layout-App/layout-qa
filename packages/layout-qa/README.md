# layout-qa

`layout-qa` is a convenience alias for the canonical package `@trylayout/qa`.

Both commands are equivalent:

```bash
npx layout-qa run --target-url http://localhost:5173 --scenario happy_path --open
npx @trylayout/qa run --target-url http://localhost:5173 --scenario happy_path --open
npx layout-qa mock-api --scenario happy_path
npx @trylayout/qa mock-api --scenario happy_path
npx layout-qa remote run --repo owner/repo --ref feature-branch --api-key "$LAYOUT_API_KEY"
npx @trylayout/qa remote run --repo owner/repo --ref feature-branch --api-key "$LAYOUT_API_KEY"
```

Use the main README for full documentation:

https://github.com/Layout-App/layout-qa#readme
