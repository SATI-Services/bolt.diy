import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';
import { coolifySettings } from '~/lib/stores/coolify';
import { coolifyContainers } from '~/lib/stores/coolifyPreview';

export class TerminalStore {
  #webcontainer: Promise<WebContainer>;
  #terminals: Array<{ terminal: ITerminal; process: WebContainerProcess }> = [];
  #coolifyTerminals: Array<{ terminal: ITerminal; ws: WebSocket }> = [];
  #boltTerminal = newBoltShellProcess();

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }
  get boltTerminal() {
    return this.#boltTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }
  async attachBoltTerminal(terminal: ITerminal) {
    const settings = coolifySettings.get();

    if (settings.enabled) {
      await this.#attachCoolifyTerminal(terminal);
      return;
    }

    try {
      const wc = await this.#webcontainer;
      await this.#boltTerminal.init(wc, terminal);
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn bolt shell\n\n') + error.message);
      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    const settings = coolifySettings.get();

    if (settings.enabled) {
      await this.#attachCoolifyTerminal(terminal);
      return;
    }

    try {
      const shellProcess = await newShellProcess(await this.#webcontainer, terminal);
      this.#terminals.push({ terminal, process: shellProcess });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
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
      terminal.write('\x1b[33mWaiting for Coolify container to be ready...\x1b[0m\r\n');

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

    const sidecarUrl = container.wsUrl;
    const sidecarToken = container.sidecarToken;

    try {
      // Connect via the proxy route
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/api/sidecar-terminal?sidecarUrl=${encodeURIComponent(sidecarUrl)}&token=${encodeURIComponent(sidecarToken)}`;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        terminal.write('\x1b[32mConnected to Coolify container\x1b[0m\r\n');

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
        terminal.write('\r\n\x1b[31mDisconnected from Coolify container\x1b[0m\r\n');
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
      terminal.write(coloredText.red('Failed to connect to Coolify terminal\r\n') + error.message);
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }

    // Also resize Coolify terminals
    for (const { ws } of this.#coolifyTerminals) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
  }

  async detachTerminal(terminal: ITerminal) {
    // Check Coolify terminals first
    const coolifyIdx = this.#coolifyTerminals.findIndex((t) => t.terminal === terminal);

    if (coolifyIdx !== -1) {
      const { ws } = this.#coolifyTerminals[coolifyIdx];

      try {
        ws.close();
      } catch {
        // ignore
      }

      this.#coolifyTerminals.splice(coolifyIdx, 1);

      return;
    }

    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      const { process } = this.#terminals[terminalIndex];

      try {
        process.kill();
      } catch (error) {
        console.warn('Failed to kill terminal process:', error);
      }
      this.#terminals.splice(terminalIndex, 1);
    }
  }
}
