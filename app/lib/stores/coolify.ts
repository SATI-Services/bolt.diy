import { atom } from 'nanostores';
import type { CoolifyConnection, CoolifySettings } from '~/types/coolify';
import { testConnection } from '~/lib/services/coolifyApiClient';
import { logStore } from './logs';
import { toast } from 'react-toastify';

const storedConnection = typeof window !== 'undefined' ? localStorage.getItem('coolify_connection') : null;
const storedSettings = typeof window !== 'undefined' ? localStorage.getItem('coolify_settings') : null;

const envUrl = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_URL : '';
const envToken = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_TOKEN : '';
const envServerUuid = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_SERVER_UUID : '';
const envProjectUuid = typeof import.meta !== 'undefined' ? import.meta.env.VITE_COOLIFY_PROJECT_UUID : '';

const initialConnection: CoolifyConnection = storedConnection
  ? JSON.parse(storedConnection)
  : {
      url: envUrl || '',
      token: envToken || '',
      serverUuid: envServerUuid || '',
      projectUuid: envProjectUuid || '',
      environmentName: 'production',
      connected: false,
    };

const defaultSettings: CoolifySettings = {
  enabled: !!(envUrl && envToken),
  autoProvision: true,
  containerTtl: 60,
  sidecarImage: '10.0.0.1:5000/preview-sidecar:latest',
};

const initialSettings: CoolifySettings = storedSettings
  ? JSON.parse(storedSettings)
  : {
      ...defaultSettings,
      // Auto-enable if we have a saved connection that was previously connected
      enabled: defaultSettings.enabled || !!(initialConnection.connected && initialConnection.url && initialConnection.token),
    };

export const coolifyConnection = atom<CoolifyConnection>(initialConnection);
export const coolifySettings = atom<CoolifySettings>(initialSettings);
export const isConnecting = atom<boolean>(false);

// Auto-initialize connection on startup when env vars are configured
if (
  typeof window !== 'undefined' &&
  initialSettings.enabled &&
  initialConnection.url &&
  initialConnection.token &&
  !initialConnection.connected
) {
  setTimeout(async () => {
    try {
      const result = await testConnection({ url: initialConnection.url, token: initialConnection.token });

      if (result.ok) {
        const conn = coolifyConnection.get();
        const newState = { ...conn, connected: true };
        coolifyConnection.set(newState);
        localStorage.setItem('coolify_connection', JSON.stringify(newState));
        console.log(`Coolify auto-connected (v${result.version})`);
      }
    } catch (error) {
      console.warn('Coolify auto-connect failed:', error);
    }
  }, 500);
}

export const updateCoolifyConnection = (updates: Partial<CoolifyConnection>) => {
  const currentState = coolifyConnection.get();
  const newState = { ...currentState, ...updates };
  coolifyConnection.set(newState);

  if (typeof window !== 'undefined') {
    localStorage.setItem('coolify_connection', JSON.stringify(newState));
  }
};

export const updateCoolifySettings = (updates: Partial<CoolifySettings>) => {
  const currentState = coolifySettings.get();
  const newState = { ...currentState, ...updates };
  coolifySettings.set(newState);

  if (typeof window !== 'undefined') {
    localStorage.setItem('coolify_settings', JSON.stringify(newState));
  }
};

export async function initializeCoolifyConnection(): Promise<boolean> {
  const connection = coolifyConnection.get();

  if (!connection.url || !connection.token) {
    return false;
  }

  try {
    isConnecting.set(true);

    const result = await testConnection({ url: connection.url, token: connection.token });

    if (result.ok) {
      updateCoolifyConnection({ connected: true });
      return true;
    }

    updateCoolifyConnection({ connected: false });

    return false;
  } catch (error) {
    console.error('Error initializing Coolify connection:', error);
    logStore.logError('Failed to initialize Coolify connection', { error });
    updateCoolifyConnection({ connected: false });

    return false;
  } finally {
    isConnecting.set(false);
  }
}

export async function testCoolifyConnection(): Promise<{ ok: boolean; version?: string }> {
  const connection = coolifyConnection.get();

  if (!connection.url || !connection.token) {
    toast.error('Please enter Coolify URL and API Token');
    return { ok: false };
  }

  try {
    isConnecting.set(true);

    const result = await testConnection({ url: connection.url, token: connection.token });

    if (result.ok) {
      updateCoolifyConnection({ connected: true });
      toast.success(`Connected to Coolify v${result.version}`);
    } else {
      updateCoolifyConnection({ connected: false });
      toast.error('Failed to connect to Coolify. Check URL and token.');
    }

    return result;
  } catch (error) {
    console.error('Coolify connection test failed:', error);
    updateCoolifyConnection({ connected: false });
    toast.error('Failed to connect to Coolify');

    return { ok: false };
  } finally {
    isConnecting.set(false);
  }
}
