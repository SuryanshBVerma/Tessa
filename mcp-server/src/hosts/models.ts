import type { ResolvedConfig } from '../config/index.js';

export const ROLES = [
  'orchestrator',
  'context_builder',
  'planner',
  'executor',
  'triage',
  'exporter',
] as const;
export type Role = (typeof ROLES)[number];

export type Host = 'claude-code' | 'vscode-agent';

/**
 * What `auto` asks of each role (ARCHITECTURE section 10): planner and triage reason hardest;
 * the executor needs reliable tool use and vision; exporter and context builder do well on a
 * mid-tier model; the orchestrator follows the model the user already chose in the host.
 */
export const AUTO_TIER: Record<Role, 'strongest' | 'tools-and-vision' | 'mid' | 'inherit'> = {
  orchestrator: 'inherit',
  context_builder: 'mid',
  planner: 'strongest',
  executor: 'tools-and-vision',
  triage: 'strongest',
  exporter: 'mid',
};

/**
 * Claude Code takes model aliases in an agent's frontmatter, which track the newest model of
 * each family, so `auto` never pins a version that goes stale.
 */
const CLAUDE_CODE_AUTO: Record<(typeof AUTO_TIER)[Role], string> = {
  strongest: 'opus',
  'tools-and-vision': 'sonnet',
  mid: 'sonnet',
  inherit: 'inherit',
};

export interface ModelChoice {
  role: Role;
  /** The model to write into the agent file, or null to leave the field out and inherit. */
  model: string | null;
  source: 'config' | 'auto';
  /** One line for the user and the report, e.g. "opus (auto: strongest)". */
  label: string;
}

/**
 * Resolves one role's model for a host. An explicit config value is used as written; the
 * host decides whether it understands it. VS Code names models by their picker labels, which
 * differ per account and change often, so `auto` there inherits the user's chosen model.
 */
export function resolveModel(
  config: Pick<ResolvedConfig, 'models'>,
  role: Role,
  host: Host,
): ModelChoice {
  const configured = config.models[role];
  if (configured !== 'auto') {
    return { role, model: configured, source: 'config', label: configured };
  }
  const tier = AUTO_TIER[role];
  if (host === 'claude-code') {
    const alias = CLAUDE_CODE_AUTO[tier];
    return { role, model: alias, source: 'auto', label: `${alias} (auto: ${tier})` };
  }
  return { role, model: null, source: 'auto', label: `host default (auto: ${tier})` };
}

export function resolveModels(config: Pick<ResolvedConfig, 'models'>, host: Host): ModelChoice[] {
  return ROLES.map((role) => resolveModel(config, role, host));
}

/** Per-role labels for results.json's environment.models, overlaid with what agents reported. */
export function modelsForRun(
  config: ResolvedConfig,
  host: Host | 'other',
  reported: Partial<Record<Role, string>> = {},
): Record<string, string> {
  const base: Record<string, string> =
    host === 'other'
      ? Object.fromEntries(ROLES.map((role) => [role, config.models[role]]))
      : Object.fromEntries(resolveModels(config, host).map((c) => [c.role, c.label]));
  for (const [role, model] of Object.entries(reported)) {
    if (model.trim() !== '') {
      base[role] = `${model} (reported)`;
    }
  }
  return base;
}
