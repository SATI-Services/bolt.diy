import { createScopedLogger } from '~/utils/logger';
import type { SyncResponse } from '~/types/coolify';

const logger = createScopedLogger('CoolifyFileSync');

type SyncEventHandler = (event: SyncResponse) => void;

/**
 * File sync service that communicates with the sidecar HTTP API.
 * All requests go through /api/sidecar-proxy to avoid CORS/mixed-content issues.
 */
export class CoolifyFileSyncService {
  #sidecarUrl: string = '';
  #token: string = '';
  #connected: boolean = false;
  #onServerReady: SyncEventHandler | null = null;
  #onDisconnect: (() => void) | null = null;
  #healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  #batchQueue: Array<{ type: 'write_file' | 'mkdir' | 'delete_file'; path: string; content?: string }> = [];
  #batchTimeout: ReturnType<typeof setTimeout> | null = null;
  #batchDelay: number = 50;
  #pendingOps: Array<{ type: 'write' | 'exec'; path?: string; content?: string; command?: string }> = [];

  get connected(): boolean {
    return this.#connected;
  }

  set onServerReady(handler: SyncEventHandler | null) {
    this.#onServerReady = handler;
  }

  set onDisconnect(handler: (() => void) | null) {
    this.#onDisconnect = handler;
  }

  async connect(sidecarUrl: string, token: string): Promise<boolean> {
    this.#sidecarUrl = sidecarUrl;
    this.#token = token;

    try {
      // Test connection via health endpoint
      const health = await this.#sidecarFetch('/health', 'GET');

      if (health) {
        this.#connected = true;
        logger.debug('Connected to sidecar HTTP API');

        // Flush any operations that were queued while waiting for container
        await this.#flushPendingOps();

        // Start health check polling (also checks for server_ready)
        this.#startHealthCheck();

        return true;
      }
    } catch (error) {
      logger.error('Failed to connect to sidecar:', error);
    }

    return false;
  }

  async #sidecarFetch(endpoint: string, method: string = 'POST', body?: unknown): Promise<unknown> {
    const response = await fetch('/api/sidecar-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sidecarUrl: this.#sidecarUrl,
        token: this.#token,
        endpoint,
        method,
        body,
      }),
    });

    if (!response.ok) {
      throw new Error(`Sidecar proxy error: ${response.status}`);
    }

    return response.json();
  }

  #startHealthCheck() {
    this.#stopHealthCheck();
    this.#healthCheckInterval = setInterval(async () => {
      try {
        const health = (await this.#sidecarFetch('/health', 'GET')) as {
          status: string;
          serverReady: boolean;
          detectedPort: number | null;
        };

        if (health.serverReady && health.detectedPort) {
          this.#onServerReady?.({ type: 'server_ready', port: health.detectedPort });
          // Stop polling once server is ready
          this.#stopHealthCheck();
        }
      } catch {
        logger.warn('Health check failed');
      }
    }, 3000);
  }

  #stopHealthCheck() {
    if (this.#healthCheckInterval) {
      clearInterval(this.#healthCheckInterval);
      this.#healthCheckInterval = null;
    }
  }

  writeFile(filePath: string, content: string) {
    if (!this.#connected) {
      this.#pendingOps.push({ type: 'write', path: filePath, content });
      return;
    }

    this.#queueBatchOp({ type: 'write_file', path: filePath, content });
  }

  mkdir(dirPath: string) {
    this.#queueBatchOp({ type: 'mkdir', path: dirPath });
  }

  deleteFile(filePath: string) {
    this.#queueBatchOp({ type: 'delete_file', path: filePath });
  }

  #queueBatchOp(op: { type: 'write_file' | 'mkdir' | 'delete_file'; path: string; content?: string }) {
    this.#batchQueue.push(op);

    if (this.#batchTimeout) {
      clearTimeout(this.#batchTimeout);
    }

    this.#batchTimeout = setTimeout(() => {
      this.#flushBatch();
    }, this.#batchDelay);
  }

  async #flushBatch() {
    if (this.#batchQueue.length === 0) {
      return;
    }

    const operations = [...this.#batchQueue];
    this.#batchQueue = [];
    this.#batchTimeout = null;

    try {
      if (operations.length === 1) {
        const op = operations[0];

        switch (op.type) {
          case 'write_file':
            await this.#sidecarFetch('/write', 'POST', { path: op.path, content: op.content });
            break;
          case 'mkdir':
            await this.#sidecarFetch('/mkdir', 'POST', { path: op.path });
            break;
          case 'delete_file':
            await this.#sidecarFetch('/delete', 'POST', { path: op.path });
            break;
        }
      } else {
        await this.#sidecarFetch('/batch', 'POST', { operations });
      }
    } catch (error) {
      logger.error('Batch flush failed:', error);
    }
  }

  async exec(command: string): Promise<{ exitCode: number; output: string }> {
    if (!this.#connected) {
      this.#pendingOps.push({ type: 'exec', command });
      return { exitCode: 0, output: 'Queued for sidecar' };
    }

    try {
      const result = (await this.#sidecarFetch('/exec', 'POST', { command })) as {
        exitCode: number;
        output: string;
      };
      return result;
    } catch (error) {
      logger.error('Exec failed:', error);
      return { exitCode: -1, output: `Sidecar exec error: ${error}` };
    }
  }

  async #flushPendingOps() {
    if (this.#pendingOps.length === 0) {
      return;
    }

    const ops = [...this.#pendingOps];
    this.#pendingOps = [];
    logger.debug(`Flushing ${ops.length} pending operations to sidecar`);

    for (const op of ops) {
      try {
        if (op.type === 'write' && op.path) {
          this.#queueBatchOp({ type: 'write_file', path: op.path, content: op.content });
        } else if (op.type === 'exec' && op.command) {
          // Flush batch before exec to ensure files are written first
          await this.#flushBatch();
          await this.#sidecarFetch('/exec', 'POST', { command: op.command });
        }
      } catch (error) {
        logger.error('Failed to flush pending op:', error);
      }
    }

    // Final flush for any remaining batched writes
    await this.#flushBatch();
  }

  disconnect() {
    this.#stopHealthCheck();
    this.#connected = false;

    if (this.#batchTimeout) {
      clearTimeout(this.#batchTimeout);
      this.#batchQueue = [];
    }

    this.#onDisconnect?.();
  }
}

// Singleton instance
let syncServiceInstance: CoolifyFileSyncService | null = null;

export function getCoolifyFileSyncService(): CoolifyFileSyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new CoolifyFileSyncService();
  }

  return syncServiceInstance;
}
