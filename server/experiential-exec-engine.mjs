import { CodexExecEngine, buildOwnerCodexEnv } from './codex-exec-engine.mjs';

export const EXPERIENTIAL_MODEL = 'gpt-6-astra';
export function normalizeExperientialSettings(settings = {}) {
  return {
    model: EXPERIENTIAL_MODEL,
    reasoningEffort: ['low', 'medium', 'high', 'max'].includes(settings.reasoningEffort) ? settings.reasoningEffort : 'high',
  };
}

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
export function experientialProvider(apiKey) {
  return {
    configArgs: [
      '-c', 'model_provider="explabs"',
      '-c', 'model_providers.explabs.name="Experiential Labs"',
      '-c', 'model_providers.explabs.base_url="https://api.experientiallabs.ai/v1"',
      '-c', 'model_providers.explabs.env_key="EXPLABS_API_KEY"',
      '-c', 'model_providers.explabs.wire_api="responses"',
      '-c', 'model_providers.explabs.requires_openai_auth=false',
      '-c', 'model_providers.explabs.request_max_retries=0',
      '-c', 'model_providers.explabs.stream_max_retries=0',
    ],
    buildEnv: () => ({ ...buildOwnerCodexEnv(), BOX_EXPLABS_API_KEY: apiKey }),
    // Restore the selected credential after the optional shared environment file, without
    // placing it in argv or changing the owner's Codex login or global configuration.
    buildScript: (envFile = '') => `${envFile ? `[ -f ${quote(envFile)} ] && . ${quote(envFile)}; ` : ''}export EXPLABS_API_KEY="$BOX_EXPLABS_API_KEY"; unset BOX_EXPLABS_API_KEY OPENAI_API_KEY CODEX_API_KEY; exec codex "$@"`,
  };
}

export class ExperientialExecEngine {
  constructor({ spawnImpl } = {}) { this.spawnImpl = spawnImpl; }
  run({ apiKey, ...options }) {
    if (options.guest || options.team) throw new Error('Experiential is available to the Box owner only.');
    if (!apiKey) throw new Error('Experiential API key is not configured.');
    return new CodexExecEngine({ spawnImpl: this.spawnImpl, ownerProvider: experientialProvider(apiKey) })
      .run({ ...options, settings: normalizeExperientialSettings(options.settings) });
  }
}
