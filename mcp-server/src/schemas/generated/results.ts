// Generated from schemas/results.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server


/**
 * UTC timestamp, e.g. 20261016T104512Z.
 */
export type RunId = string
export type Id = string
export type Status = ("passed" | "failed" | "skipped" | "error")
export type ArtifactPath = string

/**
 * Outcome of one run, stored at runs/<run_id>/results.json. Paths are relative to the run directory.
 */
export interface RunResults {
version: 1
run_id: RunId
story_id: Id
/**
 * Path to the tests.json this run executed, relative to the artifacts root.
 */
plan: string
/**
 * UTC timestamp, e.g. 20261016T104512Z.
 */
rerun_of?: string
started_at: string
finished_at: string
environment: RunEnvironment
summary?: Summary
tests: TestResult[]
}
export interface RunEnvironment {
app_url: string
/**
 * HEAD commit; absent when the workspace is not a Git repository.
 */
commit?: string
branch?: string
/**
 * True when the working tree had uncommitted changes.
 */
dirty?: boolean
/**
 * Agent host that ran the session.
 */
host: ("vscode-agent" | "claude-code" | "other")
browser?: string
/**
 * Model actually used per role.
 */
models?: {
[k: string]: string | undefined
}
/**
 * How far the knowledge graph's indexed commit lagged HEAD.
 */
context_staleness_commits?: number
}
export interface Summary {
total: number
passed: number
failed: number
skipped: number
error: number
duration_ms?: number
}
export interface TestResult {
test_id: Id
status: Status
duration_ms?: number
attempts: number
env_state: EnvState
steps: StepResult[]
failure?: Failure
triage?: Triage
quality?: Quality
}
/**
 * Environment the test actually ran in, captured by capture_env_state.
 */
export interface EnvState {
persona: Id
role?: string
permissions?: string[]
settings?: {
[k: string]: string | number | boolean | undefined
}
feature_flags?: {
[k: string]: boolean | undefined
}
seed_profile: Id
build?: string
}
export interface StepResult {
/**
 * Zero-based index into the test's steps in the plan.
 */
index: number
status: ("passed" | "failed" | "skipped")
duration_ms?: number
screenshot?: ArtifactPath
expected?: string
actual?: string
error?: string
/**
 * Selector the executor resolved, when it differs from the plan.
 */
selector_used?: string
}
export interface Failure {
step_index: number
message: string
expected?: string
actual?: string
screenshot?: ArtifactPath
}
export interface Triage {
class: ("app-bug" | "test-selector" | "environment" | "data" | "unknown")
rationale: string
confidence: ("low" | "medium" | "high")
evidence?: string[]
}
export interface Quality {
/**
 * low when the test relies on css or text selectors.
 */
selector_stability?: ("high" | "medium" | "low")
/**
 * Fraction of attempts that produced the same status, 0 to 1.
 */
rerun_consistency?: number
/**
 * IDs of tests that cover mostly the same steps.
 */
overlap_with?: Id[]
}
