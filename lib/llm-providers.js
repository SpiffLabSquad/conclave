/**
 * Built-in LLM provider definitions.
 * Each provider declares its credentials and available models.
 * Imported by config resolver, server actions, and UI.
 */

// Model capability flags:
//   chat:        works with the langchain chat agent
//   codingAgent: works with coding agents (Claude Code CLI, Pi CLI)
// Omitted flags default to true for backward compat.

export const BUILTIN_PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    credentials: [
      { type: 'api_key', key: 'ANTHROPIC_API_KEY', label: 'API Key' },
    ],
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', default: true },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    ],
  },
  openai: {
    name: 'OpenAI',
    litellmProxy: true, litellmPrefix: 'openai',
    credentials: [
      { type: 'api_key', key: 'OPENAI_API_KEY', label: 'API Key' },
    ],
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', default: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4-mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  google: {
    name: 'Google',
    litellmProxy: true, litellmPrefix: 'gemini',
    credentials: [
      { type: 'api_key', key: 'GOOGLE_API_KEY', label: 'API Key' },
    ],
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', default: true },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', chat: false },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', chat: false },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', chat: false },
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    credentials: [
      { type: 'api_key', key: 'DEEPSEEK_API_KEY', label: 'API Key' },
    ],
    anthropicEndpoint: 'https://api.deepseek.com/anthropic',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', default: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', chat: false },
    ],
  },
  minimax: {
    name: 'MiniMax',
    credentials: [
      { type: 'api_key', key: 'MINIMAX_API_KEY', label: 'API Key' },
    ],
    anthropicEndpoint: 'https://api.minimax.io/anthropic',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', default: true },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed' },
    ],
  },
  mistral: {
    name: 'Mistral',
    litellmProxy: true, litellmPrefix: 'mistral',
    credentials: [
      { type: 'api_key', key: 'MISTRAL_API_KEY', label: 'API Key' },
    ],
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', default: true },
      { id: 'mistral-medium-latest', name: 'Mistral Medium' },
      { id: 'mistral-small-latest', name: 'Mistral Small' },
      { id: 'codestral-latest', name: 'Codestral' },
      { id: 'devstral-2-25-12', name: 'Devstral 2', chat: false },
    ],
  },
  xai: {
    name: 'xAI',
    litellmProxy: true, litellmPrefix: 'xai',
    credentials: [
      { type: 'api_key', key: 'XAI_API_KEY', label: 'API Key' },
    ],
    models: [
      { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20', default: true },
      { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning' },
      { id: 'grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Fast' },
      { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
    ],
  },
  kimi: {
    name: 'Kimi',
    credentials: [
      { type: 'api_key', key: 'MOONSHOT_API_KEY', label: 'API Key' },
    ],
    anthropicEndpoint: 'https://api.moonshot.cn/anthropic',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', default: true },
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', chat: false },
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    credentials: [
      { type: 'api_key', key: 'OPENROUTER_API_KEY', label: 'API Key' },
    ],
    anthropicEndpoint: 'https://openrouter.ai/api',
    models: [],
  },
  // Conclave addition: GitHub Copilot Enterprise via the cached session token
  // OpenClaw maintains. No API key field — auth comes from
  // ~/openclaw/credentials/github-copilot.token.json (env-overridable).
  // codingAgent capability is OFF for now: agent-job containers don't yet
  // know how to refresh the Copilot session token.
  'github-copilot': {
    name: 'GitHub Copilot',
    credentials: [],
    models: [
      { id: 'claude-opus-4.6',   name: 'Claude Opus 4.6 (via Copilot)',   default: true, codingAgent: false },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5 (via Copilot)',  codingAgent: false },
      { id: 'claude-sonnet-4',   name: 'Claude Sonnet 4 (via Copilot)',    codingAgent: false },
      { id: 'claude-haiku-4.5',  name: 'Claude Haiku 4.5 (via Copilot)',   codingAgent: false },
      { id: 'gpt-4o',            name: 'GPT-4o (via Copilot)',             codingAgent: false },
    ],
  },
};

/**
 * Get the default model ID for a built-in provider.
 * @param {string} providerSlug
 * @returns {string|undefined}
 */
export function getDefaultModel(providerSlug) {
  const provider = BUILTIN_PROVIDERS[providerSlug];
  if (!provider) return undefined;
  const defaultModel = provider.models.find((m) => m.default);
  return defaultModel?.id || provider.models[0]?.id;
}

/**
 * Get all credential keys across all built-in providers.
 * @returns {string[]}
 */
export function getAllCredentialKeys() {
  const keys = [];
  for (const provider of Object.values(BUILTIN_PROVIDERS)) {
    for (const cred of provider.credentials) {
      keys.push(cred.key);
    }
  }
  return keys;
}
