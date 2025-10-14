// tests/e2e/proxy.ts
import http from "http";
import httpProxy from "http-proxy";
function startProxy(targetUrl, port) {
  return new Promise((resolve, reject) => {
    if (!targetUrl) {
      return reject(new Error("[Proxy] a target URL must be provided."));
    }
    console.log(`[Proxy] Configuring proxy to target: ${targetUrl}`);
    const proxy = httpProxy.createProxyServer({});
    proxy.on("proxyReq", (proxyReq, req) => {
      console.log(`[Proxy] >>> Forwarding request: ${req.method} ${req.url} to ${targetUrl}`);
    });
    proxy.on("proxyRes", (proxyRes) => {
      console.log(`[Proxy] <<< Received response with status: ${proxyRes.statusCode}`);
    });
    proxy.on("error", (err, req, res) => {
      console.error("[Proxy] Error:", err);
      if (res && res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Proxy Error.");
      } else if (res && res.writable) {
        res.end();
      }
    });
    const server = http.createServer((req, res) => {
      proxy.web(req, res, {
        target: targetUrl,
        changeOrigin: true
      });
    });
    server.on("error", (err) => {
      console.error(`[Proxy] Server failed to start on port ${port}:`, err);
      reject(err);
    });
    server.listen(port, () => {
      console.log(`[Proxy] Server listening on port ${port}`);
      resolve(server);
    });
  });
}
export {
  startProxy
};
