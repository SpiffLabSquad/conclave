// LangChain BaseChatModel adapter for GitHub Copilot Enterprise.
//
// Why a custom adapter and not @langchain/anthropic's ChatAnthropic:
//   - Copilot Enterprise speaks the Anthropic Messages API at /v1/messages,
//     but it requires `Authorization: Bearer <session token>` instead of the
//     `x-api-key` header that the Anthropic SDK hardcodes.
//   - It also requires a fixed set of `Editor-Version` / `Copilot-Integration-Id`
//     headers and a per-request `X-Initiator: user|agent` header derived from
//     the last message role. The Anthropic SDK doesn't expose hooks for either
//     auth replacement or per-request header derivation.
//
// What this implements:
//   - LangChain `BaseChatModel` interface (`_generate`, `_llmType`).
//   - Token resolution via `resolveCopilotApiToken()` (cached + refreshed via
//     OpenClaw-compatible files).
//   - Anthropic Messages request body shape: `{model, messages, max_tokens, system?}`.
//   - Static + dynamic Copilot headers, captured from OpenClaw's bundled
//     `github-copilot-headers-*.js`.
//   - Non-streaming for v1. Streaming via `_streamResponseChunks` is a TODO —
//     the LangGraph chat path consumes streams when available but works fine
//     against `_generate` for short prompts. We can add SSE parsing later.

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { resolveCopilotApiToken } from './copilot-auth.js';

const STATIC_HEADERS = {
  'User-Agent':            'GitHubCopilotChat/0.35.0',
  'Editor-Version':        'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id':'vscode-chat',
};

// Convert a LangChain message to Anthropic Messages role/content.
// Anthropic Messages API supports `user` and `assistant` roles. System
// prompts go in a top-level `system` field, not in messages.
function langchainMessageToAnthropic(msg) {
  const role = msg._getType?.() ?? msg.role;
  if (role === 'system') return null;  // hoisted to top-level `system`
  const out = role === 'human' || role === 'user' ? 'user' : 'assistant';
  // Anthropic content can be a string or an array of content blocks. Strings
  // work for the common text case; we keep the simple shape unless the input
  // already provides structured blocks.
  const content = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content) ? msg.content : String(msg.content ?? '');
  return { role: out, content };
}

function pickXInitiator(messages) {
  const last = messages[messages.length - 1];
  const role = last?._getType?.() ?? last?.role;
  return (role === 'human' || role === 'user') ? 'user' : 'agent';
}

function hasImages(messages) {
  for (const m of messages) {
    const c = m.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block && (block.type === 'image' || block.type === 'image_url')) return true;
      }
    }
  }
  return false;
}

export class ChatGithubCopilot extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.modelName = fields.modelName || fields.model || 'claude-haiku-4.5';
    this.maxTokens = Number.isFinite(fields.maxTokens) ? fields.maxTokens : 4096;
    this.temperature = fields.temperature;
  }

  _llmType() { return 'github-copilot'; }
  _modelType() { return 'github-copilot-chat'; }

  async _generate(messages, _options, _runManager) {
    const { token, baseUrl } = await resolveCopilotApiToken();

    // Hoist system prompts.
    let systemPrompt = '';
    const turns = [];
    for (const m of messages) {
      const role = m._getType?.() ?? m.role;
      if (role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : '');
        continue;
      }
      const converted = langchainMessageToAnthropic(m);
      if (converted) turns.push(converted);
    }

    const body = {
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: turns,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (Number.isFinite(this.temperature)) body.temperature = this.temperature;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...STATIC_HEADERS,
      'X-Initiator': pickXInitiator(messages),
      'Openai-Intent': 'conversation-edits',
    };
    if (hasImages(messages)) headers['Copilot-Vision-Request'] = 'true';

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`github-copilot: HTTP ${res.status} from ${baseUrl}/v1/messages: ${errBody.slice(0, 400)}`);
    }
    const data = await res.json();

    const text = (data.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('');

    const aiMsg = new AIMessage({ content: text });
    return {
      generations: [{
        text,
        message: aiMsg,
        generationInfo: { stop_reason: data.stop_reason, model: data.model },
      }],
      llmOutput: { tokenUsage: data.usage },
    };
  }
}
