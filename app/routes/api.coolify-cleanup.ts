import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';

async function coolifyCleanupAction({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const { coolifyUrl, token, appUuid } = await request.json();

    if (!coolifyUrl || !token || !appUuid) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }

    const apiUrl = `${coolifyUrl.replace(/\/+$/, '')}/api/v1/applications/${appUuid}`;

    const response = await fetch(apiUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return json({ error: 'Failed to cleanup container' }, { status: response.status });
    }

    return json({ success: true });
  } catch (error) {
    console.error('Coolify cleanup error:', error);
    return json({ error: 'Cleanup failed' }, { status: 500 });
  }
}

export const action = coolifyCleanupAction;
