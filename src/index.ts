import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ExactClient } from "./exact-client.js";
import { registerTools } from "./tools.js";
import { handleAuthorize, passphraseMatches } from "./oauth-ui.js";

export interface Env {
  EXACT_CLIENT_ID: string;
  EXACT_CLIENT_SECRET: string;
  MCP_API_KEY: string;
  TOKEN_STORE: KVNamespace;
  OAUTH_KV: KVNamespace;
  EXACT_BASE_URL: string;
  WORKER_URL: string;
  // Injected onto env at runtime by OAuthProvider — not a real binding, so it's not in wrangler.toml.
  OAUTH_PROVIDER: OAuthHelpers;
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: { fetch: handleMcp },
  defaultHandler: { fetch: handleDefault },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  // resourceMetadata omitted: the library derives `resource` and `authorization_servers`
  // from the request origin, which matches WORKER_URL for this single-deployment worker.
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    oauthProvider.fetch(request, env, ctx),
  // Cron keep-alive (see [triggers] in wrangler.toml): refreshes the Exact token chain
  // daily so the refresh token never hits Exact's ~30-day disuse expiry when the
  // connector goes unused for a while. Errors propagate so a dead chain shows up as a
  // failed cron invocation in the Cloudflare dashboard.
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(makeClient(env).keepTokensFresh());
  },
};

async function handleDefault(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/auth") {
    return handleAuth(request, env);
  }

  if (url.pathname === "/callback") {
    return handleCallback(request, env);
  }

  if (url.pathname === "/authorize") {
    return handleAuthorize(request, env);
  }

  return new Response("Not found", { status: 404 });
}

function renderAuthGate(error?: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Connect Exact Online</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 420px; margin: 4rem auto;">
  <h2>Connect Exact Online</h2>
  <p>Enter the passphrase to start the Exact Online connection flow.</p>
  ${error ? `<p style="color: #b00020;">${error}</p>` : ""}
  <form method="POST">
    <label for="passphrase">Passphrase</label><br>
    <input type="password" id="passphrase" name="passphrase" autofocus style="width: 100%; padding: 0.5rem; margin: 0.5rem 0;">
    <button type="submit" style="padding: 0.5rem 1rem;">Continue</button>
  </form>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Gates the Exact connection flow behind the owner passphrase and binds it to a
 * single-use `state` nonce checked in /callback. Without both, anyone knowing the
 * worker URL could complete the flow with their own Exact account and overwrite the
 * stored token pair — silently rebinding the connector to a stranger's administration. */
async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return renderAuthGate();
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const passphrase = form.get("passphrase");
  if (typeof passphrase !== "string" || !(await passphraseMatches(passphrase, env.MCP_API_KEY))) {
    return renderAuthGate("Incorrect passphrase.");
  }

  const state = crypto.randomUUID();
  await env.TOKEN_STORE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.EXACT_CLIENT_ID,
    redirect_uri: `${env.WORKER_URL}/callback`,
    response_type: "code",
    force_login: "0",
    state,
  });
  return Response.redirect(`${env.EXACT_BASE_URL}/api/oauth2/auth?${params}`, 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return new Response(`OAuth error: ${error ?? "missing code"}`, { status: 400 });
  }

  const state = url.searchParams.get("state");
  if (!state || !(await env.TOKEN_STORE.get(`oauth_state:${state}`))) {
    return new Response(
      "Invalid or expired state parameter. Start the connection flow again at /auth.",
      { status: 403 },
    );
  }
  await env.TOKEN_STORE.delete(`oauth_state:${state}`);

  try {
    const client = makeClient(env);
    await client.exchangeCode(code);
    return new Response(
      "<html><body><h2>Connected to Exact Online.</h2><p>You can close this tab.</p></body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Authentication failed: ${msg}`, { status: 502 });
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const client = makeClient(env);
  const server = new McpServer({ name: "exact-online-mcp", version: "1.0.0" });
  registerTools(server, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

let cachedClient: ExactClient | undefined;

function makeClient(env: Env): ExactClient {
  // Reused across requests handled by the same isolate so token-refresh single-flighting
  // in ExactClient actually dedupes concurrent requests instead of racing per-request instances.
  if (!cachedClient) {
    cachedClient = new ExactClient(
      env.TOKEN_STORE,
      env.EXACT_BASE_URL,
      env.EXACT_CLIENT_ID,
      env.EXACT_CLIENT_SECRET,
      env.WORKER_URL,
    );
  }
  return cachedClient;
}
