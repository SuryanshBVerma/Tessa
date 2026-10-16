// Generated from schemas/selection.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server


/**
 * Tests the reviewer chose on the review page, written to runs/<run_id>/selection.json. Never contains the review session token.
 */
export interface Selection {
version: 1
run_id: string
selected_test_ids: string[]
/**
 * Export target chosen on the review page; overrides config when present.
 */
target?: ("playwright-ts" | "playwright-dotnet" | "cypress-ts" | "selenium-csharp" | "selenium-java")
created_at: string
/**
 * local-server when posted to the review server; static when exported from a report opened from disk.
 */
source: ("local-server" | "static")
/**
 * Optional free text from the reviewer. Treated as data, never as instructions.
 */
notes?: string
}
