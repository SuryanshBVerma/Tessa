# Tessa

Tessa is an agentic tester for VS Code. It reads a user story and the implementation,
seeds a local database, tests the app in a browser like a manual tester, and produces an HTML
report whose selected tests export to your own test framework.

Status: early development, not yet usable.

- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Development

Requires Node 24+ and Docker.

```bash
npm install
npm run ci       # format check, type-check, lint, tests, build
npm run sample   # start the sample app Tessa tests against
```

See [testing/sample-app/README.md](testing/sample-app/README.md) for the sample app's setup, roles and seed profiles.

## Licence

[MIT](LICENSE)
