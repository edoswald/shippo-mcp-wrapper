/**
 * SSE Transport Server — Shippo MCP Wrapper
 *
 * Exposes a header-authenticated SSE endpoint for Retell (and other MCP clients)
 * to connect to. Auth via Bearer token (Authorization header).
 *
 * Endpoints:
 *   GET  /sse      - SSE stream
 *   POST /messages - Client sends messages here
 *   GET  /health   - Health check
 *   POST /         - Streamable HTTP (Retell newer transport)
 */

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { logger } from './logger.js';
import crypto from 'crypto';
import { createRateLimiter } from './rate-limiter.js';

const globalLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter   = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

const PORT = process.env.PORT || 3000;
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '20', 10);

const STREAMABLE_IDLE_TIMEOUT_MS = parseInt(
  process.env.STREAMABLE_IDLE_TIMEOUT_MS || String(30 * 60 * 1000),
  10
);
const STREAMABLE_IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Token registry — SSE_TOKEN_<NAME> per client (same pattern as cirrusly-mcp-server)
// ---------------------------------------------------------------------------

const SSE_CLIENTS = Object.fromEntries([
  ...Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('SSE_TOKEN_') && v)
    .map(([k, v]) => [k.slice('SSE_TOKEN_'.length).toLowerCase(), v.trim()]),
  ...(process.env.SSE_TOKEN
    ? [['legacy', process.env.SSE_TOKEN.trim()]]
    : []),
]);

logger.info('SSE clients loaded', {
  clientCount: Object.keys(SSE_CLIENTS).length,
  clients: Object.keys(SSE_CLIENTS),
});

function identifyClient(req) {
  if (Object.keys(SSE_CLIENTS).length === 0) {
    logger.warn('No SSE tokens configured — all connections will be rejected');
    return null;
  }

  let provided = null;
  const authHeader =
    req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7).trim();
  } else {
    const url = new URL(req.url, 'http://localhost');
    const qToken = url.searchParams.get('token');
    if (qToken) provided = qToken;
  }

  if (!provided) return null;

  const match = Object.entries(SSE_CLIENTS).find(([, token]) => token === provided);
  if (match) {
    logger.info('Client authenticated', { client: match[0] });
    return match[0];
  }

  logger.warn('Authentication failed', {
    path: req.url,
    providedPrefix: provided.substring(0, 8) + '...',
  });
  return null;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

export function startSseServer(createMcpServer) {
  const transports = new Map();
  const streamableTransports = new Map();

  function reapIdleSessions() {
    const now = Date.now();
    for (const [sid, session] of streamableTransports.entries()) {
      if (now - session.lastActivity > STREAMABLE_IDLE_TIMEOUT_MS) {
        logger.info('Closing idle Streamable HTTP session', { sessionId: sid });
        try { session.transport.close(); } catch {}
        streamableTransports.delete(sid);
      }
    }
  }

  const reaperInterval = setInterval(reapIdleSessions, STREAMABLE_IDLE_CHECK_INTERVAL_MS);
  reaperInterval.unref();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    logger.info('Request', { method: req.method, path: url.pathname });

    // -----------------------------------------------------------------------
    // Rate limiting — before health check and auth gate
    // -----------------------------------------------------------------------
    if (!globalLimiter.check(req, res)) return;

    if (url.pathname === '/sse' || (url.pathname === '/' && req.method === 'POST')) {
      if (!authLimiter.check(req, res, { errorMessage: 'Too many authentication attempts, please try again later.' })) return;
    }

    // -----------------------------------------------------------------------
    // Health check — no auth
    // -----------------------------------------------------------------------
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'shippo-mcp-wrapper',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        connections: transports.size + streamableTransports.size,
        max_connections: MAX_CONNECTIONS,
        shippo_auth: process.env.SHIPPO_API_KEY
          ? 'api_key'
          : (process.env.SHIPPO_CLIENT_ID ? 'oauth' : 'missing'),
      }));
      return;
    }

    // -----------------------------------------------------------------------
    // Auth gate
    // -----------------------------------------------------------------------
    const clientName = identifyClient(req);
    if (!clientName) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      logger.warn('Rejected unauthorized connection', {
        ip: req.socket.remoteAddress,
        path: req.url,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // GET /sse — SSE stream
    // -----------------------------------------------------------------------
    if (url.pathname === '/sse' && req.method === 'GET') {
      const total = transports.size + streamableTransports.size;
      if (total >= MAX_CONNECTIONS) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many connections' }));
        return;
      }

      const transport = new SSEServerTransport('/messages', res);
      const server = createMcpServer();
      transports.set(transport.sessionId, { transport, server });

      req.on('close', () => {
        transports.delete(transport.sessionId);
        logger.info('SSE client disconnected', {
          client: clientName,
          sessionId: transport.sessionId,
        });
      });

      await server.connect(transport);
      logger.info('SSE client connected', {
        client: clientName,
        sessionId: transport.sessionId,
        activeConnections: transports.size + streamableTransports.size,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // POST /messages — message endpoint for SSE clients
    // -----------------------------------------------------------------------
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const session = transports.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }

    // -----------------------------------------------------------------------
    // POST / — Streamable HTTP (Retell newer transport)
    // -----------------------------------------------------------------------
    if (url.pathname === '/' && req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'];

      let transport;
      let server;

      if (sessionId && streamableTransports.has(sessionId)) {
        const session = streamableTransports.get(sessionId);
        transport = session.transport;
        server = session.server;
        session.lastActivity = Date.now();
      } else {
        const total = transports.size + streamableTransports.size;
        if (total >= MAX_CONNECTIONS) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many connections' }));
          return;
        }

        server = createMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            streamableTransports.set(sid, { transport, server, lastActivity: Date.now() });
            logger.info('Streamable HTTP session initialized', {
              sessionId: sid,
              client: clientName,
            });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            streamableTransports.delete(sid);
            logger.info('Streamable HTTP session closed', { sessionId: sid });
          }
        };

        await server.connect(transport);
      }

      await transport.handleRequest(req, res);
      return;
    }

    // -----------------------------------------------------------------------
    // GET / — info
    // -----------------------------------------------------------------------
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'Shippo MCP Wrapper',
        version: '1.0.0',
        transport: 'SSE',
        endpoints: { sse: '/sse', messages: '/messages', health: '/health' },
        connections: transports.size + streamableTransports.size,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(PORT, () => {
    logger.info(`Shippo MCP wrapper listening on port ${PORT}`, {
      sseEndpoint: `http://localhost:${PORT}/sse`,
      healthEndpoint: `http://localhost:${PORT}/health`,
    });
  });

  return httpServer;
}
