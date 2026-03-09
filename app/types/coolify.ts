export interface CoolifyConnection {
  url: string;
  token: string;
  serverUuid: string;
  projectUuid: string;
  environmentName: string;
  connected: boolean;
}

export interface CoolifyContainerState {
  appUuid: string;
  domain: string;
  wsUrl: string;
  sidecarToken: string;
  status: 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error';
  chatId: string;
  createdAt: number;
  lastActivity: number;
}

export interface CoolifySettings {
  enabled: boolean;
  autoProvision: boolean;
  containerTtl: number; // minutes
  sidecarImage: string;
}

export interface SyncMessage {
  type: 'auth' | 'write_file' | 'mkdir' | 'delete_file' | 'exec' | 'batch' | 'ping';
  token?: string;
  path?: string;
  content?: string;
  command?: string;
  operations?: Array<{
    type: 'write_file' | 'mkdir' | 'delete_file';
    path: string;
    content?: string;
  }>;
}

export interface SyncResponse {
  type: 'auth_ok' | 'auth_fail' | 'ok' | 'error' | 'exec_output' | 'exec_exit' | 'server_ready' | 'pong';
  message?: string;
  output?: string;
  exitCode?: number;
  port?: number;
}

export interface CoolifyServer {
  uuid: string;
  name: string;
  ip: string;
}

export interface CoolifyProject {
  uuid: string;
  name: string;
}
