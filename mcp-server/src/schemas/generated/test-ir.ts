// Generated from schemas/test-ir.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server


export type Id = string
export type Step = ({
[k: string]: unknown | undefined
} & {
action: ("navigate" | "click" | "fill" | "select" | "check" | "uncheck" | "wait" | "assert")
/**
 * Plain-language step shown in the report.
 */
description: string
target?: Target
/**
 * Path for navigate, text for fill, option for select.
 */
value?: string
/**
 * Environment variable holding the value, for anything that must not be written into the plan.
 */
value_env?: string
assertion?: Assertion
timeout_ms?: number
/**
 * Plain-language expected outcome shown in the report.
 */
expected?: string
} & {
action: ("navigate" | "click" | "fill" | "select" | "check" | "uncheck" | "wait" | "assert")
/**
 * Plain-language step shown in the report.
 */
description: string
target?: Target
/**
 * Path for navigate, text for fill, option for select.
 */
value?: string
/**
 * Environment variable holding the value, for anything that must not be written into the plan.
 */
value_env?: string
assertion?: Assertion
timeout_ms?: number
/**
 * Plain-language expected outcome shown in the report.
 */
expected?: string
})
/**
 * How to find an element. Prefer testid, then role, then label; css is a last resort.
 */
export type Target = ({
strategy: ("testid" | "label" | "text" | "placeholder" | "css")
value: string
exact?: boolean
} | {
strategy: "role"
/**
 * ARIA role, e.g. button, link, textbox.
 */
role: string
name?: string
exact?: boolean
})
export type Assertion = ({
kind: ("visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked")
} | {
kind: ("text-equals" | "text-contains" | "value-equals" | "url-matches" | "title-equals")
expected: string
} | {
kind: "count-equals"
expected: number
})

/**
 * Framework-neutral test plan for one story, stored at plans/<story>/tests.json. The report, the selection and every exporter read this; exported code is never written from memory.
 */
export interface TestPlan {
version: 1
story: Story
/**
 * @minItems 1
 */
tests: [Test, ...(Test)[]]
}
export interface Story {
id: Id
title: string
/**
 * Where the story came from, e.g. a file path or ticket key.
 */
source?: string
acceptance_criteria?: Criterion[]
}
export interface Criterion {
id: Id
text: string
}
export interface Test {
id: Id
name: string
/**
 * One or two sentences on what the test proves.
 */
intent: string
/**
 * Acceptance criterion IDs this test covers.
 */
criteria?: Id[]
persona: Id
tags?: Id[]
preconditions: Preconditions
/**
 * @minItems 1
 */
steps: [Step, ...(Step)[]]
}
export interface Preconditions {
seed_profile: Id
feature_flags?: {
[k: string]: boolean | undefined
}
/**
 * User settings the test expects, e.g. theme.
 */
settings?: {
[k: string]: string | number | boolean | undefined
}
start_path?: string
}
