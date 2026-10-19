// Generated from schemas/config.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server


/**
 * Path relative to the repository root. Must not escape it.
 */
export type RelativePath = string
export type Name = string
export type Glob = string

/**
 * Project configuration for Tessa, stored at .tessa/config.yaml in the repository under test.
 */
export interface TessaConfig {
/**
 * Config format version.
 */
version: 1
app: App
db: Db
auth: Auth
/**
 * @minItems 1
 */
personas: [Persona, ...(Persona)[]]
artifacts?: Artifacts
context?: Context
review?: Review
export?: Export
models?: Models
}
export interface App {
/**
 * Command that starts the app, e.g. "npm run dev". Run without a shell.
 */
start: string
/**
 * The app's folder, relative to the repository root: where the start command runs and where context.static_map reads source. Set it when the app is in a subfolder of a monorepo.
 */
cwd?: string
/**
 * Base URL of the running app. Must be a local address.
 */
url: string
/**
 * Stack adapter name, e.g. react-router.
 */
stack: string
/**
 * Path polled until the app responds.
 */
health_path?: string
start_timeout_seconds?: number
}
export interface Db {
/**
 * Environment variable that holds the database URL. The URL itself never goes in config.
 */
url_env?: string
/**
 * Hosts seeding may connect to. Only local hosts are accepted.
 * 
 * @minItems 1
 */
allowed_hosts: [("localhost" | "127.0.0.1" | "::1"), ...(("localhost" | "127.0.0.1" | "::1"))[]]
/**
 * Seed profiles: name -> ordered list of SQL files.
 */
profiles: {
/**
 * @minItems 1
 */
[k: string]: [RelativePath, ...(RelativePath)[]] | undefined
}
}
export interface Auth {
/**
 * Tessa never automates login; the human always signs in.
 */
mode: "manual"
login_path?: string
}
export interface Persona {
name: Name
description?: string
seed_profile: Name
}
export interface Artifacts {
/**
 * Path relative to the repository root. Must not escape it.
 */
root?: string
}
export interface Context {
knowledge_graph?: {
enabled: boolean
mode?: ("builtin" | "external" | "hybrid")
mcp_server?: string
query_mapping?: RelativePath
max_staleness_commits?: number
}
static_map?: {
adapter?: Name
/**
 * Source globs, relative to app.cwd (or the repository root).
 */
include?: Glob[]
exclude?: Glob[]
}
runtime_crawl?: {
enabled?: boolean
max_depth?: number
}
hints?: RelativePath
}
export interface Review {
mode?: ("local-server" | "static")
show_code_preview?: boolean
show_overlap?: boolean
idle_timeout_minutes?: number
}
export interface Export {
target?: ("auto" | "playwright-ts" | "playwright-dotnet" | "cypress-ts" | "selenium-csharp" | "selenium-java")
detect_from?: Glob[]
conventions?: {
adapt_to_codebase?: boolean
page_objects_dir?: RelativePath
test_dir?: RelativePath
/**
 * File name template. Placeholders: {feature}, {scenario}.
 */
naming?: string
}
validate?: {
compile?: boolean
run_once?: boolean
}
auth?: {
strategy?: "stored-session"
}
}
export interface Models {
/**
 * "auto" or a model identifier understood by the host.
 */
default?: string
/**
 * "auto" or a model identifier understood by the host.
 */
orchestrator?: string
/**
 * "auto" or a model identifier understood by the host.
 */
context_builder?: string
/**
 * "auto" or a model identifier understood by the host.
 */
planner?: string
/**
 * "auto" or a model identifier understood by the host.
 */
executor?: string
/**
 * "auto" or a model identifier understood by the host.
 */
triage?: string
/**
 * "auto" or a model identifier understood by the host.
 */
exporter?: string
}
