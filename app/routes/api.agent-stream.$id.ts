import { type LoaderFunctionArgs } from '@remix-run/cloudflare';

const AGENT_SERVICE_URL = (typeof process !== 'undefined' && process.env?.AGENT_SERVICE_URL) || 'http://localhost:9860';

// GET /api/agent-stream/:id → SSE proxy to agent service
export async function loader({ params, request }: LoaderFunctionArgs) {
  const { id } = params;

  // Proxy the SSE stream from the agent service
  try {
    const upstreamResp = await fetch(`${AGENT_SERVICE_URL}/sessions/${id}/stream`, {
      headers: {
        Accept: 'text/event-stream',
      },
      signal: request.signal,
    });

    if (!upstreamResp.ok || !upstreamResp.body) {
      return new Response(JSON.stringify({ error: 'Failed to connect to agent stream' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Pass through the SSE stream
    return new Response(upstreamResp.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: `Agent service unreachable: ${error.message}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
