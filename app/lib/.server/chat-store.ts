import fs from 'node:fs';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ChatStore');

const DATA_DIR = process.env.CHAT_DATA_DIR || '/home/bolt.diy/data/chats';

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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function chatPath(urlId: string): string {
  // Sanitize to prevent path traversal
  const safe = urlId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function saveChat(urlId: string, data: ChatData): Promise<void> {
  try {
    ensureDataDir();

    const filePath = chatPath(urlId);
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    logger.debug(`Chat saved: ${urlId}`);
  } catch (error) {
    logger.error('Failed to save chat:', error);
    throw error;
  }
}

export async function loadChat(urlId: string): Promise<ChatData | null> {
  try {
    const filePath = chatPath(urlId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');

    return JSON.parse(raw) as ChatData;
  } catch (error) {
    logger.error('Failed to load chat:', error);
    return null;
  }
}

export async function listChats(): Promise<ChatSummary[]> {
  try {
    ensureDataDir();

    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    const summaries: ChatSummary[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as ChatData;
        summaries.push({
          urlId: data.urlId,
          description: data.description,
          updatedAt: data.updatedAt,
        });
      } catch {
        // skip malformed files
      }
    }

    return summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    logger.error('Failed to list chats:', error);
    return [];
  }
}
