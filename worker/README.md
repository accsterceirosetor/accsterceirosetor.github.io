# Proxy OAuth do Decap CMS — Cloudflare Worker

Implementa o proxy OAuth padrão do Decap CMS ([plano §4.3](github-pages-plan.md)) num Cloudflare Worker
do plano gratuito, já que o `github` backend do Decap precisa de um proxy: o **Client Secret** do GitHub OAuth
nunca pode ser entregue ao navegador.

- Código: `src/index.js` (~100 linhas, sem dependências — apenas APIs de plataforma dos Workers).
- Rota de início de login: `/authorize` (documentada no plano) **e** `/auth` (a rota padrão que o Decap atual abre — alias do mesmo fluxo).
- Rota de retorno: `/callback`.
- Segredos: variáveis de ambiente criptografadas do Worker (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) — **nunca no repositório**, nunca hardcoded.
- Origem permitida: `ADMIN_ORIGIN` (default `https://accsterceirosetor.github.io` — a origem do GitHub Pages que hospeda o `/admin/`).

## Fluxo OAuth (para o futuro mantenedor)

1. O editor clica **Login with GitHub** no `/admin/`; o Decap abre uma popup apontando para `base_url + /auth` (ou `/authorize`).
2. O Worker gera um `state` aleatório (CSRF), grava-o num cookie `oauth_state` (`HttpOnly`, `SameSite=Lax`, `Secure`)
   e responde **302** para `github.com/login/oauth/authorize?client_id=…&redirect_uri=<worker>/callback&scope=repo&state=…&allow_signup=false`.
3. O usuário autoriza no GitHub; o GitHub redireciona o navegador (mesma popup) para `<worker>/callback?code=…&state=…`.
4. O Worker confere `state` da query contra o cookie (`safeEqual` em tempo quase constante; divergência → `403`),
   troca o `code` por um access token via `POST github.com/login/oauth/access_token` (body com `client_id`,
   `client_secret`, `code`, `redirect_uri` idêntico ao do passo 2) e responde uma página HTML.
5. A página HTML devolve o token ao Decap via `postMessage` no opener, em **dois formatos compatíveis**:
   - handshake atual: `authorizing:github` → `authorization:github:success:{"token":"…"}` (o Decap atual lê `data.token`, string);
   - formato clássico/documentado no plano: `{ token: { access_token: "…" } }` (e `{ error, description }` no caso de erro).
   Em seguida a popup fecha sozinha.

Detalhes de segurança já previstos no plano: cookie de estado = proteção CSRF; segredos só no servidor;
CORS restrito à origem do site; teste de ponta a ponta **antes** de desligar a Netlify.

## Deploy via Wrangler (CLI)

Pré-requisito: conta na Cloudflare e o **GitHub OAuth App** criado (Settings → Developer settings → OAuth Apps,
com callback `https://accs-decap-oauth.<seu-subdominio>.workers.dev/callback` — ver TODO.md).

```bash
npm i -g wrangler        # ou use npx wrangler … nas linhas abaixo
wrangler login           # autoriza a CLI na sua conta Cloudflare
```

Com um `wrangler.toml` mínimo (opcional — veja abaixo) dentro de `worker/`:

```toml
name = "accs-decap-oauth"
main = "src/index.js"
compatibility_date = "2026-10-06"
```

```bash
cd worker
wrangler deploy          # sobe o Worker; o output mostra a URL final https://accs-decap-oauth.<subdominio>.workers.dev
wrangler secret put GITHUB_CLIENT_ID      # o comando oficial é exatamente `wrangler secret put <NOME>`; o valor é pedido interativamente
wrangler secret put GITHUB_CLIENT_SECRET
# opcional (só se for diferente do default):
# wrangler secret put ADMIN_ORIGIN
```

- O nome do Worker vira o subdomínio `*.workers.dev`. Sugestão: `accs-decap-oauth`.
- **Não é obrigatório** um `wrangler.toml` para script único: dá para passar tudo via flags da CLI,
  ex. `npx wrangler deploy src/index.js --name accs-decap-oauth --compatibility-date 2026-10-06`.
  Se preferir config, basta o `main = "src/index.js"` (e o `name`) acima.
- `wrangler secret put` vale imediatamente nas próximas requisições — não precisa redeployar.
  `GITHUB_CLIENT_ID` é público por natureza (o navegador vê o client_id), mas como Secret fica igualmente protegido; o importante é o **`GITHUB_CLIENT_SECRET` como Secret**.
- Checagem rápida: abrir `https://accs-decap-oauth.<subdominio>.workers.dev/authorize` no navegador —
  deve redirecionar para `github.com/login/oauth/authorize`, não errar 4xx/5xx.

## Alternativa: apenas pelo painel da Cloudflare

1. dash.cloudflare.com → **Workers & Pages → Create Worker** → cole o conteúdo de `src/index.js` → Deploy.
2. Renomeie o Worker para `accs-decap-oauth` (ou anote a URL gerada).
3. **Settings → Variables & Secrets → Add / Edit**:
   - `GITHUB_CLIENT_ID` (texto comum);
   - `GITHUB_CLIENT_SECRET` (**Secret** — criptografado e ilegível no painel);
   - `ADMIN_ORIGIN` (opcional, texto).

## Checklist pós-deploy

1. **`base_url` no Decap** — preencher a URL real do Worker em `static/admin/config.yml`, substituindo o
   placeholder `https://accs-decap-oauth.<YOUR-CLOUDFLARE-SUBDOMAIN>.workers.dev` do plano §4.2.
   O `auth_endpoint` default do Decap é `auth` — este Worker responde `/auth` (e também `/authorize`, se preferir configurar `auth_endpoint: authorize`).
2. **Callback URL do OAuth App** — registrar `https://<nome-do-worker>.<seu-subdominio>.workers.dev/callback`
   no GitHub (org Settings → Developer settings → OAuth Apps), conforme rastreado no TODO.md.
   Deve ser exatamente igual ao `redirect_uri` usado pelo Worker (sem barra final extra).
3. **Teste de ponta a ponta** — abrir `https://accsterceirosetor.github.io/admin/`, entrar com GitHub,
   publicar um post de teste e confirmar o commit em `main` **antes** de desligar a Netlify (TODO.md).
4. **Notas de segurança** — cookie de estado = CSRF; segredos só server-side; CORS restrito a `ADMIN_ORIGIN`;
   token nunca vai para o repositório. Se um dia chegar o domínio customizado (TODO), atualizar `base_url`
   e `ADMIN_ORIGIN` juntos se a origem do site mudar.