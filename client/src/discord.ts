import { DiscordSDK } from '@discord/embedded-app-sdk';

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
}

export interface DiscordSession {
  sdk: DiscordSDK;
  user: DiscordUser;
  accessToken: string;
}

// Discord injects `frame_id`, `instance_id`, etc. as URL params when loading the
// Activity iframe. Used to decide whether to attempt the embedded-app handshake.
function isInsideDiscord(): boolean {
  return new URLSearchParams(window.location.search).has('frame_id');
}

export async function initDiscord(): Promise<DiscordSession | null> {
  if (!isInsideDiscord()) return null;

  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set');

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // The RPC/embedded OAuth flow forbids passing redirect_uri here. The Discord
  // host uses its own internal redirect; the dev-portal Redirects list just
  // needs to be non-empty.
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  // Discord rewrites /.proxy/api/* to the server's URL mapping target.
  const res = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${body}`);
  }
  const { access_token } = (await res.json()) as { access_token: string };

  const auth = await sdk.commands.authenticate({ access_token });
  if (!auth) throw new Error('authenticate returned null');

  return { sdk, user: auth.user as DiscordUser, accessToken: access_token };
}

export function displayName(user: DiscordUser): string {
  return user.global_name ?? user.username;
}
