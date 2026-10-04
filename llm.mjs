// One entry point for every AI call (notes, tasks, filing, folder overviews), whatever provider
// the workspace picked in Settings: Claude, ChatGPT (OpenAI) or DeepSeek.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { db } from './db.mjs';
import { unseal } from './secrets.mjs';

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    short: 'Claude',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    envKey: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…  from console.anthropic.com → API Keys',
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    short: 'ChatGPT',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    envKey: 'OPENAI_API_KEY',
    keyHint: 'sk-…  from platform.openai.com → API keys',
    base: 'https://api.openai.com/v1',
  },
  deepseek: {
    label: 'DeepSeek',
    short: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKey: 'DEEPSEEK_API_KEY',
    keyHint: 'sk-…  from platform.deepseek.com → API keys',
    base: 'https://api.deepseek.com',
  },
  // Gateway: one key for many providers' models (OpenAI-compatible API).
  sumopod: {
    label: 'SumoPod (all models, one key)',
    short: 'SumoPod',
    models: [
      'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5',
      'gpt-5', 'gpt-5-mini',
      'deepseek-v4-pro', 'deepseek-v4-flash',
      'gemini/gemini-3.1-pro-preview', 'gemini/gemini-3.5-flash',
      'qwen3.7-plus',
    ],
    envKey: 'SUMOPOD_API_KEY',
    keyHint: 'sk-…  from sumopod.com → AI → API Keys',
    base: 'https://ai.sumopod.com/v1',
    gateway: true,
  },
};

// The AI a workspace uses: its Settings choice, else Claude with the server's env key.
export function aiFor(workspaceId) {
  const row = workspaceId && db.prepare(`SELECT * FROM ai_settings WHERE workspace_id = ?`).get(workspaceId);
  const provider = PROVIDERS[row?.provider] ? row.provider : 'anthropic';
  const p = PROVIDERS[provider];
  const saved = savedKey(workspaceId, provider) || (row?.api_key ? unseal(row.api_key) : null);   // ai_settings.api_key = older single-key storage
  return {
    provider,
    model: row?.model || p.models[0],
    apiKey: saved || process.env[p.envKey] || null,
    keySource: saved ? 'settings' : process.env[p.envKey] ? 'server' : null,
    autoTasks: row ? Boolean(row.auto_tasks) : true,
  };
}

// Each provider keeps its own key, so switching providers never loses one.
export function savedKey(workspaceId, provider) {
  if (!workspaceId) return null;
  const k = db.prepare(`SELECT api_key FROM ai_keys WHERE workspace_id = ? AND provider = ?`).get(workspaceId, provider);
  return k ? unseal(k.api_key) : null;
}

export class AIError extends Error {}

// Ask for JSON matching a zod schema. Returns the parsed, validated object.
export async function generateObject({ ai, system, prompt, schema, name, effort = 'medium', maxTokens = 16000 }) {
  if (!ai.apiKey) throw new AIError(`No API key for ${PROVIDERS[ai.provider].label}. Add one in Settings → AI.`);
  if (ai.provider === 'anthropic') return anthropicObject({ ai, system, prompt, schema, effort, maxTokens });
  return openaiCompatibleObject({ ai, system, prompt, schema, name, maxTokens });
}

async function anthropicObject({ ai, system, prompt, schema, effort, maxTokens }) {
  // Organization-level keys must say which Anthropic workspace to bill (ANTHROPIC_WORKSPACE_ID).
  const client = new Anthropic({
    apiKey: ai.apiKey,
    ...(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {}),
  });
  const isHaiku = ai.model.startsWith('claude-haiku');
  const fallback = /^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(ai.model);
  const response = await client.beta.messages.parse({
    model: ai.model,
    max_tokens: maxTokens,
    output_config: { ...(isHaiku ? {} : { effort }), format: betaZodOutputFormat(schema) },
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new AIError('Claude declined this request');
  if (!response.parsed_output) throw new AIError(`Claude returned no result (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}

// OpenAI and DeepSeek share the Chat Completions API. OpenAI follows a JSON schema;
// DeepSeek only promises valid JSON, so the schema goes into the instructions.
async function openaiCompatibleObject({ ai, system, prompt, schema, name, maxTokens }) {
  const p = PROVIDERS[ai.provider];
  const jsonSchema = z.toJSONSchema(schema);
  const isOpenAI = ai.provider === 'openai' || (p.gateway && !ai.jsonMode);
  const body = {
    model: ai.model,
    messages: [
      { role: 'system', content: isOpenAI ? system : `${system}\n\nReply with a single JSON object that matches this JSON Schema exactly:\n${JSON.stringify(jsonSchema)}` },
      { role: 'user', content: prompt },
    ],
    response_format: isOpenAI
      ? { type: 'json_schema', json_schema: { name: name || 'result', schema: jsonSchema } }
      : { type: 'json_object' },
    ...(ai.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: p.gateway ? maxTokens : Math.min(maxTokens, 8000) }),
  };
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Gateways route to many models; not all accept a JSON schema. Retry once in plain JSON mode.
  if (!res.ok && p.gateway && !ai.jsonMode && res.status === 400 && /response_format|json_schema|schema/i.test(JSON.stringify(data))) {
    return openaiCompatibleObject({ ai: { ...ai, jsonMode: true }, system, prompt, schema, name, maxTokens });
  }
  if (!res.ok) throw new AIError(`${p.label}: ${data.error?.message || `HTTP ${res.status}`}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new AIError(`${p.label} returned no result (${data.choices?.[0]?.finish_reason || 'empty'})`);
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new AIError(`${p.label} did not return valid JSON`); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new AIError(`${p.label} returned JSON in the wrong shape: ${result.error.issues[0]?.path.join('.')} ${result.error.issues[0]?.message}`);
  return result.data;
}

// Tiny call for the "Test connection" button.
export async function testAI(ai) {
  const out = await generateObject({
    ai, name: 'ping', effort: 'low', maxTokens: 2000,
    system: 'You answer health checks.',
    prompt: 'Reply with ok = true and the name of the AI model you are.',
    schema: z.object({ ok: z.boolean(), model: z.string() }),
  });
  return out;
}
