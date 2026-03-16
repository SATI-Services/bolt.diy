// LLM calling module — wraps Vercel AI SDK for the agent service.
// Supports Anthropic, OpenAI, and Google providers.

import { streamText as aiStreamText, generateText as aiGenerateText } from 'ai';

// ---------------------------------------------------------------------------
// Provider setup — lazy-loaded to avoid import errors when keys are missing
// ---------------------------------------------------------------------------

let _providers = null;

async function getProviders() {
  if (_providers) return _providers;

  _providers = {};

  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    _providers.anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  } catch { /* provider not available */ }

  try {
    const { createOpenAI } = await import('@ai-sdk/openai');
    _providers.openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  } catch { /* provider not available */ }

  try {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    _providers.google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
  } catch { /* provider not available */ }

  return _providers;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

const PROVIDER_MODEL_MAP = {
  Anthropic: { sdk: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  OpenAI: { sdk: 'openai', defaultModel: 'gpt-4o' },
  Google: { sdk: 'google', defaultModel: 'gemini-2.0-flash' },
};

function resolveModel(providerName, modelName) {
  const mapping = PROVIDER_MODEL_MAP[providerName];

  if (!mapping) {
    throw new Error(`Unsupported provider: ${providerName}`);
  }

  return {
    sdkName: mapping.sdk,
    modelId: modelName || mapping.defaultModel,
  };
}

async function getModelInstance(providerName, modelName) {
  const providers = await getProviders();
  const { sdkName, modelId } = resolveModel(providerName, modelName);
  const provider = providers[sdkName];

  if (!provider) {
    throw new Error(`Provider ${providerName} (${sdkName}) not configured — missing API key?`);
  }

  return provider(modelId);
}

// ---------------------------------------------------------------------------
// Token limit helpers
// ---------------------------------------------------------------------------

function getMaxTokens(modelId) {
  const name = (modelId || '').toLowerCase();

  if (name.includes('claude') && name.includes('opus')) return 32000;
  if (name.includes('claude') && name.includes('sonnet')) return 64000;
  if (name.includes('claude') && name.includes('haiku')) return 8192;
  if (name.includes('claude')) return 32000;
  if (name.includes('gpt-4o') || name.includes('gpt-5')) return 16384;
  if (name.includes('gemini')) return 8192;

  return 16384;
}

function isReasoningModel(modelId) {
  const name = (modelId || '').toLowerCase();
  return name.includes('o1') || name.includes('o3') || name.includes('gpt-5');
}

// ---------------------------------------------------------------------------
// Streaming LLM call
// ---------------------------------------------------------------------------

/**
 * Stream an LLM response.
 * @param {Object} opts
 * @param {string} opts.provider - Provider name (e.g. 'Anthropic')
 * @param {string} opts.model - Model name/ID
 * @param {string} opts.system - System prompt
 * @param {Array} opts.messages - Array of { role, content } messages
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {AsyncIterable} AI SDK stream result
 */
export async function streamLLM({ provider, model, system, messages, abortSignal }) {
  const modelInstance = await getModelInstance(provider, model);
  const maxTokens = getMaxTokens(model);
  const reasoning = isReasoningModel(model);

  const tokenParams = reasoning
    ? { maxCompletionTokens: maxTokens }
    : { maxTokens };

  const result = await aiStreamText({
    model: modelInstance,
    system,
    messages,
    ...tokenParams,
    ...(reasoning ? { temperature: 1 } : {}),
    abortSignal,
  });

  return result;
}

/**
 * Non-streaming LLM call (for simple operations like title generation).
 */
export async function generateLLM({ provider, model, system, messages }) {
  const modelInstance = await getModelInstance(provider, model);
  const maxTokens = getMaxTokens(model);

  const result = await aiGenerateText({
    model: modelInstance,
    system,
    messages,
    maxTokens: Math.min(maxTokens, 200),
  });

  return result;
}
