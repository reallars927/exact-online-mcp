import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface AuthorizeEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_API_KEY: string;
}

/** Constant-time passphrase check: comparing SHA-256 digests guarantees equal-length
 * inputs for `timingSafeEqual` (a Cloudflare Workers extension) and leaks neither
 * content nor length of the expected passphrase through timing. */
export async function passphraseMatches(passphrase: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(passphrase)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderForm(reqInfo: AuthRequest, client: ClientInfo | null, error?: string): Response {
  const encodedReq = btoa(JSON.stringify(reqInfo));
  const clientName = escapeHtml(client?.clientName ?? client?.clientId ?? "Unknown client");
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorize exact-online-mcp</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 420px; margin: 4rem auto;">
  <h2>Authorize access</h2>
  <p><strong>${clientName}</strong> is requesting access to the Exact Online MCP server.</p>
  ${error ? `<p style="color: #b00020;">${escapeHtml(error)}</p>` : ""}
  <form method="POST">
    <input type="hidden" name="req" value="${encodedReq}">
    <label for="passphrase">Passphrase</label><br>
    <input type="password" id="passphrase" name="passphrase" autofocus style="width: 100%; padding: 0.5rem; margin: 0.5rem 0;">
    <button type="submit" style="padding: 0.5rem 1rem;">Approve</button>
  </form>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function handleAuthorize(request: Request, env: AuthorizeEnv): Promise<Response> {
  if (request.method === "GET") {
    const reqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId);
    return renderForm(reqInfo, client);
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const encodedReq = form.get("req");
    const passphrase = form.get("passphrase");
    if (typeof encodedReq !== "string" || typeof passphrase !== "string") {
      return new Response("Malformed request", { status: 400 });
    }
    const reqInfo = JSON.parse(atob(encodedReq)) as AuthRequest;

    if (!(await passphraseMatches(passphrase, env.MCP_API_KEY))) {
      const client = await env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId);
      return renderForm(reqInfo, client, "Incorrect passphrase.");
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: reqInfo,
      userId: "owner",
      metadata: { label: "exact-online-mcp owner" },
      scope: reqInfo.scope,
      props: { authorizedAt: Date.now() },
    });
    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method not allowed", { status: 405 });
}
