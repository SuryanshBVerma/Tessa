// Generated from schemas/run-diff.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server


export type RunId = string
export type TestDiff = {
test_id: string
change: ("fixed" | "regressed" | "still-failing" | "still-passing" | "added" | "removed" | "changed-other")
status_a?: Status
status_b?: Status
failing_step_a?: number
failing_step_b?: number
duration_delta_ms?: number
/**
 * Triage interpretation of the change.
 */
notes?: string
}
export type Status = ("passed" | "failed" | "skipped" | "error")

/**
 * Comparison of two runs, written to diffs/<run_a>__<run_b>.json. run_a is the baseline.
 */
export interface RunDiff {
version: 1
run_a: RunId
run_b: RunId
created_at: string
commit_a?: string
commit_b?: string
summary: {
fixed: number
regressed: number
still_failing: number
still_passing: number
added: number
removed: number
changed_other: number
}
tests: TestDiff[]
}
