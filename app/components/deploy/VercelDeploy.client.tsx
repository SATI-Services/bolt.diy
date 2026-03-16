import { toast } from 'react-toastify';
import { useStore } from '@nanostores/react';
import { vercelConnection } from '~/lib/stores/vercel';
import { workbenchStore } from '~/lib/stores/workbench';
import { useState } from 'react';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import { chatId } from '~/lib/persistence/useChatHistory';
import { formatBuildFailureOutput } from './deployUtils';

export function useVercelDeploy() {
  const [isDeploying, setIsDeploying] = useState(false);
  const vercelConn = useStore(vercelConnection);
  const currentChatId = useStore(chatId);

  const handleVercelDeploy = async () => {
    if (!vercelConn.user || !vercelConn.token) {
      toast.error('Please connect to Vercel first in the settings tab!');
      return false;
    }

    if (!currentChatId) {
      toast.error('No active chat found');
      return false;
    }

    try {
      setIsDeploying(true);

      const artifact = workbenchStore.firstArtifact;

      if (!artifact) {
        throw new Error('No active project found');
      }

      // Create a deployment artifact for visual feedback
      const deploymentId = `deploy-vercel-project`;
      workbenchStore.addArtifact({
        id: deploymentId,
        messageId: deploymentId,
        title: 'Vercel Deployment',
        type: 'standalone',
      });

      const deployArtifact = workbenchStore.artifacts.get()[deploymentId];

      // Notify that build is starting
      deployArtifact.runner.handleDeployAction('building', 'running', { source: 'vercel' });

      const actionId = 'build-' + Date.now();
      const actionData: ActionCallbackData = {
        messageId: 'vercel build',
        artifactId: artifact.id,
        actionId,
        action: {
          type: 'build' as const,
          content: 'npm run build',
        },
      };

      // Add the action first
      artifact.runner.addAction(actionData);

      // Then run it
      await artifact.runner.runAction(actionData);

      const buildOutput = artifact.runner.buildOutput;

      if (!buildOutput || buildOutput.exitCode !== 0) {
        // Notify that build failed
        deployArtifact.runner.handleDeployAction('building', 'failed', {
          error: formatBuildFailureOutput(buildOutput?.output),
          source: 'vercel',
        });
        throw new Error('Build failed');
      }

      // Notify that build succeeded and deployment is starting
      deployArtifact.runner.handleDeployAction('deploying', 'running', { source: 'vercel' });

      // Get the build files from the files store
      const files = workbenchStore.files.get();
      const fileContents: Record<string, string> = {};

      // Remove /home/project from buildPath if it exists
      const buildPath = buildOutput.path.replace('/home/project', '');

      // Check common build directories
      const commonOutputDirs = [buildPath, '/dist', '/build', '/out', '/output', '/.next', '/public'];
      let finalBuildPath = buildPath;
      let buildPathExists = false;

      for (const dir of commonOutputDirs) {
        const fullDir = `/home/project${dir}`;

        // Check if any files exist under this directory
        const hasFiles = Object.keys(files).some((p) => p.startsWith(fullDir + '/'));

        if (hasFiles) {
          finalBuildPath = dir;
          buildPathExists = true;
          break;
        }
      }

      if (!buildPathExists) {
        throw new Error('Could not find build output directory. Please check your build configuration.');
      }

      const buildPrefix = `/home/project${finalBuildPath}`;

      for (const [filePath, dirent] of Object.entries(files)) {
        if (!dirent || dirent.type !== 'file' || dirent.isBinary) {
          continue;
        }

        if (!filePath.startsWith(buildPrefix + '/')) {
          continue;
        }

        const deployPath = filePath.replace(buildPrefix, '');
        fileContents[deployPath] = dirent.content;
      }

      // Get all source project files for framework detection
      const allProjectFiles: Record<string, string> = {};

      for (const [filePath, dirent] of Object.entries(files)) {
        if (!dirent || dirent.type !== 'file' || dirent.isBinary) {
          continue;
        }

        let relativePath = filePath;

        if (filePath.startsWith('/home/project/')) {
          relativePath = filePath.replace('/home/project/', '');
        }

        // Skip dotfiles directories and node_modules
        if (relativePath.startsWith('.') || relativePath.startsWith('node_modules/')) {
          continue;
        }

        allProjectFiles[relativePath] = dirent.content;
      }

      // Use chatId instead of artifact.id
      const existingProjectId = localStorage.getItem(`vercel-project-${currentChatId}`);

      const response = await fetch('/api/vercel-deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: existingProjectId || undefined,
          files: fileContents,
          sourceFiles: allProjectFiles,
          token: vercelConn.token,
          chatId: currentChatId,
        }),
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.deploy || !data.project) {
        console.error('Invalid deploy response:', data);

        // Notify that deployment failed
        deployArtifact.runner.handleDeployAction('deploying', 'failed', {
          error: data.error || 'Invalid deployment response',
          source: 'vercel',
        });
        throw new Error(data.error || 'Invalid deployment response');
      }

      if (data.project) {
        localStorage.setItem(`vercel-project-${currentChatId}`, data.project.id);
      }

      // Notify that deployment completed successfully
      deployArtifact.runner.handleDeployAction('complete', 'complete', {
        url: data.deploy.url,
        source: 'vercel',
      });

      // Show success toast notification
      toast.success(`🚀 Vercel deployment completed successfully!`);

      return true;
    } catch (err) {
      console.error('Vercel deploy error:', err);
      toast.error(err instanceof Error ? err.message : 'Vercel deployment failed');

      return false;
    } finally {
      setIsDeploying(false);
    }
  };

  return {
    isDeploying,
    handleVercelDeploy,
    isConnected: !!vercelConn.user,
  };
}
