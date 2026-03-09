import { createScopedLogger } from '~/utils/logger';
import type { SyncMessage, SyncResponse } from '~/types/coolify';

const logger = createScopedLogger('CoolifyFileSync');

type SyncEventHandler = (event: SyncResponse) => void;

export class CoolifyFileSyncService {
  #ws: WebSocket | null = null;
  #wsUrl: string = '';
  #token: string = '';
  #authenticated: boolean = false;
  #reconnectAttempts: number = 0;
  #maxReconnectAttempts: number = 3;
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #batchQueue: Array<{ type: 'write_file' | 'mkdir' | 'delete_file'; path: string; content?: string }> = [];
  #batchTimeout: ReturnType<typeof setTimeout> | null = null;
  #batchDelay: number = 50;
  #onServerReady: SyncEventHandler | null = null;
  #onDisconnect: (() => void) | null = null;
  #pendingExecs: Map<string, { resolve: (value: { exitCode: number; output: string }) => void }> = new Map();

  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN && this.#authenticated;
  }

  set onServerReady(handler: SyncEventHandler | null) {
    this.#onServerReady = handler;
  }

  set onDisconnect(handler: (() => void) | null) {
    this.#onDisconnect = handler;
  }

  connect(wsUrl: string, token: string): Promise<boolean> {
    this.#wsUrl = wsUrl;
    this.#token = token;
    this.#reconnectAttempts = 0;

    return this.#doConnect();
  }

  #doConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.#ws = new WebSocket(this.#wsUrl);

        this.#ws.onopen = () => {
          logger.debug('WebSocket connected, authenticating...');
          this.#send({ type: 'auth', token: this.#token });
        };

        this.#ws.onmessage = (event) => {
          try {
            const data: SyncResponse = JSON.parse(event.data);
            this.#handleMessage(data, resolve);
          } catch (error) {
            logger.error('Failed to parse message:', error);
          }
        };

        this.#ws.onclose = () => {
          this.#authenticated = false;
          this.#stopHeartbeat();
          logger.debug('WebSocket disconnected');

          if (this.#reconnectAttempts < this.#maxReconnectAttempts) {
            this.#reconnectAttempts++;
            const delay = Math.pow(2, this.#reconnectAttempts) * 1000;
            logger.debug(`Reconnecting in ${delay}ms (attempt ${this.#reconnectAttempts})`);
            setTimeout(() => this.#doConnect(), delay);
          } else {
            this.#onDisconnect?.();
          }
        };

        this.#ws.onerror = (error) => {
          logger.error('WebSocket error:', error);
          resolve(false);
        };
      } catch (error) {
        logger.error('Failed to create WebSocket:', error);
        resolve(false);
      }
    });
  }

  #handleMessage(data: SyncResponse, connectResolve?: (value: boolean) => void) {
    switch (data.type) {
      case 'auth_ok':
        this.#authenticated = true;
        this.#reconnectAttempts = 0;
        this.#startHeartbeat();
        logger.debug('Authenticated successfully');
        connectResolve?.(true);
        break;

      case 'auth_fail':
        this.#authenticated = false;
        logger.error('Authentication failed:', data.message);
        connectResolve?.(false);
        break;

      case 'server_ready':
        logger.debug('Dev server ready on port:', data.port);
        this.#onServerReady?.(data);
        break;

      case 'exec_output': {
        // Stream output to pending exec handlers
        break;
      }

      case 'exec_exit': {
        const execId = 'current';
        const pending = this.#pendingExecs.get(execId);

        if (pending) {
          pending.resolve({ exitCode: data.exitCode ?? 1, output: data.output ?? '' });
          this.#pendingExecs.delete(execId);
        }

        break;
      }

      case 'pong':
        break;

      case 'error':
        logger.error('Sidecar error:', data.message);
        break;
    }
  }

  #send(message: SyncMessage) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatInterval = setInterval(() => {
      this.#send({ type: 'ping' });
    }, 30000);
  }

  #stopHeartbeat() {
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
  }

  writeFile(filePath: string, content: string) {
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

  #flushBatch() {
    if (this.#batchQueue.length === 0) {
      return;
    }

    const operations = [...this.#batchQueue];
    this.#batchQueue = [];
    this.#batchTimeout = null;

    if (operations.length === 1) {
      const op = operations[0];
      this.#send({
        type: op.type,
        path: op.path,
        content: op.content,
      });
    } else {
      this.#send({
        type: 'batch',
        operations,
      });
    }
  }

  exec(command: string): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const execId = 'current';
      this.#pendingExecs.set(execId, { resolve });

      this.#send({
        type: 'exec',
        command,
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.#pendingExecs.has(execId)) {
          this.#pendingExecs.delete(execId);
          resolve({ exitCode: -1, output: 'Command timed out' });
        }
      }, 300000);
    });
  }

  disconnect() {
    this.#stopHeartbeat();
    this.#authenticated = false;

    if (this.#batchTimeout) {
      clearTimeout(this.#batchTimeout);
      this.#flushBatch();
    }

    if (this.#ws) {
      this.#reconnectAttempts = this.#maxReconnectAttempts; // Prevent reconnection
      this.#ws.close();
      this.#ws = null;
    }
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
