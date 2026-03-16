import { type ActionFunctionArgs, json } from '@remix-run/cloudflare';

const POOL_MANAGER_URL = (typeof process !== 'undefined' && process.env?.POOL_MANAGER_URL) || 'http://localhost:9850';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json<{ action: string; chatId?: string; containerId?: string }>();

  try {
    switch (body.action) {
      case 'claim': {
        const resp = await fetch(`${POOL_MANAGER_URL}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: body.chatId }),
        });

        if (!resp.ok) {
          return json({ error: 'Pool claim failed', status: resp.status }, { status: 502 });
        }

        return json(await resp.json());
      }

      case 'release': {
        const resp = await fetch(`${POOL_MANAGER_URL}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ containerId: body.containerId }),
        });

        if (!resp.ok) {
          return json({ error: 'Pool release failed' }, { status: 502 });
        }

        return json(await resp.json());
      }

      case 'status': {
        const resp = await fetch(`${POOL_MANAGER_URL}/status`);

        if (!resp.ok) {
          return json({ error: 'Pool status failed' }, { status: 502 });
        }

        return json(await resp.json());
      }

      default:
        return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (error: any) {
    return json({ error: `Pool manager unreachable: ${error.message}` }, { status: 502 });
  }
}
