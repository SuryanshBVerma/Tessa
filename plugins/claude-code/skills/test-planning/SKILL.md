---
name: test-planning
description: How Tessa turns an analysed story into a test plan in the neutral test format (test IR) - coverage rules, persona and permission matrices, choosing steps and selectors, naming, de-duplication and size. Use after story-analysis, before save_plan.
---

<!-- tessa-generated: written by tessa-qa 0.9.1 from skills/test-planning/SKILL.md. Edits are overwritten; change .tessa/config.yaml or the source instead. -->

# Test planning

Write the plan as one JSON object in the test IR format (`schemas/test-ir.schema.json`) and
save it with `save_plan`. `save_plan` checks the schema, the personas, the seed profiles and
the criterion ids, and tells you about uncovered criteria; fix every error it reports.

## What a good plan looks like

- **Every acceptance criterion is covered** by at least one test, listed in that test's
  `criteria`. A criterion with personas that must _not_ do something gets a negative test for
  at least one excluded persona.
- **Each test proves one thing.** Its `intent` says what, in one or two sentences, in terms of
  the story ("Proves a viewer cannot reach the new ticket form, through the UI or the URL").
- **Small.** Usually 3–8 tests per story and 3–10 steps per test. More tests are justified only
  by distinct criteria, personas or edges, never by rewording the same check.
- **No near-duplicates.** If two tests share most of their steps, merge them or make the
  difference the point of the second test. The report flags overlap, but avoid it here.
- **Independent.** Each test starts from its own `preconditions` (a fresh seed, a start path)
  and does not rely on another test having run first.

## Building a test

```json
{
  "id": "viewer-cannot-create",
  "name": "Viewer cannot open the new ticket form",
  "intent": "Proves the create permission is enforced in navigation and on the server.",
  "criteria": ["ac-3"],
  "persona": "viewer",
  "tags": ["permissions"],
  "preconditions": { "seed_profile": "default", "start_path": "/tickets" },
  "steps": [ ... ]
}
```

- `id`: lowercase, dashes, unique in the plan, and stable: describe the behaviour, not the
  order (`editor-closes-ticket`, not `test-2`).
- `persona`: one from config. `seed_profile`: the one that gives this test the data it needs.
- `start_path`: where the test begins. Prefer it over a first `navigate` step.
- `tags`: optional, for filtering: `happy-path`, `permissions`, `validation`, `edge`.

### Steps

Each step has an `action`, a plain-language `description` shown in the report, and what the
action needs:

| Action                      | Needs                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| `navigate`                  | `value`: a path starting with `/`                                             |
| `click`, `check`, `uncheck` | `target`                                                                      |
| `fill`, `select`            | `target`, and `value` (or `value_env` for anything secret)                    |
| `wait`                      | `target` or `assertion`                                                       |
| `assert`                    | `assertion`, plus `target` unless the kind is `url-matches` or `title-equals` |

End every test with at least one `assert` on the outcome the intent promises. Assert what the
user would see, not implementation details. Add `expected` in plain words on asserts that
matter, so failures read well.

Never put passwords, tokens or personal data in a plan. Use `value_env` with an environment
variable name, and the executor will ask the user to type the value.

### Targets: choose the most stable selector

1. `testid`: a `data-testid` the code actually has. Best.
2. `role` with `name`: an ARIA role and accessible name, such as a button labelled "Save".
3. `label`: the visible label of a form field.
4. `placeholder`: only for inputs without labels.
5. `text`: visible text, only when nothing above exists.
6. `css`: last resort. `save_plan` warns about it.

Take selectors from the app, never from memory. Use `story_context` and
`selectors_for_component` (the `ui-flow-discovery` skill) for the real routes, `data-testid`
values, roles and labels. Only if the context tools cannot answer, read the route and
component files within `context.static_map.include`. A pattern such as `ticket-row-*` means you
pick a concrete id from the seed data (`ticket-row-2`). If the element you need has no stable
selector, use the best available and add an open question suggesting a `data-testid`.

`save_plan` checks every target and path against the frontend map and warns about any it
cannot find. Treat those warnings as mistakes to fix, unless you can name why the map cannot
see the element (it comes from a package, or its id is computed).

### Assertions

`visible`, `hidden`, `enabled`, `disabled`, `checked`, `unchecked` need no `expected`.
`text-equals`, `text-contains`, `value-equals`, `title-equals` take a string. `url-matches`
takes a regular expression for the path and query (`^/tickets/[0-9]+$`). `count-equals` takes a
number; `count-equals 0` is the way to assert something is absent.

## Persona and permission matrix

For permission stories, lay out personas against the guarded actions before writing tests:

```
                create  close  manage users
viewer            ✗       ✗        ✗
editor            ✓       ✓        ✗
admin             ✓       ✓        ✓
```

Cover every ✓ the story is about with a positive test, and at least one ✗ per action with a
negative test that checks both that the control is absent and that the URL is refused.

## Before saving

- Re-read each test against its criterion: would a pass actually prove it?
- Check every target against the code you read.
- Then call `save_plan` with the whole plan, and fix any error it returns.
