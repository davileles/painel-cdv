# CLAUDE.md — Ecossistema Davi Leles (CDV · Tica Promos/TSP · TeamRausch · pessoais)

> Contexto único, igual em todos os repositórios de `davileles`. Leia a seção **0** sempre; depois vá direto à seção do repositório em que está trabalhando (seção 4).
> Este arquivo fica em repositórios **públicos**: nunca coloque aqui token, senha, CPF, telefone ou e-mail de terceiros.

---

## 0. Regras de trabalho (valem para todo repo)

### Comunicação
- Responder **sempre em português (PT-BR)**. O Davi usa muito ditado por voz: interprete texto truncado em vez de pedir esclarecimento.
- Preferir **entregar a mudança pronta** a explicar. Aprovações vêm curtas ("sim", "pode fazer", "faça").
- Mudança significativa: apresentar o escopo antes; correções pequenas: aplicar direto.
- Sempre dizer **arquivo + repositório** de cada mudança.
- O Davi não tem terminal local: trabalha por interfaces web (GitHub web, Railway, Claude). Nunca pedir que ele rode comando local.

### Git / deploy
- Commit e push **direto na `main`**, sem branch e sem PR — inclusive em sessão na nuvem que sugira branch `claude/...`.
- O push **publica em produção na hora** (GitHub Pages em 1–10 min; Railway faz deploy automático a cada commit). **Nunca** pedir redeploy manual no Railway.
- Se o push for recusado: `git pull --rebase origin main` e enviar de novo. **Nunca `push --force`.**
- Existe concorrência real (outras sessões, GitHub Actions e o proxy escrevem nos mesmos repos): **sempre partir do estado atual** do arquivo antes de editar (lost update é o risco nº 1).
- Sem git (só API do GitHub):
  - Arquivo único: `GET contents` → SHA **fresco** → `PUT /repos/davileles/{repo}/contents/{arquivo}`. Nunca reutilizar SHA.
  - Vários arquivos atômicos: blobs → tree (`base_tree`) → commit → `PATCH ref`.
  - Arquivo > 1 MB: ler por `git/blobs/{sha}` (a Contents API devolve `encoding:none`). **Não** validar pelo `raw.githubusercontent.com` (cache CDN desatualizado).
  - Depois do push, reler o arquivo e conferir.
  - `painel-cdv/scripts/cdv_commit.py` já implementa isso (SHA fresco, blob > 1 MB, retry em 409, guardas, `--dry-run`).
- Token: sempre via variável de ambiente / credencial da sessão. **Nunca** hardcode de token em código ou em arquivo versionado.

### Validação obrigatória antes de commitar
- `node --check arquivo.js` (ESM: `node --input-type=module --check < arquivo.js`).
- HTML: extrair todos os `<script>` inline (só os que o navegador executa como JS), concatenar e rodar `node --check`.
- `node --check` **não pega** TDZ nem referência inexistente: conferir ordem de declarações e nomes usados.
- Patches por string (python): `assert c.count(OLD) == 1` antes de cada `replace`.
- Arquivos grandes (index.html/server.js de 300 KB a 1,1 MB): usar grep/python, nunca reescrever o arquivo inteiro a partir de saída de ferramenta (pode vir truncada).

### Guardas de CI (`.github/workflows/guardas.yml`)
Presentes em painel-cdv, baileys-server, gestor-cdv, concierge, tudo-sobre-promos e financas. Todos reutilizam `davileles/painel-cdv/.github/workflows/guardas-lib.yml@main` → `painel-cdv/scripts/guardas.mjs`:
1. **Sintaxe** — `node --check` em `.js/.mjs/.cjs` e nos `<script>` inline.
2. **Superfície** — `.github/superficie.json` = `{limiarRemocao:150, arquivos:{<arq>:{minLinhas, obrigatorio:[...]}}}`. Marcadores são strings literais (ex.: `app.get('/status'`, `function enviarWA(`). Se sumirem, o CI falha.
3. **Regressão** — remoção líquida > 150 linhas é barrada, salvo se a mensagem do commit contiver `refactor|refatora|remove|remocao|limpeza|cleanup|deprecat|delet|migra|rewrite|reescrit|split|extrai|extract|revert|[grande]`.
- Renomeou/removeu rota ou função listada? **Atualize `superficie.json` no mesmo commit.** Criou função exportada importante? Acrescente o marcador.

### Convenções de UI (todos os projetos)
- Todo seletor/dropdown com opções em **ordem alfabética**.
- 🛫 para data de ida, 🛬 para data de volta.
- Cards de revisão no Telegram: **sem blocos expansíveis/colapsáveis**.
- Painel do membro CDV: ícones **Phosphor** (sprite SVG `#i-*`) em vez de emoji de interface.
- Preferir soluções **sem novo serviço externo**.
- Horário: sempre `America/Sao_Paulo` (`-03:00` fixo, sem horário de verão).

---

## 1. Mapa dos repositórios

| Repo | O que é | Hospedagem | Domínio / URL | Módulo |
|---|---|---|---|---|
| `painel-cdv` | Proxy central (`index.js`) + painel do membro CDV (`index.html`) + coletores (Actions) + JSONs públicos | Railway (proxy) + GitHub Pages | `cdv-proxy-production.up.railway.app` · `painel.clubedoviajante.com.br` · `ir.clubedoviajante.com.br` | **CommonJS** |
| `baileys-server` | WhatsApp (Baileys) + Telegram (GramJS) + radares de afiliados + filas de envio; `wa-envio/` (Go) | Railway (2 serviços) | `baileys-server-production-ebfe.up.railway.app` | **ESM** |
| `gestor-cdv` (ex-`gerador-cdv`) | Painel de Gestão CDV (ofertas, emissões, alertas, campanhas, reentrada, grupos, config) | GitHub Pages | `davileles.github.io/gestor-cdv` (o antigo `/gerador-cdv/` dá 404) | HTML único |
| `concierge` | Painel do Concierge Estratégico + portal do cliente + cadastro + DS-160 + `lembrete-voo.js` | GitHub Pages (`pages.yml`) | `concierge.clubedoviajante.com.br` | HTML único |
| `roteiros` | Páginas de roteiro publicadas (clientes do concierge e membros) | GitHub Pages | `roteiros.clubedoviajante.com.br` | estático |
| `dados` (**privado**) | Todos os dados sensíveis/persistentes (CDV, TSP, concierge) | — | — | JSON |
| `tudo-sobre-promos` | Painel de gestão Tica Promos/TSP + coletor de comissões | GitHub Pages | `gestao.ticapromos.com.br` | HTML único |
| `tica-grupos` (ex-`davileles-grupos`) | Landings de entrada nos grupos TSP (geral + nichos) | GitHub Pages | `grupos.ticapromos.com.br` | estático |
| `tica-site` | Site público de ofertas | GitHub Pages | `ticapromos.com.br` | estático |
| `tsp-site` | Site público antigo (mesmo conteúdo) | GitHub Pages | `www.tudosobrepromos.com` (domínio não será renovado; vence out/2026) | estático |
| `davileles-site` | Espelho "Promos do Davi" | GitHub Pages | `davileles.com` (guarda-chuva em aposentadoria) | estático |
| `teamrausch` | Sistema do estúdio (Wellhub, agenda, totem, TV, mensagens) — `app/` + `whatsapp/` | Railway (2 serviços) | `app.teamrausch.com.br` (via Cloudflare) · `appteamrausch-production.up.railway.app` | CommonJS |
| `financas` | App de finanças da família + proxy de IA próprio | GitHub Pages + Railway (`proxy/`) | `davileles.github.io/financas` | ESM (proxy) |
| `castanheiras` | Gestão de contas do condomínio Edifício Castanheiras | GitHub Pages + Railway (`api/`) | `davileles.github.io/castanheiras` · `castanheiras-production.up.railway.app` | CommonJS |
| `castanheiras-dados` (**privado**) | `dados.json` + comprovantes do condomínio | — | — | JSON |

Nomes antigos que ainda funcionam só por redirect (não depender deles): `gerador-cdv`→`gestor-cdv`, `davileles-grupos`→`tica-grupos`, `cdv-tsp-dados`→`dados`.

---

## 2. Arquitetura

```
Membro ── painel.clubedoviajante.com.br (painel-cdv/index.html)
                                   │
gestor-cdv · concierge · tudo-sobre-promos · roteiros · baileys-server
                                   │
                    PROXY CDV (painel-cdv/index.js, Railway)
                    ├─ GitHub API → painel-cdv (JSON públicos)
                    │             → davileles/dados (sensíveis, tsp/, concierge/, castanheiras/)
                    │             → concierge (reservas, viagens, cfg…) · roteiros (páginas)
                    ├─ encurtador ir.clubedoviajante.com.br / distribuidor ir.ticapromos.com.br
                    └─ BAILEYS_URL → baileys-server
                                   │
                    BAILEYS-SERVER (Railway)
                    ├─ WhatsApp: conta principal (Baileys) → leitura + DM + reserva
                    ├─ wa-envio (Go/whatsmeow, serviço separado) → envio em grupo de tico-02/03
                    ├─ Telegram: GramJS (fonte de cupons) + 3 bots (TSP, Passagens CDV, Ofertas CDV)
                    ├─ radares Amazon/ML/Shopee/Magalu/Awin
                    ├─ sync-github → davileles/dados/tsp/ · feed-publico → tica-site, tsp-site
                    └─ agenda-actions → dispara workflows (cron do Actions é só fallback)

TeamRausch, financas e castanheiras são ISOLADOS (serviços, tokens e dados próprios).
```

**Regra de impacto:** antes de alterar/remover rota do proxy (`painel-cdv/index.js`), verificar consumidores em `gestor-cdv`, `concierge`, `tudo-sobre-promos`, `baileys-server`, `roteiros` (páginas publicadas), `concierge/lembrete-voo.js` e `painel-cdv/index.html`. Rotas do `baileys-server` são consumidas por `gestor-cdv`, `concierge` e `tudo-sobre-promos`.

---

## 3. Dados e segurança

- **`painel-cdv` e `concierge` são repos públicos** (servem o Pages). Dado pessoal **nunca** vive no `painel-cdv`.
- O proxy decide o repo de cada arquivo (`repoDoArquivo`):
  - `tsp/*`, `castanheiras/*` → `GITHUB_REPO_TSP` (padrão `davileles/dados`)
  - `ARQUIVOS_SENSIVEIS` (`membros`, `perfis`, `cartoes`, `assinaturas`, `desejos`, `campanhas`, `roteiros-membros`, `hubla-webhooks-log`) → `GITHUB_REPO_DADOS`
  - resto → `GITHUB_REPO` (painel-cdv)
  - concierge: `concierge/clientes*.json`, `concierge/ds160.json` → `davileles/dados`; reservas/viagens/cfg/modelos/agendamentos/arquivos → repo `concierge`.
- **Dois "cartões":** `cartoes.json` = cartões **dos membros** (sensível, repo dados). `cartoes-catalogo.json` = catálogo público de cartões de crédito (rotas `/catalogo-cartoes`).
- **Modo dev:** `?env=dev` no front liga `IS_DEV` → header `x-cdv-env: dev` → o proxy lê/grava `X-dev.json` e prefixa commit com `[DEV]`.
- **Escrita concorrente:** `ofertas*.json` e `passagens.json` são escritos pelo proxy e pelo Actions ao mesmo tempo → usar `reconciliar-estado.js` ou Contents API com SHA fresco; nunca `pull --rebase` ingênuo em cima de dado.
- Trocar `CONCIERGE_SESSION_SECRET` ou `GITHUB_TOKEN` do proxy derruba todas as sessões do concierge.

---

## 4. Repositórios em detalhe

### 4.1 `painel-cdv`

**Arquivos**
- `index.js` — proxy Express (CommonJS; `express ^4.18`, `node-fetch ^2`), ~9,4k linhas.
- `index.html` — painel do membro (~10,8k linhas). `CNAME` = `painel.clubedoviajante.com.br`.
- `cdv-redesign.css/.js` — camada visual (tema claro padrão, barra inferior no celular, ⌘K, `window.CDV_DENSIDADE=false` desliga densidade).
- `iata.js` — base gerada de ~4.9k aeroportos (fora do guarda de regressão).
- `transferencia-deducao.js`, `passagens-datas.js`, `passagens-escopo.js` — módulos do proxy. **`transferencia-deducao.js` tem cópia espelhada em `gestor-cdv/index.html`: mudar um exige mudar o outro.**
- Coletores/scripts do Actions: `coletar.js`, `coletar-inter.js`, `coletar-meliuz.js`, `coletar-topcashback.js`, `coletar-radar.js`, `coletar-cartoes.js`, `catalogo-meliuz.js`, `resumo-diario.js`, `arquivar-passagens.js`, `reconciliar-estado.js`, `mensagem-radar.js` (kill switch `AUTO_PUBLICAR_VARIACOES=false`), `alerta-operador.js` (kill switch `ALERTAS_OPERADOR=false`).
- `scripts/guardas.mjs`, `scripts/cdv_commit.py`, `valida_catalogo.py`, `PIPELINE.md` (pesquisa de salas VIP), `diag.html`.
- JSONs públicos: `milhas.json`, `historico.json` (~6 MB), `ofertas*.json`, `alertas.json`, `variacoes-notificadas.json`, `historico-transferencias.json`, `validades-livelo.json`, `saude-coleta.json`, `passagens.json` (janela quente) + `passagens-historico-{ANO}-S{1|2}.json` + index, `links.json` (encurtador), `cliques.json`, `cartoes-catalogo.json` + `cartoes-alvos/fontes/fontes-manuais/captura-pendente.json`, `bandeiras.json`, `lounges-db.json` (274 salas / 113 aeroportos), `meliuz-lojas.json`, `topcashback-lojas.json`.

**Variáveis de ambiente (Railway, serviço proxy)**
`PORT`, `GITHUB_TOKEN` (inclui Actions:write para disparar `lembrete-voo.yml` no concierge), `GITHUB_REPO`, `GITHUB_REPO_DADOS`, `GITHUB_REPO_TSP`, `CONCIERGE_SESSION_SECRET`, `HUBLA_TOKEN`, `RESEND_API_KEY` (sem ela, OTP só no log `[OTP-DEV]`), `ANTHROPIC_API_KEY`, `BAILEYS_URL`, `TSP_TENANT_SECRET` (**igual** ao do baileys-server), `TSP_APPS_SCRIPT` (planilha TSP), `CAMPANHAS_KEY` (header `X-CDV-Op`; sem ela campanhas → 503), `GG_HOSTS`, `GG_HOME`, `GG_EMERGENCIA`, `RASTREIO_FALLBACK`, `MELIUZ_MZSYNC`, `MELIUZ_MZSYNC_R`.

**Autenticação**
- CORS `*`; headers aceitos: `Content-Type, X-TSP-Token, X-CDV-Env, X-CDV-Op, X-CDV-Auth, X-CDV-Servico`; body até 20 MB.
- Membros: OTP por e-mail (`/membros/enviar-codigo` → `/membros/verificar-codigo`, TTL 10 min, em memória); `/membros/verificar?email=` checa `status==='ativo'` em `membros.json`. Onboarding/saída via webhook Hubla (`/webhook/hubla-membros`).
- Admin: `/admin/enviar-codigo` + `/admin/verificar-codigo` com `app: tsp|concierge`; allowlists `ADMIN_EMAILS` / `ADMIN_EMAILS_APP`; operadores TSP em `tsp/tenants.json` (token 7 dias); concierge recebe token de 12 h.
- `/concierge/*`: exige `X-CDV-Auth` (sessão HMAC, revalida allowlist) ou `X-CDV-Servico` (chave de serviço usada pelo `lembrete-voo.js`). Rotas públicas: `POST cadastro`, `POST ds160`, `GET portal`, `GET portal/tema`, `GET alertas`, `POST alerta/disparar`.
- Castanheiras via proxy: allowlist dentro de `castanheiras/dados.json` (hoje o app usa a própria API — ver 4.12).

**Hosts tratados por `req.hostname`**
- `ir.clubedoviajante.com.br/<slug>` → redirect com UTM de `links.json` (13 slugs de programas); `?o=` origem; `?u=` deep link só em domínio do slug; bots de preview recebem página de prévia; slug desconhecido → fallback. Slugs reservados: `ir, ir-stats, g, gg, ping, health, fetch, parceiros, bandeiras, links`.
- `GG_HOSTS` (padrão `ir.ticapromos.com.br, grupo.ticapromos.com.br, grupo.tudosobrepromos.com, ir.tudosobrepromos.com`):
  - `/<slug>` → distribuidor de grupos (= `/g/<slug>`, rodízio de vagas, teto `GG_LIMITE_PADRAO=1010`, `GG_TETO_WA=1024`).
  - `/<loja>/<cod5>-<grupo>` → link rastreado TSP (cache → baileys `/links-rastreio/:codigo` → shard `tsp/links_rastreio_<dia>.json`; prefixo `z` = link fixo).
  - **A ordem de `GG_HOSTS` importa** (o 1º é o exibido) e **não se remove host antigo** (derruba anúncio no ar).
- Classificação de clique (`classificarTrafego`): `preview`, `meta` (faixas IP AS32934), `robo`, `humano` — nada é bloqueado, só não conta. `GET /links/vigia`.
- Clique **nunca** toca GitHub/Baileys na hora: vai para buffer e flush periódico.

**Rotas por domínio (resumo)**
- Infra: `/ping`, `/health`, `/fetch`, `/fetch-oferta` (whitelist de domínios).
- Encurtador/links: `/ir/:slug`, `/ir-stats`, `/links/vigia`, `/links-stats`, `/l/:loja/:cod-:g`, flushes.
- Distribuidor: `/g/:slug`, `/gg/{cliques,links,saude,vagas,grupos-ativos}`, `POST /gg/{links,links/excluir,convite,sync,validar,flush}` (`tsp/grupos-links.json`; guarda anti-destruição impede memória vazia sobrescrever remoto).
- Cashback: `/inter/gift-cards`, `/meliuz/*`, `/topcashback/cashback`.
- Alertas/ofertas: `/alerta`, `/alertas/operador`, `/ofertas/{pendentes,aprovar,aprovar-e-enviar,rejeitar,rejeitar-todas,enviar,publicar,mensagem/:id}`.
- Passagens: `/passagens/{registrar,excluir,listar,comportamento,panorama}`.
- Membros e dados do membro: `/membros/*`, `/perfis/*`, `/milhas/*`, `/cartoes/*`, `/assinaturas/*`, `/compras/desejos{,/aviso}`.
- IA: `/ia/{extrair-reserva,reclamacao,roteiro-chat,roteiro-extrair}` (modelo `claude-sonnet-4-6`).
- Concierge: `/concierge/{reservas,viagens,demandas,clientes,clientes-perfil,ds160,cfg,modelos,msgs-enviadas}` (GET/POST), `cadastro`, `ds160/status`, `pendentes{,/aprovar}`, `portal{,/tema}`, `alerta` (POST/DELETE), `alertas`, `alerta/disparar`, `lembretes/checar`, `agendamento` (POST/DELETE), `agendamentos{,/checar}`, `arquivo{,/:reservaId,/:reservaId/:idx}`.
- Roteiros: `/roteiros/{publicar,meus,dados,doc-upload,doc-meta}`.
- Parceiros/lounges/cartões: `/parceiros*`, `/lounges/{buscar,sala,aeroportos}`, `/catalogo-cartoes*`, `/bandeiras`.
- TSP/afiliados: `/tsp/planilha?sheet=` (Apps Script lido **pelo proxy** — direto dá 404 com Chrome multi-conta), `/afiliados/{comissoes,descobertas,rastreio}`.
- Campanhas: `/campanhas{,/ativa,/status,/excluir,/contato,/midia,/midia/:arquivo}`.
- Castanheiras: `/castanheiras/{login,dados,acessos}`.

**Workers internos do proxy (`setInterval`)**
flush de cliques (10 min), `ggSincronizar` + validação de convites (4 min / 6 h), flush gg (2 min), cliques de convite e de links (5 min, `tsp/cliques_*_<dia>.json`), `checarLembretes` (10 min), `checarAgendamentos` do concierge (5 min, retenção 7 d, até 5 tentativas), `dispararLembreteVoo` (30 min → `workflow_dispatch` do `concierge/lembrete-voo.yml`).

**Painel do membro (`index.html`)**
- Abas: `inicio, comparador, radar, passagens, mapa, milhas, lounges, calculadoras, reclamacoes, roteiros, cartoes`.
- **Gestão de Milhas liberada para todo membro logado** (FIFO de custo, assinaturas recorrentes, transferências).
- `DEV_EMAILS` + `devAcesso()` restringem **só** a sub-aba Admin do Comparador de Cartões (`ct-sub-admin`, `ctGerarAnalise`, `ctExtrairFila`) e abas de dev.
- Sessão em `localStorage['cdv_auth']` (7 dias). `_BASE` fixo no proxy de produção. Chart.js 4.4.1, Montserrat, Phosphor.
- `PROGRAMS[].cashback:true` exclui o programa da disputa de "melhor opção".

**Workflows**
| Workflow | Gatilho | Faz |
|---|---|---|
| `coletar-historico.yml` | cron 3/3h (fallback; disparo real de hora em hora pelo `agenda-actions.js` do baileys) | `coletar.js`, `coletar-inter.js`; Méliuz/TopCashback só nas janelas; commit com `reconciliar-estado.js` (até 5 tentativas) |
| `radar-ofertas.yml` | 3/3h | `coletar-radar.js` (RSS → IA → `ofertas-pendentes.json`) |
| `resumo-diario.yml` | seg–sex (fallback; real 18h05 SP pelo baileys) | agenda resumo 20h SP em `cdv_ofertas`/`cdv_emissao` |
| `arquivar-passagens.yml` | diário 04:00 UTC | arquiva em shards semestrais (grava o shard **antes** de reduzir `passagens.json`) |
| `catalogo-meliuz.yml` | seg | `meliuz-lojas.json` |
| `coletar-cartoes.yml` | seg + dispatch com parâmetros | catálogo de cartões + `valida_catalogo.py --corrigir` |
| `guardas.yml` / `guardas-lib.yml` | push/PR | guardas (seção 0) |
Cron do GitHub está degradado (atrasa 2–4 h): disparo real vem do Railway; crons são fallback e os jobs são idempotentes.

**Catálogo de cartões (`cartoes-catalogo.json`)**
- Campo factual sem URL oficial é zerado (`valida_catalogo.py`, espelhado no `coletar-cartoes.js`). Procedência por campo.
- Normalização de `emissor`: Banco Bradesco S.A.→Bradesco; BTG Pactual S.A.→BTG Pactual; BRB/BRBCARD→BRB; Caixa Econômica Federal→CAIXA; variantes Itaú→Itaú; Sicoob→Sicoob; variantes Unicred/null→Unicred; Banco Inter S.A.→Banco Inter; Santander→Santander; XP→XP; Banestes→Banestes.

**Salas VIP (`PIPELINE.md`)**: fontes autoritativas DragonPass, Priority Pass, LoungeKey (Visa Airport Companion = DragonPass); LoungePair/LoungeReview só enriquecem; nome limpo sem data/status; nunca listar DragonPass via Google.

---

### 4.2 `baileys-server`

**Base**
- `package.json`: `"type":"module"` (**ESM — `require()` é inválido**), node ≥20, `start: node --require ./suppress-noise.cjs server.js`. `@whiskeysockets/baileys` **7.0.0-rc14 fixo**, `telegram` (GramJS), express, cors, multer, pino 8, qrcode, sharp (import dinâmico).
- `railway.json`: `numReplicas: 1`, `overlapSeconds: 0` (duas instâncias = loop 440), `drainingSeconds: 25`, volume `/app/sessao`, **sem healthcheck de propósito**.
- `server.js` (~21,9k linhas, 1,1 MB): monólito. Tem `RUNBOOK.md` (operação/incidente).

**Módulos**: `radar-amazon.js` (Creators API + estado compartilhado do radar: trilhas, destinos, cupons, templates, vitrine, listas, escala de números `turnosTsp/contaDoTurno/numerosGrupo/contaDoGrupo`), `radar-ml.js` (OAuth, token em `sessao/ml_token.json`), `radar-shopee.js` (GraphQL SHA256), `radar-magalu.js` (só converte link; preço do texto → `precoDeReferencia:true`), `radar-awin.js` + `awin-feed.js` + `awin-ofertas.js`, `monitor-precos.js`, `preco-de.js`, `categorizador.js`, `config-tsp.js`, `config-cdv.js` (`PAPEIS_CDV=['config','aprovar','disparar','avisos']`), `sync-github.js`, `feed-publico.js`, `links-rastreio.js`, `bot-tsp.js`, `bot-cdv-passagens.js`, `bot-cdv-ofertas.js`, `telegram-core.js`, `telegram-faxina.js`, `agenda-actions.js`, `insercao-ml-auto.js`, `matching-desejos.js`, `tenants.js`, `grupos-gestao-ui.js`, `suppress-noise.cjs` (**precisa ser .cjs**).

**`wa-envio/` (Go + whatsmeow)**
- Motor **só de transporte** para envio em grupo das contas secundárias (resolve "Aguardando mensagem" redistribuindo sender key). Serviço Railway separado: Root `wa-envio`, Watch Paths `/wa-envio/**`, volume `/data`.
- Env: `WA_ENVIO_TOKEN`, `PORT=8080`, `WA_LOG_NIVEL`, `QUARENTENA_H` (24 h após pareamento novo; 0 desliga), `LEITURA_URL`, `LEITURA_CONTAS`, `LOG_RETRY_GRUPOS`, `DATA_DIR`.
- No server.js: `WA_ENVIO_URL=http://wa-envio.railway.internal:8080`, `WA_ENVIO_TOKEN`, `WA_ENVIO_CONTAS` (CSV liga o motor por conta), `WA_ENVIO_GRUPOS`. O server.js só enfileira; timeout 115 s.
- Erro traz `fase`: `validacao|conexao|quarentena|preparo|upload|envio`. Antes do envio → cai no Baileys do mesmo número. **`fase: envio` (ambíguo) nunca é reenviado por outro número → outbox.**
- Leitura em sombra via `/interno/wa-leitura/{grupos,mensagens,participantes,comparacao}`.

**Contas WhatsApp (decisão de 17/09/2026)**
- `principal`: lê as passagens do CDV e as fontes do TSP (WhatsApp/Telegram), faz as funções base (DM, Hubla, campanhas, resolver JID) e é **reserva** quando outro número falha.
- `tico-02` e `tico-03`: **exclusivos para disparo em grupos** (via wa-envio). tico-02 não está nos grupos monitorados do CDV.
- Shield (remoção de golpistas) em modo PROTECT sai de tico-02/03, **nunca da principal** (`permitirPrincipal` desligado).
- `paulo`: conta do heartbeat. Contas de tenant: `t-<tenant>-<apelido>`. Credenciais em `sessao/contas/<id>/`.
- Quem dispara: `contaDoGrupo` → `contaDoTurno` → `principal`; se cair, `enviarPorContaSubstituta`. CDV: `contaEnvioCdv()`.
- 16/09/2026 a principal foi bloqueada após usar a aba Reentrada (adicionar ex-aluno em grupos) — tratar ações em massa de grupo com cautela.

**Grupos**
- `GRUPOS` (getters): `tsp_cupons`, `cdv_ofertas`, `cdv_emissao`, `cdv_executiva`, `operador`.
- `ehGrupoTsp(jid)` é **allowlist** (operador, cupons, `radarDestinos()`, destinos das trilhas) — na dúvida não marca. Controla marca d'água e links rastreados. `ehGrupoCdv()` bloqueia marca por redundância.
- Grupo do operador (`GRUPOS.operador`): **só alertas graves** (avisos de entrega suspeita e de lista concluída foram retirados).
- Toda emissão em **executiva** publicada no grupo Emissões CDV deve ser **replicada** no grupo "Emissões em executiva - CDV".

**Saída (camadas, não quebrar)**
1. `saidaSerializada()` — nunca dois `sendMessage` simultâneos; `_saidasEmVoo` adia reconexão (teto 2 min).
2. Portão de publicação global (`comPortaoDePublicacao`) — uma publicação por vez, intervalo aleatório 45–75 s; só `opcoes.semPortao` escapa.
3. `msEntreGrupos` entre destinos.
4. Outbox `sessao/outbox_falhas.json` (backoff 1–30 min, TTL 6 h, 12 tentativas).
5. Janela 8h–21h SP no worker da fila; listas passam pelo portão.

**Variáveis de ambiente principais**
- Núcleo: `PORT`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO_DADOS` (padrão no código ainda `davileles/cdv-tsp-dados` → funciona por redirect; ideal `davileles/dados`), `GITHUB_PASTA_DADOS` (`tsp`), `GITHUB_REPO_PUBLICO` (`davileles/tsp-site,davileles/tica-site`), `HUBLA_TOKEN`, `RESEND_API_KEY`, `ALERTA_EMAIL`, `CAMPANHAS_KEY`, `TSP_TENANT_SECRET`.
- Telegram: `TG_API_ID`, `TG_API_HASH`, `TG_GRUPO` (canais-fonte de cupom, ex. `@juaocupons`, `@fadadoscupons`), `TG_CANAIS_IGNORADOS`, `TG_FAXINA_DIARIA`, `TELEGRAM_BOT_{TOKEN,SECRET,ADMINS}`, `TELEGRAM_BOT_PASSAGENS_*`, `TELEGRAM_BOT_OFERTAS_*`, `OFERTAS_POLL_MIN`, `BOT_TSP_URL`.
- Flags (padrão): `AUTO_ENVIO_CUPOM` (sombra: off|sombra|on), `AUTO_ENVIO_OFERTA` (off), `AUTO_ENVIO_ALERTA` (on), `GATE_ASSIMETRICO`, `PISO_AUTO_ALERTA`; config do painel `autoEnvio.*` tem precedência.
- ML: `ML_SO_API=1` (nenhuma leitura de página pública do ML; só API oficial; sonda diária `ML_SONDA_PAGINA_H=24`), `ML_SOCIAL`, `CUPONS_ML_PAUSADO`, `CUPONS_ML_INSERCAO_AUTO` + `CUPONS_ML_AUTO_{INTERVALO_MIN,JANELA,TETO_DIA}`.
- Amazon `AMZ_*`, Awin `AWIN_*` (`AWIN_OFERTAS` off|fila|on), `MAGALU_PRECO_TTL_H`.
- `MARCA_DAGUA` (1; `@TICAPROMOS` em imagens só de grupos TSP — é path vetorial, trocar texto = gerar novo path), `RASTREIO_LINKS`, `RASTREIO_BASE` (`https://ir.ticapromos.com.br`), `MATCH_DESEJOS`, `AGENDA_ACTIONS`, `SURDEZ_EXIT`, `PUBLICACAO_SILENCIO_MIN`, `HEARTBEAT_*`, `RESUMO_MANHA_HM` (07:55), `RESUMO_DIARIO_HORA`, `OUTBOX_TTL_H`, `LISTA_JANELAS`, `MEMBROS_TETO`, `RODIZIO_VAGAS_MIN`, `TRAFEGO_*`, `FAXINA_*`, `ENVIADAS_MAX_MB`.
- Credenciais editáveis no painel (`config_tsp.json` → `aplicarCredenciais()` injeta em `process.env`, **prioridade sobre a env do Railway**): `AWIN_*`, `SHOPEE_*`, `ML_*`, `AMZ_*`, `MAGALU_LOJA`, `ANTHROPIC_API_KEY`, `TG_API_*`, `GITHUB_TOKEN`, `GITHUB_REPO_DADOS`. `estadoCredenciais` nunca devolve o valor.

**Rotas (252; 193 obrigatórias em `superficie.json`)** — tenant por token (`X-TSP-Token`/`?tsp_token=`); sem token = `tsp`; **token inválido = 401, nunca cai na raiz**.
- Saúde/sessão: `/`, `/status`, `/health`, `/painel`, `/painel-json`, `/qr`, `/pair`, `/sessao/diagnostico`, `POST /reconectar|reset-sessao|reset-sessao-completo|reset-sender-keys|renovar-identidade|curar-conflito`, `/manutencao/*`.
- Envio: `POST /enviar|enviar-imagem|enviar-arquivo|enviar-audio`.
- Contas: `/contas*`. Grupos: `/grupos*`, `/grupos/censo*`, `/grupos/membros/{eventos,hoje,ltv,permanencia,resumo,retencao,trafego}`, `/grupos-gestao/*`, `/gg/*`, `/monitor*`.
- Fila/aprovação: `/fila-envio*`, `/painel/*`, `/operacao/*`.
- Cupons: `/cupons/*`. Marketplace: `/mkt/*`, `/vitrine*`, `/listas*`, `/templates*`, `/tsp/*`, `/ml/*`, `/shopee/*`, `/magalu/*`, `/awin/*`.
- Monitor de preços: `/monitor-precos{,/config,/produtos,/curadoria,/dinheiro-na-mesa,/vereditos,/fila/:asin{,/publicar,/recusar},…}`.
- Reenvio/links: `/reenvio/candidatos`, `/links/repasse`, `/links-rastreio/*`, `/rastreio/*`.
- Shield: `/shield`, `/shield/config`, `/shield/grupo/:jid`, `/shield/falso-positivo/:id`.
- Alertas: `/alertas*`, `/alertas/travas` (trava só some quando a correção está no ar). Financeiro: `/financeiro/mensal`.
- CDV: `/cdv/*`, `/config-cdv*`, `/radar/*`, `/historico-seats*`, `/backfill-passagens`.
- Config/tenants/sync: `/config-tsp*`, `/tenants*`, `/sync*`, `/publico/{estado,publicar}`.
- Telegram: `/tg-auth*`, `/tg/*`, `/bots/diag`, webhooks `/bot-tsp/webhook/<SECRET>` etc.
- Hubla `POST /webhook/hubla`; campanhas `/campanha/*`; `/agendamentos*`; `/agenda-actions*`; `POST /api/claude` (proxy IA usado pelo gestor-cdv).

**Integrações**
- Proxy CDV fixo em `CDV_PROXY_URL` (server.js e `matching-desejos.js`): `/passagens/registrar`, `/ofertas/pendentes`, `/fetch-oferta`, `/gg/*`, `/links-stats`, `/afiliados/comissoes`, `/tsp/planilha?sheet=trafego`, `/campanhas/*`, `/compras/desejos*`.
- **Espelhos:** `PROGRAMAS_SLUG` e `IR_BASE` (`https://ir.clubedoviajante.com.br/`) devem ser iguais aos de `gestor-cdv/index.html`.
- `sync-github.js`: baixa no boot e faz push com debounce de 10 s para `dados/tsp/` (`cupons_base.json`, `vitrine.json`, `templates.json`, `listas.json`, `radar_config.json`, `config_tsp.json`, `config_cdv.json`, `awin_config.json`, `tenants.json`, `grupos_*`, `rastreio.json`, `categorias.json`…).
- `feed-publico.js`: publica `dados/feed.json` e `dados/cupons.json` em tica-site e tsp-site (debounce 10 min, varredura 30 min). Operação: `GET /publico/estado`, `POST /publico/publicar`.
- Disco `./sessao` (volume), sempre `escreverAtomico` (tmp + rename).

**Nunca faça (sessão WhatsApp)**
- **Nunca apagar `pre-key-*`, `creds.json`, `app-state-sync-*`** (Bad MAC permanente até novo QR). Só `session-*` e `sender-key-*` podem ser apagados — e `sender-key-<grupo>` anda junto com `sender-key-memory-<grupo>`.
- Erro 500 de stream nunca apaga sessão: só reconecta com backoff.
- Flush da sessão antes de qualquer `process.exit`.
- Nunca montar JID concatenando `@s.whatsapp.net` → usar `resolverJidWhatsApp`.
- `/reset-sessao-completo` só como último recurso. Nunca mudar `numReplicas`/`overlapSeconds`/healthcheck.
- Preservar os blocos de integração Telegram do server.js em qualquer edição.

---

### 4.3 `gestor-cdv` (Painel de Gestão CDV; ex-`gerador-cdv`)
- `index.html` (~6,1k linhas) é o painel inteiro. `index.js` é **servidor Express legado** não usado em produção, mas protegido pelo `superficie.json` (≥360 linhas, 11 rotas): se for remover, remover junto do marcador e com `limpeza` na mensagem.
- Abas: ✈️ **Oferta** (Link/Texto/Arquivo → IA monta mensagem), 🎟️ **Emissão** (`tab-milhas`; IA extrai JSON de emissões), 🔔 **Alertas** (fila do painel Baileys: aprovar/rejeitar/reformatar/reprocessar/mesclar/limpar), ✅ **Enviadas hoje**, 📡 **Aprovar Ofertas**, 📣 **Campanha** (blocos texto/imagem, público, ritmo, CSV, variáveis), 👥 **Reentrada**, 🛡️ **Grupos** (carrega `SERVER/grupos-gestao/ui.js`), ⚙️ **Config** (contas, QR, admins, entrada em grupos, fila).
- Constantes: `CDV_PROXY` (proxy) e `SERVER` (baileys). IA via baileys `/api/claude`. Links via `IR_BASE` + `afiliarLink()/afiliarTexto()`.
- **Sem login** (organiza, não tranca). Só a aba Campanha exige chave de operador (`X-CDV-Op`, guardada em `sessionStorage['cdv_camp_key']`). `localStorage` só para `cdv_gerador_tema`.
- Regras dos prompts de IA: **nunca** citar a fonte/blog nem usar link do blog; "programa" = programa de fidelidade, não a companhia aérea.

**Regras de negócio CDV (alertas/emissões)**
- Alertas de passagem vêm de grupos WhatsApp monitorados → extração IA → fila pendente → aprovação.
- Auto-envio de emissão aprovada quando pontos ≤ média histórica ± tolerância.
- **Alaska Atmos é proibido de envio automático** — sempre aprovação manual.
- Comparador: abas de compras bonificadas e transferências bonificadas; parceiros Tier 1 recebem mensagens individuais; projeções de frequência/próximo aumento.
- Coleta de passagens do seats.aero é feita por automação de navegador (API bloqueada para o Brasil) e entra por `/passagens/registrar`.

---

### 4.4 `concierge` (Concierge Estratégico)
- Arquivos: `index.html` (~10,5k linhas, painel), `portal.html` (portal do cliente), `cadastro.html` (formulário público com ViaCEP), `ds160.html` (formulário público do visto americano), `iata.js`, `lembrete-voo.js`, `tc.html` (página empacotada avulsa, sem ligação). Deploy por `.github/workflows/pages.yml`.
- Dados versionados **no próprio repo** (escritos pelo proxy): `reservas.json`, `viagens.json`, `demandas.json`, `modelos.json`, `agendamentos.json`, `cfg.json`, `msgs-enviadas.json`, `debug-log.json`, `alertas-concierge.json`, `arquivos/RES-<ts>_<n>.json` (anexos base64). Clientes ficam em `davileles/dados/concierge/`.
- Abas: Reservas, Nova Reserva (anexos → `/ia/extrair-reserva` por tipo: voo/hotel/carro/passeio/seguro; HTML vai como texto, PDF/imagem como documento; `normalizarAnoDatas()` completa ano), Demandas, Viagens, Clientes (inclui pendentes de aprovação), Mensagens (modelos + envio em massa `_massa*`), Gerar Roteiro, Config.
- **Autenticação:** OTP por e-mail (`/admin/*-codigo` com `app:'concierge'`) → token no cookie `cdv_conc_sess` (12 h). Wrapper global de `fetch` injeta `X-CDV-Auth` em `/concierge/*`; 401 → apaga cookie e recarrega.
- **Zero localStorage/sessionStorage** para estado. Único resto: `localStorage['concierge_cfg']` como migração/fallback legado — não expandir.
- Config (`/concierge/cfg` → `cfg.json`): grupo de alertas, URL do Baileys, conta de envio, tema, `valoresPontos`. `saveCfg` com debounce de 700 ms (POSTs concorrentes brigavam pelo SHA).
- Variáveis de modelo (`rv()`): `{{nome}}`, `{{primeiro_nome}}`, `{{pnr}}`, `{{link_roteiro}}` (`https://roteiros.clubedoviajante.com.br/<slugRoteiro>/`), `{{nome_viagem}}`, `{{economia}}`, voo (`{{cia}}`, `{{origem}}`, `{{destino}}`, `{{data_ida}}`, `{{hora_partida}}`, `{{nvoo_ida}}`…), prefixos `seguro_*`, `trem_*`, `ferry_*`, `loc_*`, `hotel_*`, `status_*`, `disp_*`, `acumulo_*`.
- Modelo: `{id, nome, texto, modo: manual|programado, gatilho, antecedencia:{valor,unidade}, horaRef}`. Agendamentos → `agendamentos.json`, worker do proxy a cada 5 min.
- **`lembrete-voo.yml`**: de hora em hora + dispatch pelo proxy; Node 20, 3 tentativas. Secrets `CDV_CONCIERGE_TOKEN` (→ `CDV_GITHUB_TOKEN`) e `CDV_SERVICO_CONCIERGE` (→ `X-CDV-Servico`). Gatilhos: `voo_ida_dt`, `voo_ida_d`, `voo_volta_dt`, `voo_volta_d`, `checkin`, `seguro_inicio`, `seguro_fim`, `viagem`, `primeiro_voo_viagem`. Alerta interno de check-in 26 h antes de cada trecho. Fuso pelo aeroporto de partida (`IATA_TZ`).
- **O painel NUNCA escreve `msgs-enviadas.json`** (só o job; chaves `"MOD-x|RES-y"`).
- DS-160: `ds160.html` → `POST /concierge/ds160`; painel acompanha `/concierge/ds160/status`.
- Portal (`portal.html`): tema escuro premium, `font-weight:300`, branco sobre `#0a0c12`, sem partículas/efeitos.
- Modelo do serviço (contexto): contrato de 12 meses (contratante, cônjuge e filhos), pagamento único por link, assinatura via ZapSign, atendimento dias úteis 8h–18h; após assinar, cliente preenche cadastro (dados, beneficiários, logins de fidelidade); aprovações de emissão acontecem na conversa.
- Planejado: extensão Chrome do concierge que preenche cadastros em sites (cias, hotéis) com dados do cliente — primeiro fechar autenticação das rotas `/concierge/*`, depois usar o mesmo login OTP.

### 4.5 `roteiros`
- Raiz: `CNAME`, `README.md`, `CLAUDE.md`, `system-prompt-final.md` (assistente de roteiros: 11 perguntas uma a uma, entrega em blocos de 2 dias), `template/index.html`, `assets/images/`. **Sem `index.html` na raiz.**
- Cada roteiro = pasta `<slug>/` com `index.html` autocontido, `capa.jpg` (Open Graph), `docs/*.pdf`, `docs-meta.json`.
- Publicação só pelo proxy (`POST /roteiros/publicar {slug, html}`), que injeta OG, sobe a capa e comita com o token do servidor.
  - Concierge: com `viagemId`, grava `slugRoteiro`, `urlRoteiro`, `roteiroPubEm` em `viagens.json` (origem do `{{link_roteiro}}`).
  - Membros: pastas `membro-<cidade>-<id5>`, registro em `roteiros-membros.json` (repo dados).
- Pages leva até ~10 min para atualizar. Visual: Barlow Condensed + Plus Jakarta Sans no tema escuro CDV.

### 4.6 `tudo-sobre-promos` (painel Tica Promos/TSP — `gestao.ticapromos.com.br`)
- `index.html` (~14,7k linhas) é o painel; `gestao.html` e `painel.html` só redirecionam para `./` (manter por links antigos).
- Navegação por `SECOES` (aba nova → incluir em `SECOES` **e** `ROTULO_ABA`): Hoje (`hoje`, `alertas`) · Publicar (`aprov`, `filaenvio`, `agend`, `divulg`, `cupom`, `oferta`, `disparos`, `livre`) · Catálogo (`vitrine`, `cupons`, `monprecos`, `descobertas`) · Resultados (`comissao`, `cliques`, `rastreio`, `trafego`+LTV) · Grupos (`grupos` Trilhas, `dist`, `admgrupos`, `saude`) · Ajustes (`config` Negócio/Técnica, `templates`, `conexao`).
- **Não remover os botões de `#tabs-legado`** (fora da tela): os badges (`#aprov-badge`…) são filhos deles.
- Login OTP (`app:'tsp'`) → `localStorage.tsp_auth` (24 h). `fetch` interceptado envia `X-TSP-Token` ao baileys e ao proxy; abas próprias usam `?tsp_token=` (`urlComToken()`). Operador (tenant ≠ `tsp`) não vê Comissão/Tráfego/LTV/Resultados (`html.visao-operador`, `localStorage['tsp-visao']`).
- Os endpoints novos do roadmap (fases 1–5 no baileys) **ainda não são consumidos** por este front.
- **Coletor de comissões** (`coletar-comissoes.yml`, 01:30 e 20:00 SP, D-1; `concurrency` sem cancelamento): secrets `AMAZON_COOKIE`, `AMAZON_COOKIE_TS`, `ML_COOKIE`, `SHOPEE_COOKIE`, `SHOPEE_APP_ID`, `SHOPEE_SECRET`, `GH_TOKEN_DADOS`, `AWIN_TOKEN`, `AWIN_PUBLISHER_ID`. `REPO_DADOS: davileles/dados` **fixado no YAML de propósito** (não remover). Grava em `dados/tsp/`: `comissoes-afiliados.json`, `desempenho-produtos.json`, `vendas-descobertas.json`, `categorias-amazon.json`, `epc-produtos.json`.
  - Amazon: JSON embutido em `/p/reporting/earnings` — **não migrar para XHR `/reporting/*`** (401).
  - `desempenho.js` em try/catch — **nunca pode derrubar a coleta principal**.
  - `cliques/vendas/comissao` = foto (gravada uma vez); `vendasRev/comissaoRev` = revisão dentro de `JANELA_REV`. O painel usa a foto.
- Planilha TSP (Apps Script, via proxy `/tsp/planilha`): hoje serve **só para custos de tráfego** (aba *tráfego*, cabeçalho linha 7); a aba *comissionamento* está aposentada/zerada — receita vem de `/afiliados/comissoes`.
- Design: Montserrat; paleta Tico — navy `#2E3348`, coral `#FA5150` (`#C22F2F` no tema claro), `#D93636`, slate `#767D93`, cinza `#D4D7E2`, fundo `#12141C`. **Sem quarta cor de marca**; laranja `#ffa500` antigo não é mais usado. Cores de loja só para dados.

### 4.7 `tica-grupos` (landings — `grupos.ticapromos.com.br`)
- `index.html` (geral) + nichos em subpastas (`bebidas/` com confirmação 18+ em `sessionStorage['tsp-18']`, `babykids/`, `ferramentas/`) + `links/index.html` (agregador de bio/stories; `?o=` origem, `?d=<slug>` destaque; slugs `geral, cupons, bebidas, babykids, ferramentas` precisam existir em `dados/tsp/grupos-links.json`).
- **CTAs sempre** `https://ir.ticapromos.com.br/<slug>?o=<origem>` — **nunca** convite fixo do WhatsApp (distribuidor faz rodízio, censo e atribuição). Origem: `?o=` → `utm_source` → padrão; máx 40 chars.
- GTM `GTM-WSXGHM5P` (o gestor de tráfego coloca rastreadores); evento `entrar_grupo {nicho, local, origem}`.
- `ferramentas/`: texto "Como o Tico escolhe" segue `curadoriaNicho` em `dados/tsp/categorias.json` — mudou lá, mude aqui.
- README ainda fala do roteamento por `?g=` (removido). Fontes Nunito + Bebas Neue; `--orange` é nome legado para coral.

### 4.8 `tica-site`, `tsp-site`, `davileles-site`
- `tica-site` (`ticapromos.com.br`, ativo) e `tsp-site` (`www.tudosobrepromos.com`) têm o mesmo `index.html`; `dados/feed.json` e `dados/cupons.json` são publicados pelo `feed-publico.js` — **ninguém edita `dados/` à mão**.
- `tsp-site` fica no ar enquanto houver anúncio apontando para ele; depois vira redirect.
- `davileles-site` (`davileles.com`) lê dados por HTTP do tsp-site (o fallback `gestao.tudosobrepromos.com/dados/` dá 404). **Quando o tsp-site sair, apontar `BASES_DADOS` para `ticapromos.com.br/dados/`.**

### 4.9 Regras de negócio TSP / Tica Promos
- Fontes: grupos WhatsApp + canais Telegram (GramJS). **O TSP não dispara no Telegram** (Telegram é só fonte).
- Radares: Amazon (Creators API, rodízio de tags), Mercado Livre (OAuth2, links de perfil social, cupons), Shopee, Magalu, Awin (feed + API, cotas, roteamento por nicho).
- **Cupom só entra numa oferta** quando citado explicitamente na oferta monitorada ou sugerido pelo usuário (bot/site) — o sistema **nunca** escolhe sozinho um cupom da base.
- Cupons vão também para os **grupos de nicho** (não só gerais/cupons).
- Gate de cupom (`AUTO_ENVIO_CUPOM`): valida loja, código, tipo, valor, mínimo, regra sem teto para %, cruzamento com o texto-fonte; worker de espaçamento.
- Gate de oferta (`AUTO_ENVIO_OFERTA`): desconto e preço verificado (`precoDeReferencia` bloqueia auto-envio); grava `gruposNicho`/`categoria`. Oferta com preço "por" trocado pelo do post **nunca** auto-envia. Backlog antigo do Telegram **nunca** sai sozinho. Envio interrompido volta para aprovação manual.
- Filtro de disparo pela série de preços (`filtroDisparo` em `/monitor-precos/config`): aprovado, **em modo sombra** medindo o corte — vetar falso desconto; produto com série madura só sai com queda real; produto novo segue critério atual. Captura da Amazon nos grupos alimenta a série.
- Awin: loja com preço de sócio/clube (ex. Clube Wine) → usar **sempre o preço de sócio** como "Por".
- Nicho **Bebidas**: aceita acessórios de quem bebe (ex. kit de copos); shampoo/brinquedo não. **ML não comissiona bebidas** → produto de bebida do ML não entra no nicho.
- Mercado Livre: `ML_SO_API=1` (só API oficial). Inserção de cupons na conta ML: **automática, espaçada** (intervalo aleatório de minutos, janela diurna) — decisão de 22/09/2026; prioridade é ter todos os cupons inseridos na própria conta.
- Links rastreados: todo envio TSP sai como `ir.ticapromos.com.br/<loja>/<codigo>-<grupo>` (grupo = número, ex. `-15`) para contar cliques e decidir reenvio.
- Marca d'água `@TICAPROMOS` só em grupos TSP (`ehGrupoTsp`), nunca em CDV.
- Mascote **Tico** (andorinha-do-ártico), verbo "ticar", Instagram `@ticapromos`; também cobre avatares de grupos do CDV (comunidade, balcão, Superpromos). Bíblia do Tico em `davileles/dados`.
- Extensão Chrome "Captura Tica" (em outro repo): lê a página do produto, cadastra na vitrine e oferece disparo automático.
- Domínio: migração tudosobrepromos → **ticapromos**; chaves `tsp-*` continuam por compatibilidade.
- Roadmap "aprendizados do Cupons do Oda": **fases 1–5 concluídas** (quarentena, travas, resumo da manhã, ledger de membros, defesa do encurtador, custo por entrada, LTV÷CAC, vereditos do monitor, candidatos a reenvio, dinheiro na mesa, Shield em OBSERVE, trava de porta fechada, financeiro mensal, repasse de links, curadoria que aprende). 5.5 (atendimento de pedidos) descartado.

---

### 4.10 `teamrausch` (estúdio — isolado de tudo)
- Dois serviços Railway no mesmo repo (Root Directory diferente):
  - `app/` (`wellhub-checkin`, CommonJS, só `express`) — `app.teamrausch.com.br`.
  - `whatsapp/` (`teamrausch-whatsapp`, CommonJS, `baileys` **6.7.24 fixo**) — serviço Railway "teamrausch", sessão em `/data`. Rotas `GET /status|/health`; com Bearer `WHATSAPP_TOKEN`: `/qr`, `/qr.json`, `/grupos`, `/grupos/participantes`, `/contatos`, `POST /enviar`.
- **Envio do estúdio fica no Baileys próprio** — não migrar para whatsmeow/wa-envio; isolamento do baileys-server/Tica é essencial.
- `WHATSAPP_URL` correto: `http://teamrausch.railway.internal:8080/enviar` (host = nome do serviço, não a pasta). ECONNREFUSED = porta errada; ENOTFOUND = nome errado. Diagnóstico: `/wellhub/whatsapp/sondar`. `config.envio.url` (Configurações → Técnica) sobrepõe a env.
- Railway: `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0`, uma réplica (garantia de sem overbooking).
- Auth: `PANEL_TOKEN` (`?token=` ou `X-Panel-Token`), `DEVICE_TOKEN` (totem/catraca), login do aluno por telefone com código de 6 dígitos no WhatsApp.
- Persistência: **volume `/data` é a fonte da verdade** (`agenda.json`, `config.json`, `matriculas.json`, `checkins.json`, `mensagens.json`, `historico-aulas.json`, `wellhub.json`…); GitHub é só backup (repo **privado**, debounce, SHA fresco).
- Env principais: `WELLHUB_*` (API oficial ainda não liberada), poller do portal `POLLER_PORTAL_*` + `WELLHUB_PORTAL_*` + Keycloak `WELLHUB_KC_*`, `FREQ_*`, `MSG_*`, `RELATORIO_*`, `ANIV_AVISO_*`, `PLANILHA_ALUNOS_*`, `RESEND_*`, `GITHUB_*`. A partir da config v2, a aba Configurações vale mais que a env. `config.avisos = {checkinConfirmado, emails[], telefones[], grupos[]}`. `PRESENCA_CONFIRMACAO_ATIVA` foi **removida**.
- Rotas: `/wellhub/*` (webhook, poller, frequência, aniversariantes, relatório…), `/api/*`, `/acesso`, `/agenda-api/*` (+ `/matriculas`, `/mensagens` — envio **um por chamada**, massa conduzida pelo navegador), `/totem-api/*`, `/tv-api/*`.
- Páginas: `app/public/index.html` (aluno+admin), `recepcao.html`, `totem.html` (tablet Android; botão "Ligar TV"), `tv.html` (mural + **receptor Chromecast CAF v3** "Mural Team Rausch" registrado no Google Cast Console → `app.teamrausch.com.br/tv.html`; sem emoji, área segura de overscan).
- Regras de negócio:
  - **Cobrança Wellhub só pelo check-in**, separada da presença do totem. Máximo 12 check-ins/mês por aluno Wellhub; quem passa disso paga à parte.
  - Conquistas contam check-in + dias de totem sem check-in **só depois** de batida a meta de check-ins do mês. Meta: 8 (2x/sem) ou 12 (3x/sem).
  - Aluno que deixa de ser experimental no meio do mês: meta Wellhub e comunicação de cobrança **proporcionais** ao período restante.
  - Experimental recebe **só** a mensagem de boas-vindas (agradecer, convidar a voltar), sem a conquista "Primeira aula".
  - Ciclos: manhã 5h–14h; tarde até 21h. Avisos ao grupo do operador de conquista/meta saem em **dois resumos diários (14h e 21h)**; check-in individual no funcional e aniversariantes continuam na hora.
  - Horários: planilha 05:00, aniversariantes 05:30, relatório 06:00, modelos 09:00, frequência 10:00, redes de segurança 20:30/20:45.
  - Pendências de UI de créditos: badge de saldo, aviso "custa 1 crédito" por horário, botão de fechamento do estúdio em lote, extrato de créditos no perfil.
- Sem `.github/` nem guardas neste repo.

### 4.11 `financas`
- `index.html` (SPA, Pages) + `financas-dados.json` + `proxy/` (Express **ESM**, `financas-ai-proxy`, Railway Root `proxy`). Guardas presentes.
- Persistência: `localStorage` (`gff-data`, `gff-cfg`, `gff-prefs`) + sync **pelo navegador** na API do GitHub (token fine-grained configurado na aba Nuvem, só no navegador).
- Proxy de IA **próprio** (não é o do CDV): `POST /api/interpretar-fatura`; env `ANTHROPIC_API_KEY`, `PROXY_SHARED_SECRET` (`x-proxy-key`), `ALLOWED_ORIGINS`.
- Abas: Visão geral, Despesas, Receitas, Projeção (parcelas), Importar fatura (PDF via pdf.js + IA), Cadastros, Nuvem; modo "ocultar valores".

### 4.12 `castanheiras` (condomínio)
- `index.html` (Pages) + `api/index.js` + `api/inter.js` (Express CommonJS, Railway `castanheiras-production.up.railway.app`). Sem guardas.
- Dados no repo **privado `davileles/castanheiras-dados`** (`dados.json`, `comprovantes/<id>.*` até 6 MB). Só o servidor fala com o GitHub (token restrito a esse repo). Planilha Google Sheets foi **abandonada**.
- API em `/castanheiras/*` e na raiz (compatibilidade): `/login`, `/dados`, `/acessos`, `/inter/{status,saldo,extrato,transacoes}`, `/comprovantes`, `/health`.
- Acesso por e-mail (`acessos`/`admins` dentro do `dados.json`, nunca expostos). Não-admin recebe dados redigidos → **só admin grava** (senão o payload redigido apagaria dados). POST relê SHA e grava `atualizadoPor`.
- Banco Inter via mTLS (`INTER_CLIENT_ID`, `INTER_CLIENT_SECRET`, `INTER_CERT`, `INTER_KEY`, `INTER_CONTA`, `INTER_SCOPE=extrato.read`, `INTER_BASE`).
- Regras: 6 aptos (101, 102, 201, 202, 301, 302); cota R$ 610 (1º e 2º andar) e R$ 725 (3º). Importação de extrato (OFX/QFX/CSV/TXT ou API Inter): créditos → cotas, débitos → despesas. Pagador reconhecido por nome + **apelidos** (Pix do mesmo apto pode vir de nomes diferentes). CS Service (limpeza) tem categoria própria. Reembolsos fora dos lançamentos (regime de caixa). Previsão = média dos últimos 6 meses.

---

## 5. Identidade visual (referência rápida)
- **CDV painéis/gestor/concierge (escuro):** `--bg:#1e2535`, `--surface:#2a3246`, `--surface2:#323c54`, `--border:#3d4a66`, `--accent:#ff585e`, `--accent2:#e04449`, `--blue:#126eff`, `--text:#eeeeee`, `--muted:#8a9bbf`; Montserrat. Gestor tem tema claro (`--bg:#f2f5fa`, `--accent:#d9333a`).
- **CDV conteúdo/roteiros:** Barlow Condensed 900 + Plus Jakarta Sans; `#2a3246`, `#eeeeee`, `#ff585e`, `#126eff`.
- **Tico/Tica Promos:** navy `#2E3348`, coral `#FA5150`, slate `#767D93`, cinza `#D4D7E2`, branco; vermelho de avatar `#D93636`.
- **Green (outro negócio):** verde-lima `#9DC645`, esmeralda `#30B080`.

---

## 6. Riscos e pendências conhecidos (não resolvidos)
- `concierge` é **público** e guarda reservas, viagens, anexos e agendamentos com dados pessoais → candidato a migrar para `davileles/dados` (como já foi feito com clientes e `roteiros-membros.json`).
- `painel-cdv/alertas.json` ainda contém e-mail de membro (migração pendente; `coletar.js` grava via checkout).
- Portal do concierge abre só com e-mail (sem código).
- `concierge/index.html` → `rgChamarIA` chama `api.anthropic.com` direto sem chave — deveria passar pelo proxy (`/ia/*`).
- CORS do proxy lista `GET, POST, OPTIONS`, mas há rotas `DELETE`.
- Concierge: popular retroativamente `roteiros-membros.json` para roteiros publicados antes da associação por e-mail; `cli-31`/`cli-34` com CPF duplicado.
- Mensagens recorrentes/agendadas do TSP ainda não suportam anexo.
- Consolidação de domínios: aposentar `davileles.com`; tudo para `ticapromos.com.br` / `clubedoviajante.com.br`.
- `baileys-server`: padrão de `GITHUB_REPO_DADOS` no código ainda é o nome antigo `cdv-tsp-dados`.
- READMEs desatualizados: `tica-grupos` (`?g=`), `tsp-site`, `tudo-sobre-promos` ("Gerador de mensagens"); `gestor-cdv` ainda cita "gerador-cdv" num comentário.
