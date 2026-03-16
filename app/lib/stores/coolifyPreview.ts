import { map } from 'nanostores';
import type { CoolifyContainerState } from '~/types/coolify';
import { coolifyConnection, coolifySettings } from './coolify';
import * as coolifyApi from '~/lib/services/coolifyApiClient';
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

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);

  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Generate a unique host port for the sidecar WS (range 10000-19999)
function generateSidecarPort(): number {
  return 10000 + Math.floor(Math.random() * 10000);
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
  const sidecarPort = generateSidecarPort();
  const appName = `bolt-preview-${chatId.slice(0, 8)}-${Date.now().toString(36)}`;

  const toastId = toast.loading('Creating preview container...', { autoClose: false });

  try {
    logger.debug(`Provisioning container for chat ${chatId} (sidecar port: ${sidecarPort})`);

    const apiOptions = { url: connection.url, token: connection.token };

    // Create the application with host port mapping for sidecar HTTP API
    const app = await coolifyApi.createApp(apiOptions, {
      serverUuid: connection.serverUuid,
      projectUuid: connection.projectUuid,
      environmentName: connection.environmentName,
      image: settings.sidecarImage,
      name: appName,
      ports: '3000,9838,9839',
      portsMappings: `${sidecarPort}:9839`,
    });

    // Set sidecar token env var BEFORE starting the app
    await coolifyApi.setEnvVars(apiOptions, app.uuid, [{ key: 'SIDECAR_TOKEN', value: sidecarToken }]);

    // Set custom domain under our wildcard so Traefik routes it correctly
    const customDomain = `https://${appName}.bolt.rdrt.org`;

    try {
      await coolifyApi.updateAppDomain(apiOptions, app.uuid, customDomain);
    } catch (e) {
      logger.warn('Failed to set custom domain, using Coolify default:', e);
    }

    // NOTE: startApp is deferred to the polling loop below.
    // Making 4+ rapid sequential fetch calls to /api/coolify-proxy from the browser
    // causes workerd to silently drop requests. Starting inside the poll avoids this.

    /*
     * Sidecar HTTP API URL — accessed via server-side proxy (/api/sidecar-proxy).
     * Use localhost because the proxy runs on the same machine as the containers.
     * Using the external hostname would hit the firewall on random high ports.
     */
    const sidecarUrl = `http://localhost:${sidecarPort}`;

    const containerState: CoolifyContainerState = {
      appUuid: app.uuid,
      domain: customDomain,
      wsUrl: sidecarUrl, // reusing wsUrl field for sidecar HTTP URL
      sidecarToken,
      status: 'provisioning',
      chatId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    coolifyContainers.setKey(chatId, containerState);
    persistContainers();

    // Poll until running — check sidecar health directly (most reliable)
    const maxPolls = 30;
    let polls = 0;
    let appStarted = false;

    while (polls < maxPolls) {
      // Sleep FIRST to give workerd time to recover from the rapid create/env/domain fetches
      await new Promise((resolve) => setTimeout(resolve, 5000));
      polls++;

      // Start the app after the first sleep (deferred to avoid workerd fetch-dropping)
      if (!appStarted) {
        try {
          toast.update(toastId, { render: 'Starting container...' });
          logger.debug(`Starting app ${app.uuid}...`);
          await coolifyApi.startApp(apiOptions, app.uuid);
          logger.debug(`Start request sent for ${app.uuid}`);
          appStarted = true;
        } catch (e) {
          logger.error('Failed to start app:', e);
        }

        continue; // Skip health check this iteration — container just started
      }

      try {
        // Try reaching sidecar directly — this is the most reliable check
        // Coolify status can report "exited:unhealthy" even when container is up
        let sidecarReachable = false;

        try {
          const healthResp = await fetch('/api/sidecar-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sidecarUrl,
              token: containerState.sidecarToken,
              endpoint: '/health',
              method: 'GET',
            }),
          });
          sidecarReachable = healthResp.ok;
        } catch {
          // ignore — container not ready yet
        }

        if (sidecarReachable) {
          const updatedState: CoolifyContainerState = {
            ...containerState,
            status: 'running',
            lastActivity: Date.now(),
          };

          coolifyContainers.setKey(chatId, updatedState);
          persistContainers();

          logger.debug(`Container running for chat ${chatId}: ${customDomain} (sidecar: ${sidecarUrl})`);
          toast.update(toastId, { render: 'Container is ready', type: 'success', isLoading: false, autoClose: 3000 });

          return updatedState;
        }

        toast.update(toastId, { render: `Waiting for container... (${polls}/${maxPolls})` });
        logger.debug(`Poll ${polls}/${maxPolls}: sidecar not ready yet`);
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
    toast.update(toastId, {
      render: 'Container provisioning timed out',
      type: 'error',
      isLoading: false,
      autoClose: 5000,
    });

    return null;
  } catch (error) {
    logger.error('Failed to provision container:', error);
    toast.dismiss(toastId);
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
