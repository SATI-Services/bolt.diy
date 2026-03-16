import { useCallback, useEffect, useState } from 'react';
import { getCoolifyFileSyncService } from '~/lib/services/coolifyFileSyncService';
import Cookies from 'js-cookie';
import { toast } from 'react-toastify';
import { WORK_DIR } from '~/utils/constants';

const lookupSavedPassword = (url: string) => {
  const domain = url.split('/')[2];
  const gitCreds = Cookies.get(`git:${domain}`);

  if (!gitCreds) {
    return null;
  }

  try {
    const { username, password } = JSON.parse(gitCreds || '{}');
    return { username, password };
  } catch (error) {
    console.log(`Failed to parse Git Cookie ${error}`);
    return null;
  }
};

const saveGitAuth = (url: string, auth: { username: string; password: string }) => {
  const domain = url.split('/')[2];
  Cookies.set(`git:${domain}`, JSON.stringify(auth));
};

export function useGit() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const syncService = getCoolifyFileSyncService();

    if (syncService.connected) {
      setReady(true);

      return undefined;
    } else {
      // Poll briefly for sidecar connection
      const interval = setInterval(() => {
        if (getCoolifyFileSyncService().connected) {
          setReady(true);
          clearInterval(interval);
        }
      }, 500);

      return () => clearInterval(interval);
    }
  }, []);

  const gitClone = useCallback(
    async (url: string, retryCount = 0) => {
      const syncService = getCoolifyFileSyncService();

      if (!syncService.connected || !ready) {
        throw new Error('Sidecar not connected. Please try again later.');
      }

      let branch: string | undefined;
      let baseUrl = url;

      if (url.includes('#')) {
        [baseUrl, branch] = url.split('#');
      }

      // Build clone URL with embedded credentials if saved
      let cloneUrl = baseUrl;
      const auth = lookupSavedPassword(url);

      if (auth) {
        try {
          const urlObj = new URL(baseUrl);
          urlObj.username = auth.username;
          urlObj.password = auth.password;
          cloneUrl = urlObj.toString();
        } catch {
          // If URL parsing fails, use the original URL
        }
      }

      try {
        // Add a small delay before retrying to allow for network recovery
        if (retryCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
          console.log(`Retrying git clone (attempt ${retryCount + 1})...`);
        }

        // Clean the project directory first, then clone into it
        const branchArg = branch ? `-b ${branch} ` : '';
        const cloneResult = await syncService.exec(
          `rm -rf /app/.* /app/* 2>/dev/null; git clone --depth 1 ${branchArg}${cloneUrl} /app`,
        );

        if (cloneResult.exitCode !== 0) {
          const output = cloneResult.output;

          // Check for authentication failure
          if (output.includes('Authentication failed') || output.includes('401') || output.includes('403')) {
            // Prompt for credentials if none were saved
            if (!auth) {
              if (
                confirm('This repository requires authentication. Would you like to enter your GitHub credentials?')
              ) {
                const username = prompt('Enter username') || '';
                const password = prompt('Enter password or personal access token') || '';

                if (username && password) {
                  saveGitAuth(url, { username, password });

                  // Retry with saved credentials
                  return gitClone(url, retryCount);
                }
              }

              throw new Error('Authentication cancelled');
            }

            toast.error(
              `Authentication failed for ${baseUrl.split('/')[2]}. Please check your credentials and try again.`,
            );
            throw new Error(
              `Authentication failed for ${baseUrl.split('/')[2]}. Please check your credentials and try again.`,
            );
          }

          if (output.includes('not found') || output.includes('404')) {
            toast.error('Repository not found. Please check the URL and make sure the repository exists.');
            throw new Error('Repository not found. Please check the URL and make sure the repository exists.');
          }

          throw new Error(`Git clone failed: ${output}`);
        }

        // If we used credentials and it succeeded, save them
        if (auth) {
          saveGitAuth(url, auth);
        }

        // List all files from the cloned repo via sidecar
        const fileList = await syncService.listFiles('.');

        if (!fileList) {
          throw new Error('Failed to list cloned files');
        }

        // Read file contents
        const data: Record<string, { data: any; encoding?: string }> = {};

        for (const [filePath, info] of Object.entries(fileList)) {
          if (info.type !== 'file') {
            continue;
          }

          // Skip large files
          if (info.tooLarge) {
            continue;
          }

          const result = await syncService.readFile(filePath);

          if (result && result.content !== null && !result.isBinary) {
            data[filePath] = { data: result.content, encoding: 'utf8' };
          }
        }

        return { workdir: WORK_DIR, data };
      } catch (error) {
        console.error('Git clone error:', error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        // Retry for network errors, up to 3 times
        if (
          (errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('Sidecar exec error')) &&
          retryCount < 3
        ) {
          toast.error('Network error while connecting to repository. Please check your internet connection.');
          return gitClone(url, retryCount + 1);
        }

        if (!errorMessage.includes('Authentication') && !errorMessage.includes('not found')) {
          toast.error(`Failed to clone repository: ${errorMessage}`);
        }

        throw error;
      }
    },
    [ready],
  );

  return { ready, gitClone };
}
