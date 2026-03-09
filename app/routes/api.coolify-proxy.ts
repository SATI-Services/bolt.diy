import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';

async function coolifyProxyAction({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const { coolifyUrl, token, endpoint, method, body } = await request.json();

    if (!coolifyUrl || !token || !endpoint) {
      return json({ error: 'Missing required fields: coolifyUrl, token, endpoint' }, { status: 400 });
    }

    const apiUrl = `${coolifyUrl.replace(/\/+$/, '')}/api/v1${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const response = await fetch(apiUrl, {
      method: method || 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return json({ status: response.status, data }, { status: response.status >= 400 ? response.status : 200 });
  } catch (error) {
    console.error('Coolify proxy error:', error);
    return json({ error: 'Proxy request failed' }, { status: 500 });
  }
}

export const action = coolifyProxyAction;
