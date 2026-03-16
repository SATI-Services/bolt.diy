import React, { useState, useEffect } from 'react';

import { useStore } from '@nanostores/react';
import {
  coolifyConnection,
  coolifySettings,
  updateCoolifyConnection,
  updateCoolifySettings,
  testCoolifyConnection,
  isConnecting,
} from '~/lib/stores/coolify';
import * as coolifyApi from '~/lib/services/coolifyApiClient';
import type { CoolifyServer, CoolifyProject } from '~/types/coolify';

export default function CoolifyConnection() {
  const connection = useStore(coolifyConnection);
  const settings = useStore(coolifySettings);
  const connecting = useStore(isConnecting);

  const [servers, setServers] = useState<CoolifyServer[]>([]);
  const [projects, setProjects] = useState<CoolifyProject[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);

  useEffect(() => {
    if (connection.connected) {
      fetchDropdowns();
    }
  }, [connection.connected]);

  async function fetchDropdowns() {
    const apiOptions = { url: connection.url, token: connection.token };

    try {
      setLoadingServers(true);

      const serverList = await coolifyApi.listServers(apiOptions);
      setServers(serverList);
    } catch {
      console.error('Failed to fetch servers');
    } finally {
      setLoadingServers(false);
    }

    try {
      setLoadingProjects(true);

      const projectList = await coolifyApi.listProjects(apiOptions);
      setProjects(projectList);
    } catch {
      console.error('Failed to fetch projects');
    } finally {
      setLoadingProjects(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Connection Settings */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-bolt-elements-textPrimary">Connection</h4>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm text-bolt-elements-textSecondary mb-1">Coolify URL</label>
            <input
              type="url"
              value={connection.url}
              onChange={(e) => updateCoolifyConnection({ url: e.target.value, connected: false })}
              placeholder="https://coolify.yourdomain.com"
              className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
            />
          </div>

          <div>
            <label className="block text-sm text-bolt-elements-textSecondary mb-1">API Token</label>
            <input
              type="password"
              value={connection.token}
              onChange={(e) => updateCoolifyConnection({ token: e.target.value, connected: false })}
              placeholder="Your Coolify API token"
              className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
            />
          </div>
        </div>

        <button
          onClick={() => testCoolifyConnection()}
          disabled={connecting || !connection.url || !connection.token}
          className="px-4 py-2 rounded-lg bg-[#6D28D9] text-white text-sm hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {connecting ? 'Testing...' : connection.connected ? 'Connected - Test Again' : 'Test Connection'}
        </button>

        {connection.connected && (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            Connected to Coolify
          </div>
        )}
      </div>

      {/* Server & Project Selection */}
      {connection.connected && (
        <div className="space-y-4">
          <h4 className="text-sm font-medium text-bolt-elements-textPrimary">Deployment Target</h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-bolt-elements-textSecondary mb-1">Server</label>
              <select
                value={connection.serverUuid}
                onChange={(e) => updateCoolifyConnection({ serverUuid: e.target.value })}
                disabled={loadingServers}
                className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
              >
                <option value="">{loadingServers ? 'Loading...' : 'Select Server'}</option>
                {servers.map((s) => (
                  <option key={s.uuid} value={s.uuid}>
                    {s.name} ({s.ip})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-bolt-elements-textSecondary mb-1">Project</label>
              <select
                value={connection.projectUuid}
                onChange={(e) => updateCoolifyConnection({ projectUuid: e.target.value })}
                disabled={loadingProjects}
                className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
              >
                <option value="">{loadingProjects ? 'Loading...' : 'Select Project'}</option>
                {projects.map((p) => (
                  <option key={p.uuid} value={p.uuid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-bolt-elements-textSecondary mb-1">Environment</label>
            <input
              type="text"
              value={connection.environmentName}
              onChange={(e) => updateCoolifyConnection({ environmentName: e.target.value })}
              placeholder="production"
              className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
            />
          </div>
        </div>
      )}

      {/* Preview Settings */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-bolt-elements-textPrimary">Preview Settings</h4>

        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-bolt-elements-textPrimary">Auto-Provision</span>
            <p className="text-xs text-bolt-elements-textSecondary">
              Automatically create containers for new chat sessions
            </p>
          </div>
          <button
            className={`w-10 h-5 rounded-full transition-colors duration-200 ${
              settings.autoProvision ? 'bg-[#6D28D9]' : 'bg-gray-300 dark:bg-gray-700'
            } relative`}
            onClick={() => updateCoolifySettings({ autoProvision: !settings.autoProvision })}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                settings.autoProvision ? 'transform translate-x-5' : ''
              }`}
            />
          </button>
        </div>

        <div>
          <label className="block text-sm text-bolt-elements-textSecondary mb-1">Container TTL (minutes)</label>
          <input
            type="number"
            value={settings.containerTtl}
            onChange={(e) => updateCoolifySettings({ containerTtl: parseInt(e.target.value) || 60 })}
            min={5}
            max={1440}
            className="w-32 px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-bolt-elements-textSecondary mb-1">Sidecar Image</label>
          <input
            type="text"
            value={settings.sidecarImage}
            onChange={(e) => updateCoolifySettings({ sidecarImage: e.target.value })}
            placeholder="registry.yourdomain.com/preview-sidecar:latest"
            className="w-full px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary text-sm"
          />
        </div>
      </div>
    </div>
  );
}
