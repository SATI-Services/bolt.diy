import type { LoaderFunction } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import { LLMManager } from '~/lib/modules/llm/manager';

interface ConfiguredProvider {
  name: string;
  isConfigured: boolean;
  configMethod: 'environment' | 'none';
}

interface ConfiguredProvidersResponse {
  providers: ConfiguredProvider[];
}

/**
 * API endpoint that detects which providers are configured via environment variables.
 * Checks ALL providers so the client can auto-disable those without valid keys.
 */
export const loader: LoaderFunction = async ({ context }) => {
  try {
    const llmManager = LLMManager.getInstance(context?.cloudflare?.env as any);
    const allProviders = llmManager.getAllProviders();
    const configuredProviders: ConfiguredProvider[] = [];

    for (const providerInstance of allProviders) {
      let isConfigured = false;
      let configMethod: 'environment' | 'none' = 'none';

      const config = providerInstance.config;

      // Check baseUrlKey (for providers like Ollama, LMStudio, OpenAILike)
      if (config.baseUrlKey) {
        const baseUrlEnvVar = config.baseUrlKey;
        const envBaseUrl =
          (context?.cloudflare?.env as Record<string, any>)?.[baseUrlEnvVar] ||
          process.env[baseUrlEnvVar] ||
          llmManager.env[baseUrlEnvVar];

        const isValidEnvValue =
          envBaseUrl &&
          typeof envBaseUrl === 'string' &&
          envBaseUrl.trim().length > 0 &&
          !envBaseUrl.includes('your_') &&
          !envBaseUrl.includes('_here') &&
          envBaseUrl.startsWith('http');

        if (isValidEnvValue) {
          isConfigured = true;
          configMethod = 'environment';
        }
      }

      // Check apiTokenKey (API keys for cloud providers)
      if (config.apiTokenKey && !isConfigured) {
        const apiTokenEnvVar = config.apiTokenKey;
        const envApiToken =
          (context?.cloudflare?.env as Record<string, any>)?.[apiTokenEnvVar] ||
          process.env[apiTokenEnvVar] ||
          llmManager.env[apiTokenEnvVar];

        const isValidApiToken =
          envApiToken &&
          typeof envApiToken === 'string' &&
          envApiToken.trim().length > 0 &&
          !envApiToken.includes('your_') &&
          !envApiToken.includes('_here') &&
          envApiToken.length > 10;

        if (isValidApiToken) {
          isConfigured = true;
          configMethod = 'environment';
        }
      }

      configuredProviders.push({
        name: providerInstance.name,
        isConfigured,
        configMethod,
      });
    }

    return json<ConfiguredProvidersResponse>({
      providers: configuredProviders,
    });
  } catch (error) {
    console.error('Error detecting configured providers:', error);

    return json<ConfiguredProvidersResponse>({
      providers: [],
    });
  }
};
