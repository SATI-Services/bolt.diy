import { atom, map } from 'nanostores';
import type { CoolifyContainerState } from '~/types/coolify';
import { coolifyConnection, coolifySettings } from './coolify';
import * as coolifyApi from '~/lib/services/coolifyApiClient';
import { getCoolifyFileSyncService } from '~/lib/services/coolifyFileSyncService';
import { createScopedLogger } from '~/utils/logger';
import { toast } from 'react-toastify';

const logger = createScopedLogger('CoolifyPreview');

const storedContainers =
  typeof window !== 'undefined' ? localStorage.getItem('coolify_containers') : null;

export const coolifyContainers = map<Record<string, CoolifyContainerState>>(
  storedContainers ? JSON.parse(storedContainers) : {},
);

function persistContainers() {
  if (typeof window !== 'undefined') {
    localStorage.setItem('coolify_containers', JSON.stringify(coolifyContainers.get()));
  }
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function provisionContainer(chatId: string): Promise<CoolifyContainerState | null> {
  const connection = coolifyConnection.get();
  const settings = coolifySettings.get();

  if (!connection.connected || !settings.enabled) {
    return null;
  }

  // Check if container already exists for this chat
  const existing = coolifyContainers.get()[chatId];

  if (existing && existing.status === 'running') {
    return existing;
  }

  const sidecarToken = generateToken();
  const appName = `bolt-preview-${chatId.slice(0, 8)}-${Date.now().toString(36)}`;

  try {
    logger.debug(`Provisioning container for chat ${chatId}`);

    const apiOptions = { url: connection.url, token: connection.token };

    // Create the application
    const app = await coolifyApi.createApp(apiOptions, {
      serverUuid: connection.serverUuid,
      projectUuid: connection.projectUuid,
      environmentName: connection.environmentName,
      image: settings.sidecarImage,
      name: appName,
      ports: '3000,9838',
    });

    // Set sidecar token env var
    await coolifyApi.setEnvVars(apiOptions, app.uuid, [
      { key: 'SIDECAR_TOKEN', value: sidecarToken },
    ]);

    const containerState: CoolifyContainerState = {
      appUuid: app.uuid,
      domain: app.fqdn || `${appName}.preview.yourdomain.com`,
      wsUrl: '',
      sidecarToken,
      status: 'provisioning',
      chatId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    coolifyContainers.setKey(chatId, containerState);
    persistContainers();

    // Poll until running
    const maxPolls = 30;
    let polls = 0;

    while (polls < maxPolls) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      polls++;

      try {
        const appStatus = await coolifyApi.getApp(apiOptions, app.uuid);

        if (appStatus.status === 'running') {
          const domain = appStatus.fqdn || containerState.domain;
          // Derive WS URL from domain - replace http(s) with ws(s) and add sidecar port
          const wsUrl = domain.replace(/^https?:\/\//, 'wss://').replace(/\/?$/, ':9838');

          const updatedState: CoolifyContainerState = {
            ...containerState,
            domain,
            wsUrl,
            status: 'running',
            lastActivity: Date.now(),
          };

          coolifyContainers.setKey(chatId, updatedState);
          persistContainers();

          logger.debug(`Container running for chat ${chatId}: ${domain}`);
          toast.success('Coolify preview container is ready');

          return updatedState;
        }
      } catch (error) {
        logger.error('Error polling container status:', error);
      }
    }

    // Timeout
    const timeoutState: CoolifyContainerState = {
      ...containerState,
      status: 'error',
    };
    coolifyContainers.setKey(chatId, timeoutState);
    persistContainers();
    toast.error('Coolify container provisioning timed out');

    return null;
  } catch (error) {
    logger.error('Failed to provision container:', error);
    toast.error('Failed to provision Coolify container');

    return null;
  }
}

export async function destroyContainer(chatId: string): Promise<void> {
  const container = coolifyContainers.get()[chatId];

  if (!container) {
    return;
  }

  const connection = coolifyConnection.get();

  try {
    // Disconnect sync service
    const syncService = getCoolifyFileSyncService();
    syncService.disconnect();

    // Delete the app from Coolify
    await coolifyApi.deleteApp({ url: connection.url, token: connection.token }, container.appUuid);

    // Remove from store
    const containers = { ...coolifyContainers.get() };
    delete containers[chatId];
    coolifyContainers.set(containers);
    persistContainers();

    logger.debug(`Container destroyed for chat ${chatId}`);
  } catch (error) {
    logger.error('Failed to destroy container:', error);
  }
}

export async function cleanupStaleContainers(): Promise<void> {
  const containers = coolifyContainers.get();
  const settings = coolifySettings.get();
  const now = Date.now();
  const ttlMs = settings.containerTtl * 60 * 1000;

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

  cleanupInterval = setInterval(() => {
    cleanupStaleContainers();
  }, 5 * 60 * 1000); // Every 5 minutes
}

export function stopContainerCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
