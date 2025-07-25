import http from 'http';
import httpProxy from 'http-proxy';
import type { Server } from 'http';

/**
 * Crée et démarre un serveur proxy.
 * @param targetUrl L'URL de destination vers laquelle les requêtes seront transférées.
 * @param port Le port sur lequel le serveur proxy écoutera.
 * @returns Une promesse qui se résout avec l'instance du serveur HTTP démarré.
 */
export function startProxy(targetUrl: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    if (!targetUrl) {
      return reject(new Error('[Proxy] a target URL must be provided.'));
    }

    console.log(`[Proxy] Configuring proxy to target: ${targetUrl}`);

    const proxy = httpProxy.createProxyServer({});

    proxy.on('proxyReq', (proxyReq, req) => {
      console.log(`[Proxy] >>> Forwarding request: ${req.method} ${req.url} to ${targetUrl}`);
    });

    proxy.on('proxyRes', (proxyRes) => {
      console.log(`[Proxy] <<< Received response with status: ${proxyRes.statusCode}`);
    });

    proxy.on('error', (err, req, res) => {
      console.error('[Proxy] Error:', err);
      // 'res' peut être une socket en cas d'erreur de websocket, donc on vérifie si c'est une réponse HTTP
      // et aussi si la réponse n'a pas déjà été envoyée.
      if (res && res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error.');
      } else if (res && res.writable) {
        // Si c'est une socket ou si les en-têtes sont déjà envoyés, on essaie juste de la fermer.
        res.end();
      }
    });

    const server = http.createServer((req, res) => {
      proxy.web(req, res, {
        target: targetUrl,
        changeOrigin: true,
      });
    });

    server.on('error', (err) => {
      console.error(`[Proxy] Server failed to start on port ${port}:`, err);
      reject(err);
    });
    
    server.listen(port, () => {
      console.log(`[Proxy] Server listening on port ${port}`);
      resolve(server);
    });
  });
}