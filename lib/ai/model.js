import { ChatAnthropic } from '@langchain/anthropic';
import { getConfig } from '../config.js';
import { BUILTIN_PROVIDERS } from '../llm-providers.js';

// These models require thought_signature round-tripping which @langchain/google-genai doesn't support.
// Auto-replace with gemini-2.5-flash until we migrate to @langchain/google (see issue #201).
const GEMINI_UNSUPPORTED_MODELS = ['gemini-2.5-pro', 'gemini-3'];
const GEMINI_FALLBACK = 'gemini-2.5-flash';

/**
 * Create a LangChain chat model based on DB/env configuration.
 *
 * @param {object} [options]
 * @param {number} [options.maxTokens] - Max tokens for the response
 * @returns {import('@langchain/core/language_models/chat_models').BaseChatModel}
 */
export async function createModel(options = {}) {
  const provider = getConfig('LLM_PROVIDER');
  const modelName = getConfig('LLM_MODEL');
  const maxTokens = options.maxTokens || Number(getConfig('LLM_MAX_TOKENS')) || 4096;

  // Custom provider (not in BUILTIN_PROVIDERS) → OpenAI-compatible
  if (!BUILTIN_PROVIDERS[provider]) {
    const { ChatOpenAI } = await import('@langchain/openai');
    const { getCustomProvider } = await import('../db/config.js');
    const custom = getCustomProvider(provider);
    if (!custom) throw new Error(`Unknown LLM provider: ${provider}`);
    const config = { modelName: custom.models?.[0] || modelName, maxTokens };
    config.apiKey = custom.apiKey || 'not-needed';
    if (custom.baseUrl) {
      config.configuration = { baseURL: custom.baseUrl };
    }
    return new ChatOpenAI(config);
  }

  const LLM_NOT_CONFIGURED = 'No chat LLM configured — set one up in Admin > Event Handler > LLMs';

  switch (provider) {
    case 'anthropic': {
      const apiKey = getConfig('ANTHROPIC_API_KEY');
      if (!apiKey) {
        throw new Error(LLM_NOT_CONFIGURED);
      }
      return new ChatAnthropic({
        modelName,
        maxTokens,
        anthropicApiKey: apiKey,
      });
    }
    case 'openai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('OPENAI_API_KEY');
      const baseURL = getConfig('CUSTOM_OPENAI_BASE_URL');
      if (!apiKey && !baseURL) {
        throw new Error(LLM_NOT_CONFIGURED);
      }
      const config = { modelName, maxTokens };
      config.apiKey = apiKey || 'not-needed';
      if (baseURL) {
        config.configuration = { baseURL };
      }
      return new ChatOpenAI(config);
    }
    case 'google': {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      const apiKey = getConfig('GOOGLE_API_KEY');
      if (!apiKey) {
        throw new Error(LLM_NOT_CONFIGURED);
      }
      let resolvedModel = modelName;
      const isUnsupported = GEMINI_UNSUPPORTED_MODELS.some(m => resolvedModel.startsWith(m));
      if (isUnsupported) {
        console.warn(
          `[model] ${resolvedModel} requires thought_signature support not yet available in @langchain/google-genai. ` +
          `Falling back to ${GEMINI_FALLBACK}. See https://github.com/stephengpope/thepopebot/issues/201.`
        );
        resolvedModel = GEMINI_FALLBACK;
      }
      return new ChatGoogleGenerativeAI({
        model: resolvedModel,
        maxOutputTokens: maxTokens,
        apiKey,
      });
    }
    case 'deepseek': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('DEEPSEEK_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://api.deepseek.com' } });
    }
    case 'minimax': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('MINIMAX_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://api.minimax.io/v1' } });
    }
    case 'mistral': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('MISTRAL_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://api.mistral.ai/v1' } });
    }
    case 'xai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('XAI_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://api.x.ai/v1' } });
    }
    case 'kimi': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('MOONSHOT_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://api.moonshot.cn/v1' } });
    }
    case 'openrouter': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = getConfig('OPENROUTER_API_KEY');
      if (!apiKey) throw new Error(LLM_NOT_CONFIGURED);
      return new ChatOpenAI({ modelName, maxTokens, apiKey, configuration: { baseURL: 'https://openrouter.ai/api/v1' } });
    }
    case 'github-copilot': {
      // Conclave: talks to Copilot Enterprise's Anthropic Messages API using
      // the session token cached by OpenClaw. See lib/ai/copilot-auth.js +
      // copilot-chat.js for the wire details.
      const { ChatGithubCopilot } = await import('./copilot-chat.js');
      return new ChatGithubCopilot({ modelName, maxTokens });
    }
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
