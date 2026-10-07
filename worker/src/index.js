// Decap CMS GitHub OAuth proxy — Cloudflare Worker (free tier).
// Flow: /authorize (ou /auth) → GitHub login → /callback → postMessage(token) de volta ao /admin/.
// Segredos apenas como variáveis de ambiente do Worker (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) — nunca no repo.
// Env opcional: ADMIN_ORIGIN (default https://accsterceirosetor.github.io).

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const STATE_COOKIE = "oauth_state";

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes); // Web Crypto, embutido no runtime dos Workers
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function readCookie(header, name) {
  const m = (header || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
// Comparação quase em tempo constante — canal lateral de timing não deve vazar o state.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Valor qualquer → literal de string JS, seguro para JSON.parse no script inline (sem breakout).
function jsString(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function json(body, status, adminOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": adminOrigin },
  });
}

// Página entregue à popup do Decap. src é { access_token } ou { error, message }.
// Posta para o opener os DOIS formatos que o Decap já aceitou ao longo das versões:
//   - handshake atual (authorizing:github → authorization:github:success/error — token em data.token);
//   - formato clássico { token: { access_token } } / { error, description }.
function handoff(src, adminOrigin) {
  const data = jsString(JSON.stringify(src));
  const target = jsString(adminOrigin);
  const html = `<!doctype html><meta charset="utf-8"><title>Entrando…</title>
<script>
var src=JSON.parse(${data}), target=${target}, done=false;
function finish(){
  if(done) return; done=true;
  if(src.access_token){
    window.opener.postMessage("authorization:github:success:"+JSON.stringify({token:src.access_token}), target);
    window.opener.postMessage({ token: { access_token: src.access_token } }, target);
  }else{
    window.opener.postMessage("authorization:github:error:"+JSON.stringify({message:src.message}), target);
    window.opener.postMessage({ error: src.error, description: src.message, error_description: src.message }, target);
  }
  window.close();
}
window.addEventListener("message", function(e){ if(e.data==="authorizing:github") finish(); });
window.opener.postMessage("authorizing:github", target);
setTimeout(finish, 1200); // fallback para clients que não ecoam o handshake
</script>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const callbackUri = url.origin + "/callback"; // origem do worker calculada em runtime — nunca hardcoded
    const adminOrigin = env.ADMIN_ORIGIN || "https://accsterceirosetor.github.io";
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 404, adminOrigin);

    // /authorize (documentado no plano) ou /auth (lander padrão do Decap atual): estado CSRF + redirect GitHub.
    if (url.pathname === "/authorize" || url.pathname === "/auth") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
        return json({ error: "missing_credentials", description: "Defina GITHUB_CLIENT_ID e GITHUB_CLIENT_SECRET no Worker." }, 500, adminOrigin);
      const state = randomState();
      const target = new URL(AUTH_URL);
      target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      target.searchParams.set("redirect_uri", callbackUri);
      target.searchParams.set("scope", url.searchParams.get("scope") || "repo"); // Decap envia scope=repo no /auth
      target.searchParams.set("state", state);
      target.searchParams.set("allow_signup", "false");
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.toString(),
          "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
          "Cache-Control": "no-store",
        },
      });
    }

    // /callback: o GitHub volta com ?code&state, ou ?error em caso de negação.
    if (url.pathname === "/callback") {
      const denial = url.searchParams.get("error");
      if (denial)
        return handoff({ error: denial, message: url.searchParams.get("error_description") || "Acesso negado." }, adminOrigin);
      if (!safeEqual(url.searchParams.get("state"), readCookie(request.headers.get("Cookie"), STATE_COOKIE)))
        return json({ error: "invalid_state", description: "Estado de CSRF inválido — refaça o login." }, 403, adminOrigin);
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: url.searchParams.get("code"),
          redirect_uri: callbackUri, // precisa ser idêntico ao redirect_uri do /authorize
        }),
      });
      const data = await res.json();
      return handoff(
        data.access_token
          ? { access_token: data.access_token }
          : { error: data.error || "token_exchange_failed", message: data.error_description || "Falha na troca do código pelo token." },
        adminOrigin
      );
    }

    return json({ error: "not_found", description: "Use /authorize, /auth ou /callback." }, 404, adminOrigin);
  },
};