import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { cleanStackTrace } from '~/utils/stacktrace';

interface WebContainerContext {
  loaded: boolean;
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

/**
 * Check if Coolify is enabled by reading localStorage directly.
 * This avoids importing the coolify store (which would create circular deps)
 * and runs synchronously at module init time.
 */
function isCoolifyEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const stored = localStorage.getItem('coolify_settings');

    if (stored) {
      return JSON.parse(stored).enabled === true;
    }
  } catch {
    // ignore
  }

  // Check env vars as fallback
  const envUrl = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_URL : '';
  const envToken = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_TOKEN : '';

  return !!(envUrl && envToken);
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

if (!import.meta.env.SSR) {
  if (isCoolifyEnabled()) {
    /*
     * When Coolify is enabled, skip WebContainer boot entirely.
     * The promise stays pending — all WebContainer-dependent code paths
     * are guarded by coolifyEnabled checks in action-runner and workbench.
     */
    console.log('[WebContainer] Skipping boot — Coolify is enabled');
  } else {
    webcontainer =
      import.meta.hot?.data.webcontainer ??
      Promise.resolve()
        .then(() => {
          return WebContainer.boot({
            coep: 'credentialless',
            workdirName: WORK_DIR_NAME,
            forwardPreviewErrors: true, // Enable error forwarding from iframes
          });
        })
        .then(async (webcontainer) => {
          webcontainerContext.loaded = true;

          const { workbenchStore } = await import('~/lib/stores/workbench');

          const response = await fetch('/inspector-script.js');
          const inspectorScript = await response.text();
          await webcontainer.setPreviewScript(inspectorScript);

          // Listen for preview errors
          webcontainer.on('preview-message', (message) => {
            console.log('WebContainer preview message:', message);

            // Handle both uncaught exceptions and unhandled promise rejections
            if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
              const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
              const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
              workbenchStore.actionAlert.set({
                type: 'preview',
                title,
                description: 'message' in message ? message.message : 'Unknown error',
                content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
                source: 'preview',
              });
            }
          });

          return webcontainer;
        });

    if (import.meta.hot) {
      import.meta.hot.data.webcontainer = webcontainer;
    }
  }
}
