import { path as nodePath } from '~/utils/path';
import { WORK_DIR } from '~/utils/constants';
import { atom, map, type MapStore } from 'nanostores';
import type { ActionAlert, BoltAction, DeployAlert, SupabaseAction, SupabaseAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
  shellOutput?: string;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'shellOutput'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  onSupabaseAlert?: (alert: SupabaseAlert) => void;
  onDeployAlert?: (alert: DeployAlert) => void;
  onFileWrite?: (path: string, content: string) => void;
  onShellExec?: (command: string, onOutput?: (data: string) => void) => Promise<{ exitCode: number; output: string }>;
  onPreviewUrl?: (url: string) => void;
  onStartServer?: (command: string, port: number) => void;
  containerReadyPromise?: Promise<unknown>;
  buildOutput?: { path: string; exitCode: number; output: string };

  constructor(
    onAlert?: (alert: ActionAlert) => void,
    onSupabaseAlert?: (alert: SupabaseAlert) => void,
    onDeployAlert?: (alert: DeployAlert) => void,
  ) {
    this.onAlert = onAlert;
    this.onSupabaseAlert = onSupabaseAlert;
    this.onDeployAlert = onDeployAlert;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    /*
     * Dedup: skip file actions for paths already seen in this artifact
     * (don't require a.executed — streaming actions have executed=false)
     */
    if (data.action.type === 'file') {
      const filePath = (data.action as any).filePath;
      const existingForPath = Object.values(actions).find((a) => a.type === 'file' && (a as any).filePath === filePath);

      if (existingForPath) {
        logger.debug(`Skipping duplicate file action for ${filePath}`);
        return;
      }
    }

    // Dedup: skip shell/start commands already seen with the same content
    if (data.action.type === 'shell' || data.action.type === 'start') {
      const content = (data.action as any).content;
      const existingCmd = Object.values(actions).find(
        (a) => (a.type === 'shell' || a.type === 'start') && (a as any).content === content,
      );

      if (existingCmd) {
        logger.debug(`Skipping duplicate ${data.action.type} action: ${content?.slice(0, 50)}`);
        return;
      }
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return;
    }

    if (isStreaming && action.type !== 'file') {
      return;
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, isStreaming);
      })
      .catch((error) => {
        logger.error('Action execution promise failed:', error);
      });

    await this.#currentExecutionPromise;

    return;
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    // Wait for container to be ready before executing any action
    if (this.containerReadyPromise) {
      await this.containerReadyPromise;
    }

    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action, actionId);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'supabase': {
          try {
            await this.handleSupabaseAction(action as SupabaseAction);
          } catch (error: any) {
            // Update action status
            this.#updateAction(actionId, {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Supabase action failed',
            });

            // Return early without re-throwing
            return;
          }
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);

          // Store build output for deployment
          this.buildOutput = buildOutput;
          break;
        }
        case 'preview': {
          if ('url' in action && action.url) {
            logger.debug(`Setting preview URL: ${action.url}`);
            this.onPreviewUrl?.(action.url);
          }

          break;
        }
        case 'start': {
          // making the start app non blocking

          this.#runStartAction(action)
            .then(() => this.#updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              if (action.abortSignal.aborted) {
                return;
              }

              this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
              logger.error(`[${action.type}]:Action failed\n\n`, err);

              if (!(err instanceof ActionCommandError)) {
                return;
              }

              this.onAlert?.({
                type: 'error',
                title: 'Dev Server Failed',
                description: err.header,
                content: err.output,
              });
            });

          /*
           * adding a delay to avoid any race condition between 2 start actions
           * i am up for a better approach
           */
          await new Promise((resolve) => setTimeout(resolve, 2000));

          return;
        }
      }

      this.#updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      if (!(error instanceof ActionCommandError)) {
        return;
      }

      this.onAlert?.({
        type: 'error',
        title: 'Dev Server Failed',
        description: error.header,
        content: error.output,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState, actionId?: string) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    // Pre-validate command for common issues
    const validationResult = this.#validateShellCommand(action.content);

    if (validationResult.shouldModify && validationResult.modifiedCommand) {
      logger.debug(`Modified command: ${action.content} -> ${validationResult.modifiedCommand}`);
      action.content = validationResult.modifiedCommand;
    }

    logger.debug(`Routing shell command to sidecar: ${action.content}`);

    if (this.onShellExec) {
      const result = await this.onShellExec(action.content, (data: string) => {
        if (actionId) {
          const current = this.actions.get()[actionId];

          if (current) {
            const existing = current.shellOutput || '';
            this.#updateAction(actionId, { shellOutput: existing + data });
          }
        }
      });

      if (result.exitCode !== 0) {
        throw new ActionCommandError(`Shell command failed (exit ${result.exitCode})`, result.output);
      }
    }
  }

  async #runStartAction(action: ActionState) {
    if (action.type !== 'start') {
      unreachable('Expected shell action');
    }

    logger.debug(`Routing start command to sidecar: ${action.content}`);

    // Extract port from the command (e.g. --port=8080, --port 3001, -p 4200, :3000)
    const port = this.#extractPort(action.content);

    // Notify the workbench so it can set the proxy target port
    if (port) {
      this.onStartServer?.(action.content, port);
    }

    // Start commands are long-running (dev servers) — fire and don't wait for exit
    if (this.onShellExec) {
      this.onShellExec(action.content);
    }
  }

  #extractPort(command: string): number | null {
    // Match common port patterns in dev server commands
    const patterns = [
      /--port[=\s]+(\d+)/, // --port=3000 or --port 3000
      /-p\s+(\d+)/, // -p 3000
      /:(\d+)/, // listen on :3000, tcp://0.0.0.0:3000
      /PORT[=\s]+(\d+)/, // PORT=3000
    ];

    for (const pattern of patterns) {
      const match = command.match(pattern);

      if (match) {
        const port = parseInt(match[1], 10);

        if (port > 0 && port <= 65535) {
          return port;
        }
      }
    }

    // Default ports for known commands
    if (command.includes('artisan serve')) {
      return 8000;
    }

    if (command.includes('npm run dev') || command.includes('npx vite')) {
      return 5173;
    }

    return null;
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    // Write to sidecar via callback
    const relativePath = nodePath.relative(WORK_DIR, action.filePath);
    logger.debug(`File written to sidecar: ${relativePath}`);
    this.onFileWrite?.(relativePath, action.content);
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    // Trigger build started alert
    this.onDeployAlert?.({
      type: 'info',
      title: 'Building Application',
      description: 'Building your application...',
      stage: 'building',
      buildStatus: 'running',
      deployStatus: 'pending',
      source: 'netlify',
    });

    // Run build via sidecar
    let buildResult = { exitCode: 1, output: 'No shell exec handler available' };

    if (this.onShellExec) {
      buildResult = await this.onShellExec('npm run build');
    }

    if (buildResult.exitCode !== 0) {
      const result = {
        path: '',
        exitCode: buildResult.exitCode,
        output: buildResult.output,
      };

      this.buildOutput = result;

      // Trigger build failed alert
      this.onDeployAlert?.({
        type: 'error',
        title: 'Build Failed',
        description: 'Your application build failed',
        content: buildResult.output || 'No build output available',
        stage: 'building',
        buildStatus: 'failed',
        deployStatus: 'pending',
        source: 'netlify',
      });

      throw new ActionCommandError('Build Failed', buildResult.output || 'No Output Available');
    }

    // Trigger build success alert
    this.onDeployAlert?.({
      type: 'success',
      title: 'Build Completed',
      description: 'Your application was built successfully',
      stage: 'deploying',
      buildStatus: 'complete',
      deployStatus: 'running',
      source: 'netlify',
    });

    // Default build directory
    const buildDir = `${WORK_DIR}/dist`;

    const result = {
      path: buildDir,
      exitCode: buildResult.exitCode,
      output: buildResult.output,
    };

    this.buildOutput = result;

    return result;
  }
  async handleSupabaseAction(action: SupabaseAction) {
    const { operation, content, filePath } = action;
    logger.debug('[Supabase Action]:', { operation, filePath, content });

    switch (operation) {
      case 'migration':
        if (!filePath) {
          throw new Error('Migration requires a filePath');
        }

        // Show alert for migration action
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Migration',
          description: `Create migration file: ${filePath}`,
          content,
          source: 'supabase',
        });

        // Only create the migration file
        await this.#runFileAction({
          type: 'file',
          filePath,
          content,
          changeSource: 'supabase',
        } as any);
        return { success: true };

      case 'query': {
        // Always show the alert and let the SupabaseAlert component handle connection state
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Query',
          description: 'Execute database query',
          content,
          source: 'supabase',
        });

        // The actual execution will be triggered from SupabaseChatAlert
        return { pending: true };
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  // Add this method declaration to the class
  handleDeployAction(
    stage: 'building' | 'deploying' | 'complete',
    status: ActionStatus,
    details?: {
      url?: string;
      error?: string;
      source?: 'netlify' | 'vercel' | 'github' | 'gitlab';
    },
  ): void {
    if (!this.onDeployAlert) {
      logger.debug('No deploy alert handler registered');
      return;
    }

    const alertType = status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'info';

    const title =
      stage === 'building'
        ? 'Building Application'
        : stage === 'deploying'
          ? 'Deploying Application'
          : 'Deployment Complete';

    const description =
      status === 'failed'
        ? `${stage === 'building' ? 'Build' : 'Deployment'} failed`
        : status === 'running'
          ? `${stage === 'building' ? 'Building' : 'Deploying'} your application...`
          : status === 'complete'
            ? `${stage === 'building' ? 'Build' : 'Deployment'} completed successfully`
            : `Preparing to ${stage === 'building' ? 'build' : 'deploy'} your application`;

    const buildStatus =
      stage === 'building' ? status : stage === 'deploying' || stage === 'complete' ? 'complete' : 'pending';

    const deployStatus = stage === 'building' ? 'pending' : status;

    this.onDeployAlert({
      type: alertType,
      title,
      description,
      content: details?.error || '',
      url: details?.url,
      stage,
      buildStatus: buildStatus as any,
      deployStatus: deployStatus as any,
      source: details?.source || 'netlify',
    });
  }

  #validateShellCommand(command: string): {
    shouldModify: boolean;
    modifiedCommand?: string;
    warning?: string;
  } {
    const trimmedCommand = command.trim();

    /*
     * Rewrite scaffold commands that target "." or /app/ to use /tmp/ pattern
     * Match: composer create-project <package> . [flags...]
     */
    const composerDotMatch = trimmedCommand.match(/^(composer\s+create-project\s+\S+)\s+\.\s*(.*?)$/);

    if (composerDotMatch) {
      const [, composerCmd, flags] = composerDotMatch;
      const modifiedCommand =
        `${composerCmd} /tmp/scaffold-new ${flags} && cp -a /tmp/scaffold-new/. /app/ && rm -rf /tmp/scaffold-new`.replace(
          /\s+/g,
          ' ',
        );

      return {
        shouldModify: true,
        modifiedCommand,
        warning: 'Rewrote scaffold command to use /tmp/ pattern (target dir may not be empty)',
      };
    }

    // Match: composer create-project <package> /app [flags...] or /app/ or /app/.
    const composerAppMatch = trimmedCommand.match(/^(composer\s+create-project\s+\S+)\s+\/app\/?\s*(.*?)$/);

    if (composerAppMatch) {
      const [, composerCmd, flags] = composerAppMatch;
      const modifiedCommand =
        `${composerCmd} /tmp/scaffold-new ${flags} && cp -a /tmp/scaffold-new/. /app/ && rm -rf /tmp/scaffold-new`.replace(
          /\s+/g,
          ' ',
        );

      return {
        shouldModify: true,
        modifiedCommand,
        warning: 'Rewrote scaffold command to use /tmp/ pattern (target dir may not be empty)',
      };
    }

    return { shouldModify: false };
  }

  #createEnhancedShellError(
    command: string,
    exitCode: number | undefined,
    output: string | undefined,
  ): {
    title: string;
    details: string;
  } {
    const trimmedCommand = command.trim();
    const firstWord = trimmedCommand.split(/\s+/)[0];

    // Common error patterns and their explanations
    const errorPatterns = [
      {
        pattern: /cannot remove.*No such file or directory/,
        title: 'File Not Found',
        getMessage: () => {
          const fileMatch = output?.match(/'([^']+)'/);
          const fileName = fileMatch ? fileMatch[1] : 'file';

          return `The file '${fileName}' does not exist and cannot be removed.\n\nSuggestion: Use 'ls' to check what files exist, or use 'rm -f' to ignore missing files.`;
        },
      },
      {
        pattern: /No such file or directory/,
        title: 'File or Directory Not Found',
        getMessage: () => {
          if (trimmedCommand.startsWith('cd ')) {
            const dirMatch = trimmedCommand.match(/cd\s+(.+)/);
            const dirName = dirMatch ? dirMatch[1] : 'directory';

            return `The directory '${dirName}' does not exist.\n\nSuggestion: Use 'mkdir -p ${dirName}' to create it first, or check available directories with 'ls'.`;
          }

          return `The specified file or directory does not exist.\n\nSuggestion: Check the path and use 'ls' to see available files.`;
        },
      },
      {
        pattern: /Permission denied/,
        title: 'Permission Denied',
        getMessage: () =>
          `Permission denied for '${firstWord}'.\n\nSuggestion: The file may not be executable. Try 'chmod +x filename' first.`,
      },
      {
        pattern: /command not found/,
        title: 'Command Not Found',
        getMessage: () =>
          `The command '${firstWord}' is not available.\n\nSuggestion: Check available commands or install it via apt-get or npm.`,
      },
      {
        pattern: /Is a directory/,
        title: 'Target is a Directory',
        getMessage: () =>
          `Cannot perform this operation - target is a directory.\n\nSuggestion: Use 'ls' to list directory contents or add appropriate flags.`,
      },
      {
        pattern: /File exists/,
        title: 'File Already Exists',
        getMessage: () => `File already exists.\n\nSuggestion: Use a different name or add '-f' flag to overwrite.`,
      },
    ];

    // Try to match known error patterns
    for (const errorPattern of errorPatterns) {
      if (output && errorPattern.pattern.test(output)) {
        return {
          title: errorPattern.title,
          details: errorPattern.getMessage(),
        };
      }
    }

    // Generic error with suggestions based on command type
    let suggestion = '';

    if (trimmedCommand.startsWith('npm ')) {
      suggestion = '\n\nSuggestion: Try running "npm install" first or check package.json.';
    } else if (trimmedCommand.startsWith('git ')) {
      suggestion = "\n\nSuggestion: Check if you're in a git repository or if remote is configured.";
    } else if (trimmedCommand.match(/^(ls|cat|rm|cp|mv)/)) {
      suggestion = '\n\nSuggestion: Check file paths and use "ls" to see available files.';
    }

    return {
      title: `Command Failed (exit code: ${exitCode})`,
      details: `Command: ${trimmedCommand}\n\nOutput: ${output || 'No output available'}${suggestion}`,
    };
  }
}
