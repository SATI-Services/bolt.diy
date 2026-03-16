import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { coloredText } from '~/utils/terminal';
import { coolifyContainers } from '~/lib/stores/coolifyPreview';

export class TerminalStore {
  #coolifyTerminals: Array<{ terminal: ITerminal; ws: WebSocket }> = [];

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }
  async attachBoltTerminal(terminal: ITerminal) {
    await this.#attachCoolifyTerminal(terminal);
  }

  async attachTerminal(terminal: ITerminal) {
    await this.#attachCoolifyTerminal(terminal);
  }

  async #attachCoolifyTerminal(terminal: ITerminal) {
    // Find any running container to get sidecar URL and token
    const findRunningContainer = () => {
      const containers = coolifyContainers.get();

      for (const container of Object.values(containers)) {
        if (container.status === 'running' && container.wsUrl && container.sidecarToken) {
          return container;
        }
      }

      return null;
    };

    let container = findRunningContainer();

    if (!container) {
      terminal.write('\x1b[33mWaiting for container to be ready...\x1b[0m\r\n');

      // Poll until a container is running (max 60 attempts = ~120 seconds)
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        container = findRunningContainer();

        if (container) {
          break;
        }

        if (i % 5 === 4) {
          terminal.write(`\x1b[33m  Still waiting... (${(i + 1) * 2}s)\x1b[0m\r\n`);
        }
      }

      if (!container) {
        terminal.write('\x1b[31mContainer provisioning timed out.\x1b[0m\r\n');
        return;
      }
    }

    const sidecarToken = container.sidecarToken;

    try {
      /*
       * Connect directly to the sidecar's /terminal endpoint via Traefik's /_sidecar/ path.
       * This bypasses the wrangler proxy which doesn't reliably handle outbound WebSockets.
       */
      let wsUrl: string;

      if (container.domain) {
        const rawDomain = container.domain.startsWith('http') ? container.domain : `https://${container.domain}`;
        const domainUrl = new URL(rawDomain);
        const wsProtocol = domainUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${wsProtocol}//${domainUrl.host}/_sidecar/terminal?token=${encodeURIComponent(sidecarToken)}`;
      } else {
        // Fallback to the proxy route if no domain is available
        const sidecarUrl = container.wsUrl;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${wsProtocol}//${window.location.host}/api/sidecar-terminal?sidecarUrl=${encodeURIComponent(sidecarUrl)}&token=${encodeURIComponent(sidecarToken)}`;
      }

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        terminal.write('\x1b[32mConnected to container\x1b[0m\r\n');

        // Send initial resize
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: terminal.cols ?? 80,
            rows: terminal.rows ?? 24,
          }),
        );
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          terminal.write(event.data);
        } else {
          terminal.write(new TextDecoder().decode(event.data as ArrayBuffer));
        }
      };

      ws.onclose = () => {
        terminal.write('\r\n\x1b[31mDisconnected from container\x1b[0m\r\n');
      };

      ws.onerror = () => {
        terminal.write('\r\n\x1b[31mTerminal connection error\x1b[0m\r\n');
      };

      // Pipe terminal input to WebSocket
      terminal.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      this.#coolifyTerminals.push({ terminal, ws });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to connect to terminal\r\n') + error.message);
    }
  }

  onTerminalResize(cols: number, rows: number) {
    // Resize all terminals
    for (const { ws } of this.#coolifyTerminals) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
  }

  async detachTerminal(terminal: ITerminal) {
    const coolifyIdx = this.#coolifyTerminals.findIndex((t) => t.terminal === terminal);

    if (coolifyIdx !== -1) {
      const { ws } = this.#coolifyTerminals[coolifyIdx];

      try {
        ws.close();
      } catch {
        // ignore
      }

      this.#coolifyTerminals.splice(coolifyIdx, 1);
    }
  }
}
