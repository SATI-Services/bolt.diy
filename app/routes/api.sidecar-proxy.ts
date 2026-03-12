import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';

/**
 * Server-side proxy for sidecar HTTP API calls.
 * Routes browser requests to the sidecar container, avoiding CORS and mixed-content issues.
 * Supports both JSON responses and SSE streaming (for /exec-stream).
 */
async function sidecarProxyAction({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const { sidecarUrl, token, endpoint, method, body, stream } = await request.json<{
      sidecarUrl: string;
      token: string;
      endpoint: string;
      method?: string;
      body?: unknown;
      stream?: boolean;
    }>();

    if (!sidecarUrl || !endpoint) {
      return json({ error: 'Missing required fields: sidecarUrl, endpoint' }, { status: 400 });
    }

    const apiUrl = `${sidecarUrl.replace(/\/+$/, '')}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(apiUrl, {
      method: method || 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // For streaming responses, pass through the body directly
    if (stream && response.body) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();

    return json(data, { status: response.status });
  } catch (error) {
    console.error('Sidecar proxy error:', error);
    return json({ error: 'Sidecar proxy request failed' }, { status: 502 });
  }
}

export const action = sidecarProxyAction;
