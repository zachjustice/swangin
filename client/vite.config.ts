import { defineConfig, loadEnv, type Plugin } from 'vite';
import { DiscordProxy } from '@robojs/patch';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// @robojs/patch's Vite plugin injects `<script src="node_modules/@robojs/patch/.robo/public/discord-proxy-patch.umd.js">`,
// but npm workspaces hoist the package to the repo-root node_modules. Serve it from there.
function serveHoistedPatchScript(): Plugin {
  const PREFIX = '/node_modules/@robojs/patch/.robo/public/';
  const hoistedDir = resolve(__dirname, '../node_modules/@robojs/patch/.robo/public');
  return {
    name: 'serve-hoisted-robojs-patch',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(PREFIX)) return next();
        const name = req.url.slice(PREFIX.length).split('?')[0];
        const file = resolve(hoistedDir, name);
        if (!file.startsWith(hoistedDir) || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/javascript');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    envDir: '..',
    plugins: [serveHoistedPatchScript(), DiscordProxy.Vite()],
    // Pre-bundle heavy deps at server-start so the first request from Discord's
    // iframe doesn't race the optimizer (Discord/cloudflared time out around 30s).
    optimizeDeps: {
      include: [
        'three',
        '@dimforge/rapier3d-compat',
        '@discord/embedded-app-sdk',
        'colyseus.js',
      ],
    },
    server: {
      port: 3000,
      // Bind to all interfaces so cloudflared (using 127.0.0.1) reaches us;
      // Vite defaults to IPv6 localhost only, which silently breaks the tunnel.
      host: '0.0.0.0',
      // Discord loads the activity inside an iframe; cloudflared fronts this dev server.
      hmr: { clientPort: 443 },
      allowedHosts: true,
      proxy: {
        // While developing in a normal browser tab (not the Discord iframe), forward
        // /api/* to the local server. In the iframe Discord rewrites /.proxy/api/*.
        '/api': {
          target: env.DEV_SERVER_URL || 'http://localhost:3001',
          changeOrigin: true,
        },
        // Colyseus client uses `new Client('/colyseus')`. Strip the prefix so
        // matchmaker + WS upgrades hit the server at root.
        '/colyseus': {
          target: env.DEV_SERVER_URL || 'http://localhost:3001',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/colyseus/, ''),
        },
      },
    },
  };
});
