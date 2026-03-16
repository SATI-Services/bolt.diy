import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ChatStore');

const STORE_URL = 'http://127.0.0.1:9850';

export interface ChatData {
  urlId: string;
  id: string;
  description?: string;
  messages: unknown[];
  metadata?: unknown;
  coolifyContainerState?: unknown;
  updatedAt: string;
}

export interface ChatSummary {
  urlId: string;
  description?: string;
  updatedAt: string;
}

export async function saveChat(urlId: string, data: ChatData): Promise<void> {
  const resp = await fetch(`${STORE_URL}/chats/${encodeURIComponent(urlId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const err = await resp.text();
    logger.error('Failed to save chat:', err);
    throw new Error(`Failed to save chat: ${err}`);
  }

  logger.debug(`Chat saved: ${urlId}`);
}

export async function loadChat(urlId: string): Promise<ChatData | null> {
  try {
    const resp = await fetch(`${STORE_URL}/chats/${encodeURIComponent(urlId)}`);

    if (resp.status === 404) {
      return null;
    }

    if (!resp.ok) {
      logger.error('Failed to load chat:', await resp.text());
      return null;
    }

    return (await resp.json()) as ChatData;
  } catch (error) {
    logger.error('Failed to load chat:', error);
    return null;
  }
}

export async function listChats(): Promise<ChatSummary[]> {
  try {
    const resp = await fetch(`${STORE_URL}/chats`);

    if (!resp.ok) {
      return [];
    }

    return (await resp.json()) as ChatSummary[];
  } catch (error) {
    logger.error('Failed to list chats:', error);
    return [];
  }
}
