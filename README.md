# ACCS Terceiro Setor

Site institucional da **ACCS Gestão e Prestação de Contas para o Terceiro Setor** (UFBA): divulga o componente curricular, publicações dos estudantes e editais de atendimento a organizações da sociedade civil.

## Stack

- **Hugo** — gerador de site estático, com tema custom `themes/accs` que preserva o design original
- **Decap CMS** — gerenciamento de conteúdo (publicações e editais) em `/admin/`, com login via **GitHub OAuth** através de um **Cloudflare Worker** (proxy OAuth)
- **GitHub Pages** — hospedagem
- **GitHub Actions** — build e deploy (Hugo 0.166.0 extended, deploy via OIDC — sem secrets no repo)
- GitHub como backend do conteúdo