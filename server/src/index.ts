import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { SwanginRoom } from './room.ts';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET in .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Swap the OAuth `code` (issued by sdk.commands.authorize) for an access_token.
// Discord rewrites /.proxy/api/token on the client to this endpoint via URL mappings.
app.post('/api/token', async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) {
    res.status(400).json({ error: 'missing code' });
    return;
  }
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    });
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: 'discord token exchange failed', detail: text });
      return;
    }
    const { access_token } = (await r.json()) as { access_token: string };
    res.json({ access_token });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Colyseus 0.16 pattern: the transport binds to our http.Server, and Server's
// attach() (called from its constructor) intercepts the http 'request' event
// to route /matchmake/* to the matchmaker — Express handlers still run for
// everything else.
const httpServer = createServer(app);
const transport = new WebSocketTransport({ server: httpServer });
const gameServer = new Server({ transport });

// One room instance per Discord channelId — Colyseus auto-routes joinOrCreate
// calls with different channelId values to separate rooms.
gameServer.define('swangin', SwanginRoom).filterBy(['channelId']);

gameServer.listen(PORT).then(() => {
  console.log(`server listening on http://localhost:${PORT}`);
});
