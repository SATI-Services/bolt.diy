/*
 * LLM provider module — resolves provider + model into an AI SDK model instance.
 * Used by loop.mjs which calls streamText directly with native tools.
 */

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
  } catch {
    /* provider not available */
  }

  try {
    const { createOpenAI } = await import('@ai-sdk/openai');

    // OpenRouter uses the OpenAI-compatible API
    if (process.env.OPEN_ROUTER_API_KEY) {
      _providers.openrouter = createOpenAI({
        apiKey: process.env.OPEN_ROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    }

    _providers.openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  } catch {
    /* provider not available */
  }

  try {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    _providers.google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
  } catch {
    /* provider not available */
  }

  return _providers;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

const PROVIDER_MODEL_MAP = {
  Anthropic: { sdk: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
  OpenAI: { sdk: 'openai', defaultModel: 'gpt-4o' },
  Google: { sdk: 'google', defaultModel: 'gemini-2.0-flash' },
  OpenRouter: { sdk: 'openrouter', defaultModel: 'anthropic/claude-opus-4-6' },
};

function resolveModel(providerName, modelName) {
  const mapping = PROVIDER_MODEL_MAP[providerName];

  if (!mapping) {
    // Fall back to OpenRouter for unknown providers (most models available there)
    if (_providers?.openrouter) {
      return { sdkName: 'openrouter', modelId: modelName || 'anthropic/claude-opus-4-6' };
    }

    throw new Error(`Unsupported provider: ${providerName}`);
  }

  return {
    sdkName: mapping.sdk,
    modelId: modelName || mapping.defaultModel,
  };
}

export async function getModelInstance(providerName, modelName) {
  const providers = await getProviders();
  const { sdkName, modelId } = resolveModel(providerName, modelName);
  const provider = providers[sdkName];

  if (!provider) {
    throw new Error(`Provider ${providerName} (${sdkName}) not configured — missing API key?`);
  }

  return provider(modelId);
}

// ---------------------------------------------------------------------------
// Token limit helpers (exported for use by loop.mjs)
// ---------------------------------------------------------------------------

export function getMaxTokens(modelId) {
  const name = (modelId || '').toLowerCase();

  if (name.includes('claude') && name.includes('opus')) return 32000;
  if (name.includes('claude') && name.includes('sonnet')) return 64000;
  if (name.includes('claude') && name.includes('haiku')) return 8192;
  if (name.includes('claude')) return 32000;
  if (name.includes('gpt-4o') || name.includes('gpt-5')) return 16384;
  if (name.includes('gemini')) return 8192;

  return 16384;
}

export function isReasoningModel(modelId) {
  const name = (modelId || '').toLowerCase();
  return name.includes('o1') || name.includes('o3') || name.includes('gpt-5');
}

// ---------------------------------------------------------------------------
// Context window size — fetched from OpenRouter, cached, with static fallback
// ---------------------------------------------------------------------------

const _contextWindowCache = new Map();
let _orModelsCache = null;
let _orModelsFetchedAt = 0;

const STATIC_CONTEXT_WINDOWS = {
  'claude-opus-4': 1000000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4': 200000,
  'claude-3.5': 200000,
  'gpt-4o': 128000,
  'gpt-4.1': 1000000,
  'gpt-5': 200000,
  'o3': 200000,
  'o1': 200000,
  'gemini-2': 1000000,
  'gemini-1.5': 1000000,
  'deepseek': 128000,
};

async function fetchOpenRouterModels() {
  // Cache for 1 hour
  if (_orModelsCache && Date.now() - _orModelsFetchedAt < 3600000) {
    return _orModelsCache;
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: process.env.OPEN_ROUTER_API_KEY
        ? { Authorization: `Bearer ${process.env.OPEN_ROUTER_API_KEY}` }
        : {},
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    _orModelsCache = data?.data || [];
    _orModelsFetchedAt = Date.now();
    return _orModelsCache;
  } catch {
    return null;
  }
}

export async function getContextWindowSize(modelId) {
  if (!modelId) return 128000;

  // Check cache first
  if (_contextWindowCache.has(modelId)) {
    return _contextWindowCache.get(modelId);
  }

  // Try OpenRouter API (covers all models they support)
  const models = await fetchOpenRouterModels();

  if (models) {
    const match = models.find((m) => m.id === modelId || modelId.includes(m.id) || m.id.includes(modelId));

    if (match?.context_length) {
      _contextWindowCache.set(modelId, match.context_length);
      return match.context_length;
    }
  }

  // Fall back to static lookup
  const name = modelId.toLowerCase();

  for (const [key, size] of Object.entries(STATIC_CONTEXT_WINDOWS)) {
    if (name.includes(key)) {
      _contextWindowCache.set(modelId, size);
      return size;
    }
  }

  const defaultSize = 128000;
  _contextWindowCache.set(modelId, defaultSize);
  return defaultSize;
}
