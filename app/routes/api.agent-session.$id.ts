import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from '@remix-run/cloudflare';

const AGENT_SERVICE_URL = (typeof process !== 'undefined' && process.env?.AGENT_SERVICE_URL) || 'http://localhost:9860';

// GET /api/agent-session/:id → full session state (for reconnection)
export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;

  try {
    const resp = await fetch(`${AGENT_SERVICE_URL}/sessions/${id}`);

    if (!resp.ok) {
      const errBody = (await resp.json().catch(() => ({}))) as Record<string, string>;
      return json({ error: errBody.error || 'Session not found' }, { status: resp.status });
    }

    return json(await resp.json());
  } catch (error: any) {
    return json({ error: `Agent service unreachable: ${error.message}` }, { status: 502 });
  }
}

// POST /api/agent-session/:id → dispatch actions (message, stop)
export async function action({ params, request }: ActionFunctionArgs) {
  const { id } = params;
  const body = await request.json<{ action: string; content?: string; provider?: string; model?: string }>();

  try {
    switch (body.action) {
      case 'message': {
        const resp = await fetch(`${AGENT_SERVICE_URL}/sessions/${id}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: body.content,
            provider: body.provider,
            model: body.model,
          }),
        });

        if (!resp.ok) {
          const errBody = (await resp.json().catch(() => ({}))) as Record<string, string>;
          return json({ error: errBody.error || 'Send message failed' }, { status: resp.status });
        }

        return json(await resp.json());
      }

      case 'stop': {
        const resp = await fetch(`${AGENT_SERVICE_URL}/sessions/${id}/stop`, {
          method: 'POST',
        });

        if (!resp.ok) {
          return json({ error: 'Stop failed' }, { status: resp.status });
        }

        return json(await resp.json());
      }

      case 'delete': {
        const resp = await fetch(`${AGENT_SERVICE_URL}/sessions/${id}`, {
          method: 'DELETE',
        });

        if (!resp.ok) {
          return json({ error: 'Delete failed' }, { status: resp.status });
        }

        return json(await resp.json());
      }

      default:
        return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (error: any) {
    return json({ error: `Agent service unreachable: ${error.message}` }, { status: 502 });
  }
}
