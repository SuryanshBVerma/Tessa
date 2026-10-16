import type { TessaConfig } from '../schemas/index.js';

type DeepRequired<T> = T extends readonly (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T;

type KnowledgeGraph = NonNullable<NonNullable<TessaConfig['context']>['knowledge_graph']>;

/**
 * Config with every default filled in. Optional fields without a default stay optional.
 */
export interface ResolvedConfig {
  version: 1;
  app: Omit<DeepRequired<TessaConfig['app']>, 'cwd'> & { cwd: string };
  db: DeepRequired<TessaConfig['db']>;
  auth: DeepRequired<TessaConfig['auth']>;
  personas: TessaConfig['personas'];
  artifacts: DeepRequired<NonNullable<TessaConfig['artifacts']>>;
  context: {
    knowledge_graph: Pick<KnowledgeGraph, 'mcp_server' | 'query_mapping'> &
      DeepRequired<Omit<KnowledgeGraph, 'mcp_server' | 'query_mapping'>>;
    static_map: { adapter: string; include: string[]; exclude: string[] };
    runtime_crawl: { enabled: boolean; max_depth: number };
    hints: string;
  };
  review: DeepRequired<NonNullable<TessaConfig['review']>>;
  export: {
    target: NonNullable<NonNullable<TessaConfig['export']>['target']>;
    detect_from: string[];
    conventions: {
      adapt_to_codebase: boolean;
      page_objects_dir?: string;
      test_dir?: string;
      naming?: string;
    };
    validate: { compile: boolean; run_once: boolean };
    auth: { strategy: 'stored-session' };
  };
  models: DeepRequired<NonNullable<TessaConfig['models']>>;
}

// Keep in step with the "default" keywords in schemas/config.schema.json; a test checks this.
export const DEFAULTS = {
  dbUrlEnv: 'DATABASE_URL',
  healthPath: '/',
  startTimeoutSeconds: 60,
  loginPath: '/login',
  artifactsRoot: 'ai-test-artifacts',
  kgMode: 'builtin',
  kgMaxStaleness: 20,
  staticInclude: ['src/**'],
  staticExclude: [] as string[],
  crawlEnabled: true,
  crawlMaxDepth: 4,
  reviewMode: 'local-server',
  showCodePreview: true,
  showOverlap: true,
  idleTimeoutMinutes: 30,
  exportTarget: 'auto',
  detectFrom: ['package.json', '*.csproj', 'pom.xml'],
  adaptToCodebase: true,
  validateCompile: true,
  validateRunOnce: true,
  model: 'auto',
} as const;

export function resolveConfig(config: TessaConfig): ResolvedConfig {
  const artifactsRoot = config.artifacts?.root ?? DEFAULTS.artifactsRoot;
  const kg = config.context?.knowledge_graph;
  const models = config.models ?? {};
  const defaultModel = models.default ?? DEFAULTS.model;
  return {
    version: 1,
    app: {
      start: config.app.start,
      cwd: config.app.cwd ?? '.',
      url: config.app.url,
      stack: config.app.stack,
      health_path: config.app.health_path ?? DEFAULTS.healthPath,
      start_timeout_seconds: config.app.start_timeout_seconds ?? DEFAULTS.startTimeoutSeconds,
    },
    db: {
      url_env: config.db.url_env ?? DEFAULTS.dbUrlEnv,
      allowed_hosts: config.db.allowed_hosts,
      profiles: config.db.profiles,
    },
    auth: {
      mode: 'manual',
      login_path: config.auth.login_path ?? DEFAULTS.loginPath,
    },
    personas: config.personas,
    artifacts: { root: artifactsRoot },
    context: {
      knowledge_graph: {
        enabled: kg?.enabled ?? false,
        mode: kg?.mode ?? DEFAULTS.kgMode,
        max_staleness_commits: kg?.max_staleness_commits ?? DEFAULTS.kgMaxStaleness,
        ...(kg?.mcp_server === undefined ? {} : { mcp_server: kg.mcp_server }),
        ...(kg?.query_mapping === undefined ? {} : { query_mapping: kg.query_mapping }),
      },
      static_map: {
        adapter: config.context?.static_map?.adapter ?? config.app.stack,
        include: config.context?.static_map?.include ?? [...DEFAULTS.staticInclude],
        exclude: config.context?.static_map?.exclude ?? [...DEFAULTS.staticExclude],
      },
      runtime_crawl: {
        enabled: config.context?.runtime_crawl?.enabled ?? DEFAULTS.crawlEnabled,
        max_depth: config.context?.runtime_crawl?.max_depth ?? DEFAULTS.crawlMaxDepth,
      },
      hints: config.context?.hints ?? `${artifactsRoot}/context/hints.md`,
    },
    review: {
      mode: config.review?.mode ?? DEFAULTS.reviewMode,
      show_code_preview: config.review?.show_code_preview ?? DEFAULTS.showCodePreview,
      show_overlap: config.review?.show_overlap ?? DEFAULTS.showOverlap,
      idle_timeout_minutes: config.review?.idle_timeout_minutes ?? DEFAULTS.idleTimeoutMinutes,
    },
    export: {
      target: config.export?.target ?? DEFAULTS.exportTarget,
      detect_from: config.export?.detect_from ?? [...DEFAULTS.detectFrom],
      conventions: {
        adapt_to_codebase:
          config.export?.conventions?.adapt_to_codebase ?? DEFAULTS.adaptToCodebase,
        ...pickDefined(config.export?.conventions, ['page_objects_dir', 'test_dir', 'naming']),
      },
      validate: {
        compile: config.export?.validate?.compile ?? DEFAULTS.validateCompile,
        run_once: config.export?.validate?.run_once ?? DEFAULTS.validateRunOnce,
      },
      auth: { strategy: 'stored-session' },
    },
    models: {
      default: defaultModel,
      orchestrator: models.orchestrator ?? defaultModel,
      context_builder: models.context_builder ?? defaultModel,
      planner: models.planner ?? defaultModel,
      executor: models.executor ?? defaultModel,
      triage: models.triage ?? defaultModel,
      exporter: models.exporter ?? defaultModel,
    },
  };
}

function pickDefined<T extends object, K extends keyof T>(
  source: T | undefined,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (source === undefined) {
    return out;
  }
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}
