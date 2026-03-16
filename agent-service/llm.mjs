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
