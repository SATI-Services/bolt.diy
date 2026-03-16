import { map } from 'nanostores';
import type { CoolifyContainerState } from '~/types/coolify';
import { getCoolifyFileSyncService } from '~/lib/services/coolifyFileSyncService';
import { createScopedLogger } from '~/utils/logger';
import { toast } from 'react-toastify';

const logger = createScopedLogger('CoolifyPreview');

const storedContainers = typeof window !== 'undefined' ? localStorage.getItem('coolify_containers') : null;

export const coolifyContainers = map<Record<string, CoolifyContainerState>>(
  storedContainers ? JSON.parse(storedContainers) : {},
);

function persistContainers() {
  if (typeof window !== 'undefined') {
    localStorage.setItem('coolify_containers', JSON.stringify(coolifyContainers.get()));
  }
}

/**
 * Re-key a container entry when the real chatId becomes available.
 * Moves container from tempId to realId in the containers map.
 */
export function rekeyContainer(tempId: string, realId: string) {
  if (tempId === realId) {
    return;
  }

  const containers = coolifyContainers.get();
  const container = containers[tempId];

  if (!container) {
    return;
  }

  coolifyContainers.setKey(realId, { ...container, chatId: realId });
  coolifyContainers.setKey(tempId, undefined as any);

  // Clean up the old key by rebuilding the map without it
  const updated = { ...coolifyContainers.get() };
  delete updated[tempId];
  coolifyContainers.set(updated);

  persistContainers();
  logger.debug(`Re-keyed container from ${tempId} to ${realId}`);
}

export async function provisionContainer(chatId: string): Promise<CoolifyContainerState | null> {
  // Check if container already exists for this chat
  const existing = coolifyContainers.get()[chatId];

  if (existing && existing.status === 'running') {
    return existing;
  }

  const toastId = toast.loading('Claiming container from pool...', { autoClose: false });

  try {
    logger.debug(`Claiming container from pool for chat ${chatId}`);

    const resp = await fetch('/api/container-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', chatId }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Pool claim failed' }));
      throw new Error((err as any).error || `Pool claim failed (${resp.status})`);
    }

    const { containerId, domain, sidecarUrl, token } = (await resp.json()) as {
      containerId: string;
      domain: string;
      sidecarUrl: string;
      token: string;
    };

    const containerState: CoolifyContainerState = {
      appUuid: containerId,
      domain: `https://${domain}`,
      wsUrl: sidecarUrl,
      sidecarToken: token,
      status: 'running',
      chatId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    coolifyContainers.setKey(chatId, containerState);
    persistContainers();

    logger.debug(`Container claimed for chat ${chatId}: ${domain} (sidecar: ${sidecarUrl})`);
    toast.update(toastId, { render: 'Container is ready', type: 'success', isLoading: false, autoClose: 2000 });

    return containerState;
  } catch (error) {
    logger.error('Failed to claim container from pool:', error);
    toast.update(toastId, {
      render: `Container claim failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      type: 'error',
      isLoading: false,
      autoClose: 5000,
    });

    return null;
  }
}

export async function destroyContainer(chatId: string): Promise<void> {
  const container = coolifyContainers.get()[chatId];

  if (!container) {
    return;
  }

  try {
    // Disconnect sync service
    const syncService = getCoolifyFileSyncService();
    syncService.disconnect();

    // Release container back to pool
    await fetch('/api/container-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release', containerId: container.appUuid }),
    });

    // Remove from store
    const containers = { ...coolifyContainers.get() };
    delete containers[chatId];
    coolifyContainers.set(containers);
    persistContainers();

    logger.debug(`Container released for chat ${chatId}`);
  } catch (error) {
    logger.error('Failed to release container:', error);
  }
}

export async function cleanupStaleContainers(): Promise<void> {
  const containers = coolifyContainers.get();
  const now = Date.now();
  const ttlMs = 60 * 60 * 1000; // 60 minutes default TTL

  for (const [chatId, container] of Object.entries(containers)) {
    if (now - container.lastActivity > ttlMs) {
      logger.debug(`Cleaning up stale container for chat ${chatId}`);
      await destroyContainer(chatId);
    }
  }
}

export function updateContainerActivity(chatId: string) {
  const container = coolifyContainers.get()[chatId];

  if (container) {
    coolifyContainers.setKey(chatId, { ...container, lastActivity: Date.now() });
    persistContainers();
  }
}

// Start periodic cleanup
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startContainerCleanup() {
  if (cleanupInterval) {
    return;
  }

  cleanupInterval = setInterval(
    () => {
      cleanupStaleContainers();
    },
    5 * 60 * 1000,
  ); // Every 5 minutes
}

export function stopContainerCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
