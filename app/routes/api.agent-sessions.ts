import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from '@remix-run/cloudflare';

const AGENT_SERVICE_URL = (typeof process !== 'undefined' && process.env?.AGENT_SERVICE_URL) || 'http://localhost:9860';

// GET /api/agent-sessions → list all sessions
export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const resp = await fetch(`${AGENT_SERVICE_URL}/sessions`);

    if (!resp.ok) {
      return json({ error: 'Agent service unavailable' }, { status: 502 });
    }

    return json(await resp.json());
  } catch (error: any) {
    return json({ error: `Agent service unreachable: ${error.message}` }, { status: 502 });
  }
}

// POST /api/agent-sessions → create a new session
export async function action({ request }: ActionFunctionArgs) {
  try {
    const body = await request.json();

    const resp = await fetch(`${AGENT_SERVICE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = (await resp.json().catch(() => ({}))) as Record<string, string>;
      return json({ error: errBody.error || 'Session creation failed' }, { status: resp.status });
    }

    return json(await resp.json(), { status: 201 });
  } catch (error: any) {
    return json({ error: `Agent service unreachable: ${error.message}` }, { status: 502 });
  }
}
