// Connecting an existing knowledge graph: report what is configured, and save a mapping the agent
// worked out from the graph's own tools. tessa-mcp still never calls the graph (decision 21); the
// agent probes it through the host, and these functions only validate and write Tessa's files.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { parseDocument } from 'yaml';
import { checkSemantics, DEFAULT_CONFIG_PATH } from '../config/load.js';
import type { ResolvedConfig } from '../config/index.js';
import { writeAtomic } from '../runs/store.js';
import { validate } from '../schemas/index.js';
import { resolveInside } from '../util/paths.js';
import { ContextError } from './build.js';
import {
  delegateFor,
  grantedTools,
  loadMapping,
  mappingSchema,
  mappingText,
  QUERY_NAMES,
  type Delegate,
  type KgMapping,
} from './kg.js';

export const DEFAULT_MAPPING_PATH = '.tessa/kg-mapping.yaml';

export interface KgStatus {
  enabled: boolean;
  mode: 'builtin' | 'external' | 'hybrid';
  server?: string;
  query_mapping?: string;
  /** Queries the graph answers; the rest come from Tessa's own map. */
  mapped: string[];
  unmapped: string[];
  freshness_tool?: string;
  notes?: string;
  /** The graph's tools Tessa's agents are given, once host files are written again. */
  granted_tools: string[];
  /** A cheap call to check the graph answers: the freshness tool, else the first mapped query. */
  probe?: Delegate;
  issues: string[];
}

/** What is configured for the knowledge graph, and whether the mapping loads. */
export function kgStatus(ctx: { config: ResolvedConfig; workspace: string }): KgStatus {
  const kg = ctx.config.context.knowledge_graph;
  const base: KgStatus = {
    enabled: kg.enabled,
    mode: kg.enabled ? kg.mode : 'builtin',
    ...(kg.mcp_server === undefined ? {} : { server: kg.mcp_server }),
    ...(kg.query_mapping === undefined ? {} : { query_mapping: kg.query_mapping }),
    mapped: [],
    unmapped: [...QUERY_NAMES],
    granted_tools: [],
    issues: [],
  };
  if (!kg.enabled || kg.mode === 'builtin') return base;
  let mapping: KgMapping;
  try {
    mapping = loadMapping(ctx);
  } catch (error) {
    return { ...base, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const mapped = QUERY_NAMES.filter((q) => mapping.queries[q] !== undefined);
  const server = mapping.server ?? kg.mcp_server;
  const issues: string[] = [];
  if (server === undefined) {
    issues.push('no server: set server in the mapping or context.knowledge_graph.mcp_server');
  }
  let probe: Delegate | null = null;
  try {
    probe =
      delegateFor(ctx, 'freshness', {}) ??
      (mapped[0] === undefined
        ? null
        : delegateFor(ctx, mapped[0], { query: 'login', route: '/', file: '' }));
  } catch {
    // Reported through issues above.
  }
  return {
    ...base,
    ...(server === undefined ? {} : { server }),
    mapped,
    unmapped: QUERY_NAMES.filter((q) => mapping.queries[q] === undefined),
    ...(mapping.freshness === undefined ? {} : { freshness_tool: mapping.freshness.tool }),
    ...(mapping.notes === undefined ? {} : { notes: mapping.notes }),
    granted_tools: grantedTools(mapping),
    ...(probe === null ? {} : { probe }),
    issues,
  };
}

export interface SaveKgInput {
  server: string;
  mode?: 'external' | 'hybrid';
  queries?: unknown;
  freshness?: unknown;
  notes?: string;
  extra_tools?: string[];
  /** Where to write the mapping, relative to the workspace. */
  mapping_path?: string;
}

/**
 * Validates a mapping and writes it, then points context.knowledge_graph at it in
 * .tessa/config.yaml, keeping the rest of the config and its comments. With dryRun nothing is
 * written and both files are returned for the user to review.
 */
export function saveKgMapping(
  workspace: string,
  input: SaveKgInput,
  dryRun: boolean,
): {
  files: { path: string; action: 'created' | 'updated'; preview?: string }[];
  mapping: KgMapping;
} {
  const mappingPath = posix.normalize(input.mapping_path ?? DEFAULT_MAPPING_PATH);
  if (!/\.ya?ml$/.test(mappingPath)) throw new ContextError('mapping_path must be a .yaml file');
  const parsed = mappingSchema.safeParse({
    version: 1,
    server: input.server,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    queries: input.queries ?? {},
    ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    extra_tools: input.extra_tools ?? [],
  });
  if (!parsed.success) {
    throw new ContextError(
      `the mapping is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  const mapping = parsed.data;
  if (Object.keys(mapping.queries).length === 0 && mapping.freshness === undefined) {
    throw new ContextError('map at least one query or the freshness tool');
  }

  const configFile = resolveInside(workspace, DEFAULT_CONFIG_PATH);
  if (!existsSync(configFile)) {
    throw new ContextError('no .tessa/config.yaml yet; run /tessa-init first');
  }
  const doc = parseDocument(readFileSync(configFile, 'utf8'));
  const previous = doc.getIn(['context', 'knowledge_graph']) as { toJSON?: () => unknown } | null;
  const keep = (previous?.toJSON?.() ?? {}) as Record<string, unknown>;
  doc.setIn(
    ['context', 'knowledge_graph'],
    doc.createNode({
      ...keep,
      enabled: true,
      mode: input.mode ?? 'hybrid',
      mcp_server: mapping.server,
      query_mapping: mappingPath,
    }),
  );
  const configText = doc.toString({ lineWidth: 100, flowCollectionPadding: false });
  const checked = validate('config', doc.toJS());
  if (!checked.ok) {
    throw new ContextError(
      `the config would not be valid: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  const mappingFile = resolveInside(workspace, mappingPath);
  const text = mappingText(mapping);
  const files = [
    {
      path: mappingPath,
      action: existsSync(mappingFile) ? ('updated' as const) : ('created' as const),
      ...(dryRun ? { preview: text } : {}),
    },
    {
      path: DEFAULT_CONFIG_PATH,
      action: 'updated' as const,
      ...(dryRun
        ? {
            preview: `context:\n  knowledge_graph:\n    enabled: true\n    mode: ${input.mode ?? 'hybrid'}\n    mcp_server: ${mapping.server ?? ''}\n    query_mapping: ${mappingPath}\n`,
          }
        : {}),
    },
  ];
  if (!dryRun) {
    mkdirSync(dirname(mappingFile), { recursive: true });
    writeAtomic(mappingFile, text);
    // The mapping file exists now, so the config's own checks pass.
    const semantic = checkSemantics(checked.value, workspace).filter((i) => i.severity === 'error');
    if (semantic.length > 0) {
      throw new ContextError(
        `the config would not be valid: ${semantic.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      );
    }
    writeAtomic(configFile, configText);
  }
  return { files, mapping };
}
