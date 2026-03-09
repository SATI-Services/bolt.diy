import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('CoolifyApiClient');

interface CoolifyApiOptions {
  url: string;
  token: string;
}

const isBrowser = typeof window !== 'undefined';

async function coolifyFetch(
  options: CoolifyApiOptions,
  endpoint: string,
  method: string = 'GET',
  body?: unknown,
): Promise<Response> {
  const { url, token } = options;

  // In the browser, route through our server-side proxy to avoid CORS
  if (isBrowser) {
    const proxyResponse = await fetch('/api/coolify-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coolifyUrl: url, token, endpoint, method, body }),
    });

    // Unwrap the proxy response to look like a direct API response
    const result = await proxyResponse.json();
    const responseBody = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);

    return new Response(responseBody, {
      status: result.status || proxyResponse.status,
      headers: { 'Content-Type': typeof result.data === 'string' ? 'text/plain' : 'application/json' },
    });
  }

  // Server-side: call Coolify API directly
  const apiUrl = `${url.replace(/\/+$/, '')}/api/v1${endpoint}`;

  return fetch(apiUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function testConnection(options: CoolifyApiOptions): Promise<{ ok: boolean; version?: string }> {
  try {
    const response = await coolifyFetch(options, '/version');

    if (!response.ok) {
      return { ok: false };
    }

    const data = await response.text();
    return { ok: true, version: data.replace(/"/g, '') };
  } catch (error) {
    logger.error('Connection test failed:', error);
    return { ok: false };
  }
}

export async function listServers(
  options: CoolifyApiOptions,
): Promise<Array<{ uuid: string; name: string; ip: string }>> {
  const response = await coolifyFetch(options, '/servers');

  if (!response.ok) {
    throw new Error(`Failed to list servers: ${response.statusText}`);
  }

  return response.json();
}

export async function listProjects(
  options: CoolifyApiOptions,
): Promise<Array<{ uuid: string; name: string }>> {
  const response = await coolifyFetch(options, '/projects');

  if (!response.ok) {
    throw new Error(`Failed to list projects: ${response.statusText}`);
  }

  return response.json();
}

export async function createApp(
  options: CoolifyApiOptions,
  params: {
    serverUuid: string;
    projectUuid: string;
    environmentName: string;
    image: string;
    name: string;
    ports: string;
    portsMappings?: string;
  },
): Promise<{ uuid: string; domains?: string }> {
  const body: Record<string, unknown> = {
    server_uuid: params.serverUuid,
    project_uuid: params.projectUuid,
    environment_name: params.environmentName,
    docker_registry_image_name: params.image,
    name: params.name,
    ports_exposes: params.ports,
    instant_deploy: false,
  };

  if (params.portsMappings) {
    body.ports_mappings = params.portsMappings;
  }

  const response = await coolifyFetch(options, '/applications/dockerimage', 'POST', body);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create app: ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

export async function deleteApp(options: CoolifyApiOptions, uuid: string): Promise<void> {
  const response = await coolifyFetch(options, `/applications/${uuid}`, 'DELETE');

  if (!response.ok) {
    throw new Error(`Failed to delete app: ${response.statusText}`);
  }
}

export async function startApp(options: CoolifyApiOptions, uuid: string): Promise<void> {
  const response = await coolifyFetch(options, `/applications/${uuid}/start`, 'POST');

  if (!response.ok) {
    throw new Error(`Failed to start app: ${response.statusText}`);
  }
}

export async function getApp(
  options: CoolifyApiOptions,
  uuid: string,
): Promise<{ uuid: string; status: string; fqdn?: string; ports_mappings?: string }> {
  const response = await coolifyFetch(options, `/applications/${uuid}`);

  if (!response.ok) {
    throw new Error(`Failed to get app: ${response.statusText}`);
  }

  return response.json();
}

export async function setEnvVars(
  options: CoolifyApiOptions,
  uuid: string,
  vars: Array<{ key: string; value: string }>,
): Promise<void> {
  for (const envVar of vars) {
    const response = await coolifyFetch(options, `/applications/${uuid}/envs`, 'POST', {
      key: envVar.key,
      value: envVar.value,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set env var ${envVar.key}: ${response.statusText} - ${errorText}`);
    }
  }
}

export async function updateAppDomain(
  options: CoolifyApiOptions,
  uuid: string,
  fqdn: string,
): Promise<void> {
  const response = await coolifyFetch(options, `/applications/${uuid}`, 'PATCH', {
    domains: fqdn,
  });

  if (!response.ok) {
    throw new Error(`Failed to update app domain: ${response.statusText}`);
  }
}
