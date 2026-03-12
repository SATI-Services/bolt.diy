import type { LoaderFunctionArgs } from '@remix-run/cloudflare';

/**
 * WebSocket proxy for sidecar terminal PTY.
 * Browser connects here, we forward to the sidecar's /terminal endpoint.
 *
 * Query params: sidecarUrl, token
 *
 * Note: This requires the server to support WebSocket upgrades.
 * With wrangler pages dev, we need to use the Remix loader to handle
 * the upgrade. For production on VPS with Node, this works natively.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sidecarUrl = url.searchParams.get('sidecarUrl');
  const token = url.searchParams.get('token');

  if (!sidecarUrl || !token) {
    return new Response('Missing sidecarUrl or token', { status: 400 });
  }

  // For non-WebSocket requests, return info
  const upgradeHeader = request.headers.get('Upgrade');

  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({ status: 'ok', message: 'WebSocket endpoint for sidecar terminal' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /*
   * WebSocket upgrade — forward to sidecar
   * This relies on the runtime supporting WebSocket upgrade (Node.js adapter)
   */
  const sidecarWsUrl = sidecarUrl.replace(/^http/, 'ws') + `/terminal?token=${encodeURIComponent(token)}`;

  try {
    // Create a WebSocket pair for the client
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept the server side
    server.accept();

    // Connect to the sidecar
    const upstream = new WebSocket(sidecarWsUrl);

    upstream.addEventListener('open', () => {
      // Relay messages from sidecar to client
      upstream.addEventListener('message', (event) => {
        try {
          if (server.readyState === WebSocket.OPEN) {
            server.send(event.data);
          }
        } catch {
          // ignore
        }
      });
    });

    // Relay messages from client to sidecar
    server.addEventListener('message', (event) => {
      try {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(event.data);
        }
      } catch {
        // ignore
      }
    });

    // Handle close
    server.addEventListener('close', () => {
      upstream.close();
    });

    upstream.addEventListener('close', () => {
      try {
        server.close();
      } catch {
        // ignore
      }
    });

    upstream.addEventListener('error', () => {
      try {
        server.close();
      } catch {
        // ignore
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (error) {
    console.error('Terminal proxy error:', error);
    return new Response('Failed to establish terminal connection', { status: 502 });
  }
}
