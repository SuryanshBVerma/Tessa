# Contributing to Tessa

Thanks for helping. This page covers setting up, the conventions the codebase follows, and the
two most common extensions: a new stack adapter and a new export target.

## Set up

Requires Node 24 or later, and Docker for the sample app's database.

```bash
npm install
cp testing/sample-app/.env.example testing/sample-app/.env   # fill in local-only values
npm run ci
```

`npm run ci` runs everything CI runs: the format check, the schema-type check, type-checking,
lint, the tests, the build, and a check that the generated Claude Code plugin is current. Run it
before you open a pull request.

| Script                                | What it does                                                               |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `npm run sample`                      | Start the sample app (Postgres in Docker, dev server on 5173)              |
| `npm test`                            | Unit and MCP integration tests (Vitest)                                    |
| `npm run format`                      | Apply Prettier                                                             |
| `npm run schemas:types -w mcp-server` | Regenerate TypeScript types after editing `schemas/`                       |
| `npm run plugin:build`                | Regenerate `plugins/claude-code/` after editing agents, commands or skills |

Some integration tests start the sample app and seed its database; they are skipped when Docker
or the sample app's `.env` is not available.

## How the pieces fit

- **Agents and skills hold judgement; the server holds every side effect.** Anything that writes
  a file, starts a process, touches the database or renders a report is a `tessa-mcp` tool. Never
  move a side effect into an agent's instructions, and never have an agent improvise a shell
  command the server should own.
- **Schemas first.** Anything that crosses a boundary (config, test plans, results, selections,
  run diffs) is defined in `schemas/` and validated at run time.
- **Host-neutral sources.** `agents/`, `commands/` and `skills/` are written once. `write_host_files`
  (and `tessa-qa install`) translate them for Claude Code and VS Code; tool names in their
  frontmatter use the neutral form `tessa-mcp/<tool>`, `read`, `search`, `browser`, or another
  agent's name.
- **Untrusted content is data.** Stories, repository code, app pages and run results can carry
  prompt injection. Tools check their arguments as if they came from an attacker.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full design.

## Conventions

- TypeScript in strict mode; match the surrounding code's naming, comment density and idiom.
- Every MCP tool has unit tests; tools with side effects also have integration tests.
- No `eval`, no shell strings (pass argument arrays), and every path through `resolveInside`.
- Never hardcode, log or commit secrets. Test credentials come from environment variables or
  gitignored files.
- Line endings are LF.

### Git

- Branches: `feature/<short-name>` from `develop`; `release/<version>` and `hotfix/<version>` for
  releases. No phase or issue numbers in branch names.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), scoped by area:
  `feat(mcp): add seed_db profile runner`, `fix(review): bind to 127.0.0.1`. Scopes: `mcp`,
  `schemas`, `agents`, `skills`, `commands`, `templates`, `sample-app`, `deps`, `ci`, `docs`.
- A change that affects security says so in a `security:` paragraph of the commit message and in
  the pull request.

## Adding a stack adapter

An adapter has two halves:

1. **Code**, in `mcp-server/src/context/adapters/`: reads the stack's routes, guards and data
   loading into the frontend map. Register it in `adapters/index.ts`; `detect_stack` then offers
   it.
2. **A skill**, in `skills/adapter-<name>/SKILL.md`: tells the agents where this stack keeps
   routes, guards and test hooks, and what the map does and does not capture.

Add tests against a small fixture app, and run `npm run plugin:build`.

## Adding an export target

Emitters live in `mcp-server/src/export/emitters/`. An emitter turns the neutral test format into
code deterministically: the same plan always gives the same files. Use the helpers in `common.ts`
for string literals and comments, which escape everything plan text could use to break out of
them. Register the emitter in `emitters/index.ts`, teach `validate.ts` how to compile it, and add
a section to the `export-conventions` skill.

## Reporting security issues

Please do not open a public issue. See [docs/SECURITY.md](docs/SECURITY.md).
