import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { loadChat, saveChat, type ChatData } from '~/lib/.server/chat-store';

export async function loader({ params }: LoaderFunctionArgs) {
  const urlId = params.id;

  if (!urlId) {
    return json({ error: 'Missing chat ID' }, { status: 400 });
  }

  const chat = await loadChat(urlId);

  if (!chat) {
    return json({ error: 'Chat not found' }, { status: 404 });
  }

  return json(chat);
}

export async function action({ params, request }: ActionFunctionArgs) {
  const urlId = params.id;

  if (!urlId) {
    return json({ error: 'Missing chat ID' }, { status: 400 });
  }

  if (request.method === 'PUT') {
    try {
      const data = (await request.json()) as ChatData;

      await saveChat(urlId, {
        ...data,
        urlId,
        updatedAt: new Date().toISOString(),
      });

      return json({ ok: true });
    } catch (error) {
      console.error('Failed to save chat:', error);
      return json({ error: 'Failed to save chat' }, { status: 500 });
    }
  }

  return json({ error: 'Method not allowed' }, { status: 405 });
}
