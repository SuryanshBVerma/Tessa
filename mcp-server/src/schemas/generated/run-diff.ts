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
story_id?: string
created_at: string
commit_a?: string
commit_b?: string
/**
 * run_a ran with uncommitted changes, so commit_a does not fully describe the code.
 */
dirty_a?: boolean
dirty_b?: boolean
/**
 * run_b reran some of run_a's tests; tests it did not rerun are left out rather than counted as removed.
 */
rerun_only?: boolean
/**
 * Files changed between commit_a and commit_b (git diff --name-only), relative to the workspace. Uncommitted changes are not included.
 * 
 * @maxItems 500
 */
changed_files?: string[]
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
