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
// Implements:
//   - LangChain `BaseChatModel` interface (`_generate`, `_llmType`, `bindTools`).
//   - Token resolution via `resolveCopilotApiToken()` (cached + refreshed via
//     OpenClaw-compatible files).
//   - Anthropic Messages request body shape: `{model, messages, max_tokens,
//     system?, tools?}`.
//   - Tools: `bindTools(langchainTools)` converts zod schemas to JSON schema
//     and stores them via `withConfig`. `_generate` reads `options.tools` and
//     forwards them in the request body. Response `tool_use` content blocks
//     are surfaced as `tool_calls` on the returned AIMessage. Followup turns
//     with AIMessage(tool_calls=...) + ToolMessage round-trip cleanly into
//     Anthropic `tool_use` and `tool_result` content blocks.
//   - Static + dynamic Copilot headers, captured from OpenClaw's bundled
//     `github-copilot-headers-*.js`.
//
// TODO: streaming via `_streamResponseChunks` (Anthropic Messages SSE format).

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { isLangChainTool } from '@langchain/core/utils/function_calling';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { resolveCopilotApiToken } from './copilot-auth.js';

const STATIC_HEADERS = {
  'User-Agent':            'GitHubCopilotChat/0.35.0',
  'Editor-Version':        'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id':'vscode-chat',
};

// --- tool conversion --------------------------------------------------------

function isAnthropicShapedTool(tool) {
  return !!tool && typeof tool === 'object' && 'input_schema' in tool && typeof tool.name === 'string';
}

function isOpenAIShapedTool(tool) {
  return !!tool && typeof tool === 'object' && tool.type === 'function' && tool.function;
}

function langchainToolToAnthropic(tool) {
  if (isAnthropicShapedTool(tool)) return tool;
  if (isOpenAIShapedTool(tool)) {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    };
  }
  if (isLangChainTool(tool)) {
    let schema;
    try {
      schema = tool.schema && typeof tool.schema === 'object' && '_def' in tool.schema
        ? toJsonSchema(tool.schema)
        : (tool.schema || { type: 'object', properties: {} });
    } catch {
      schema = { type: 'object', properties: {} };
    }
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: schema,
    };
  }
  throw new Error(`github-copilot: unknown tool type: ${JSON.stringify(tool).slice(0, 200)}`);
}

// --- message conversion -----------------------------------------------------

// Convert a LangChain message to an Anthropic Messages turn (or null for
// system messages, which are hoisted to the top-level `system` field).
function langchainMessageToAnthropic(msg) {
  const type = msg._getType?.() ?? msg.role;

  if (type === 'system') return null;

  // ToolMessage → user turn with tool_result block
  if (type === 'tool') {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content) ? msg.content : String(msg.content ?? '');
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content,
      }],
    };
  }

  // AIMessage with tool_calls → assistant turn with text + tool_use blocks
  if (type === 'ai' || type === 'assistant') {
    const blocks = [];
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
        : String(msg.content ?? '');
    if (text) blocks.push({ type: 'text', text });
    const toolCalls = msg.tool_calls || msg.additional_kwargs?.tool_calls || [];
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name || tc.function?.name,
        input: tc.args ?? tc.function?.arguments ?? {},
      });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    return { role: 'assistant', content: blocks };
  }

  // Human/user message → user turn
  const content = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content) ? msg.content : String(msg.content ?? '');
  return { role: 'user', content };
}

function pickXInitiator(messages) {
  const last = messages[messages.length - 1];
  const role = last?._getType?.() ?? last?.role;
  return (role === 'human' || role === 'user' || role === 'tool') ? 'user' : 'agent';
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

// --- the chat model ---------------------------------------------------------

export class ChatGithubCopilot extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.modelName = fields.modelName || fields.model || 'claude-haiku-4.5';
    this.maxTokens = Number.isFinite(fields.maxTokens) ? fields.maxTokens : 4096;
    this.temperature = fields.temperature;
  }

  _llmType() { return 'github-copilot'; }
  _modelType() { return 'github-copilot-chat'; }

  bindTools(tools, kwargs) {
    const converted = (tools || []).map(langchainToolToAnthropic);
    return this.withConfig({ tools: converted, ...(kwargs || {}) });
  }

  async _generate(messages, options = {}, _runManager) {
    const { token, baseUrl } = await resolveCopilotApiToken();

    // Hoist system prompts to the top-level `system` field.
    let systemPrompt = '';
    const turns = [];
    for (const m of messages) {
      const type = m._getType?.() ?? m.role;
      if (type === 'system') {
        const piece = typeof m.content === 'string' ? m.content : String(m.content ?? '');
        systemPrompt += (systemPrompt ? '\n\n' : '') + piece;
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
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice) body.tool_choice = options.tool_choice;
    }
    if (options.stop?.length) body.stop_sequences = options.stop;

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

    // Extract text content + tool_use blocks.
    const textParts = [];
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === 'text') textParts.push(block.text || '');
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input || {},
          type: 'tool_call',
        });
      }
    }
    const text = textParts.join('');

    const aiMsg = new AIMessage({
      content: text,
      tool_calls: toolCalls,
      additional_kwargs: { stop_reason: data.stop_reason },
    });

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
