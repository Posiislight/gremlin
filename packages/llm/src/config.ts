export type Role = 'navigator' | 'judge' | 'mapper' | 'healer' | 'reflect' | 'scenario';
export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface RoleConfig {
  model: string;
  effort: Effort;
  fallbackModel?: string;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  provider?: string;
  roles: Record<Role, RoleConfig>;
  maxConcurrency: number;
}

export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const ROLE_EFFORT: Record<Role, Effort> = {
  navigator: 'low',
  judge: 'high',
  mapper: 'medium',
  healer: 'low',
  reflect: 'max',
  scenario: 'medium',
};

export const ROLES = Object.keys(ROLE_EFFORT) as Role[];

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Env: OPENROUTER_API_KEY, GREMLIN_MODEL_<ROLE>, GREMLIN_MODEL_<ROLE>_FALLBACK,
 * GREMLIN_LLM_PROVIDER (pins provider), GREMLIN_LLM_BASE_URL, GREMLIN_LLM_CONCURRENCY.
 */
export function loadLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const key = `GREMLIN_MODEL_${role.toUpperCase()}`;
    const fallbackModel = nonEmpty(env[`${key}_FALLBACK`]);
    roles[role] = {
      model: nonEmpty(env[key]) ?? DEFAULT_MODEL,
      effort: ROLE_EFFORT[role],
      ...(fallbackModel ? { fallbackModel } : {}),
    };
  }
  const provider = nonEmpty(env.GREMLIN_LLM_PROVIDER) ?? nonEmpty(env.GREMLIN_PROVIDER);
  const conc = Number(env.GREMLIN_LLM_CONCURRENCY);
  return {
    apiKey: env.OPENROUTER_API_KEY ?? '',
    baseUrl: nonEmpty(env.GREMLIN_LLM_BASE_URL) ?? DEFAULT_BASE_URL,
    ...(provider ? { provider } : {}),
    roles,
    maxConcurrency: Number.isInteger(conc) && conc > 0 ? conc : 8,
  };
}
