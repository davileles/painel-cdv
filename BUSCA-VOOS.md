# Busca de voos — visão geral e próximos passos

> Documento de produto e técnica da busca de voos do Clube do Viajante. Vale para o painel do viajante (`painel-cdv`), o Gestor (`gestor-cdv`) e o Concierge (`concierge`). Atualizado em 20/10/2026.

## 1. O problema

Quem pesquisa passagem com pontos repete a mesma busca em vários lugares: Azul Fidelidade, LATAM Pass, Smiles e, em dinheiro, também GOL. Cada site tem o próprio formulário, e comparar exige abrir todos, preencher a mesma rota e as mesmas datas e anotar os resultados. Para quem faz isso todo dia (o Davi, o concierge) e para o membro que quer saber "quanto custa ir de BH para São Paulo em pontos", o processo é lento e cansativo.

**Objetivo:** o usuário preenche a busca uma vez e recebe, no mesmo lugar, tudo o que precisa para decidir onde emitir.

## 2. O que já existe (entregue em 20/10/2026)

### Aba "Buscar voos" nos três painéis
- Formulário único: origem, destino, só ida ou ida e volta, datas (🛫 ida, 🛬 volta), adultos, crianças, bebês, cabine (econômica ou executiva) e pagamento (pontos, dinheiro ou ambos).
- Autocomplete de aeroporto por código ou cidade, com o nome dentro da caixa ao lado do código. Cidade em português (Londres, Milão, Tóquio…), códigos de cidade que agrupam aeroportos (SAO, RIO, BHZ, NYC, LON, PAR…) e aeroportos que faltavam na base (Praga, Varsóvia, Aruba, Curaçao, Maldivas…). Três letras que formam um código mostram só ele.
- Geração dos links de pesquisa já preenchidos, um cartão por programa, com **Abrir** e **Copiar link**, mais **Copiar todos os links** (texto pronto com trecho, datas e links). Com "Ambos", aparecem a lista em pontos (Azul, LATAM Pass, Smiles) e a lista em dinheiro (Azul, LATAM, GOL).
- Formatos de link **conferidos com buscas reais** dos quatro programas (detalhes na seção 4.3 do `CLAUDE.md`).
- O código do bloco (`bv*`) é **o mesmo** nos três painéis: mudou um, muda os outros.

### Sonda pelo servidor (só Gestor e Concierge)
- Cartão "🧪 Sonda" na aba Buscar voos → `GET /voos/sonda` do proxy (`painel-cdv/busca-voos.js`).
- Faz uma busca fixa (CNF → GRU, ida daqui a 30 dias) em cada programa a partir do Railway e mostra como cada site responde: código HTTP, tempo, sinais de proteção e o início da resposta. Não traz voos.

### Preços ao vivo via ZenRows (Gestor e Concierge — teste, desde 20/10/2026)
- Cartão "💲 Preços ao vivo" na aba Buscar voos → `GET /voos/precos` do proxy (`painel-cdv/busca-voos-precos.js`). Usa a rota, as datas, os passageiros, a cabine e o pagamento do formulário.
- Para cada programa (pontos: Azul Fidelidade, LATAM Pass, Smiles; dinheiro: Azul, LATAM, GOL) o proxy pede ao ZenRows que abra a mesma página de busca dos links, num navegador de verdade com IP residencial do Brasil (`js_render`, `premium_proxy`, `proxy_country=br`, `json_response`). O ZenRows devolve o HTML e as chamadas internas (XHR) que a página fez; o proxy lê os voos do JSON dessas chamadas.
- Leitura específica por programa (LATAM `offers/search`, Smiles `airlines/search`, Azul `availability`) + leitura genérica de reserva (procura listas com horário de saída e chegada; aparece com "≈" na tabela). Ida e volta = duas buscas só de ida.
- Tabela: programa, voo, saída, chegada, escalas, pontos, taxas, dinheiro — pontos primeiro, do menor para o maior. Um selo por programa mostra se leu, quantos voos ou o motivo da falha.
- Assíncrono: a rota responde na hora e busca em segundo plano (até 3 páginas ao mesmo tempo); a página consulta de novo a cada 5 s. Mesma busca em 15 min sai do que já foi guardado (`&novo=1` força).
- Acesso: chave de operador (`X-CDV-Op`, gestor) ou sessão do concierge (`X-CDV-Auth`). Gasta créditos do ZenRows (~25 por página); teto diário `ZENROWS_LIMITE_DIA` (padrão 150 páginas).
- Env do `cdv-proxy`: **`ZENROWS_API_KEY`** (sem ela a rota responde 503 "não configurada"), `ZENROWS_LIMITE_DIA`, `ZENROWS_ESPERA_MS` (espera após abrir a página, padrão 15000, máx. 30000).
- Ajuste da leitura: `GET /voos/precos/bruto[?fonte=latam-pontos]` (mesmo acesso) devolve a última captura de cada fonte — lista de chamadas da página, qual foi lida e o início do JSON. Primeira coisa a olhar quando um programa vier "sem voos".

## 3. O que foi aprendido com a sonda

Resultado de 20/10/2026, a partir do Railway (região `sfo`, EUA):

| Programa | Resposta |
|---|---|
| LATAM | Página e busca sem resposta (20 s). |
| Smiles | A casca da página abre; a busca de voos responde 403 "Access Denied" (Akamai). |
| Azul | O site responde 403 "Access Denied" (Akamai). O servidor de dados aceita conexão, mas não foi possível obter voos. |
| GOL | A página abre; a busca de voos responde 406. |

Mapeamento no navegador (20/10/2026): Azul e GOL carregam o mesmo script de proteção do Akamai e recusaram a busca mesmo em navegador aberto no Brasil, quando controlado por automação.

**Conclusão:** os quatro programas protegem a busca de voos contra acesso automatizado, e essa proteção não depende do volume nem só da origem da conexão. Buscar preços direto nos sites, a partir do nosso servidor, **não é um caminho viável** para o produto.

## 4. Para onde ir: a tabela de pontos e preços

> **Em andamento (20/10/2026):** o caminho escolhido para o teste é o ZenRows (seção 2). Próximos passos: (1) pôr `ZENROWS_API_KEY` no Railway; (2) rodar uma busca por programa e, com `/voos/precos/bruto`, acertar a leitura de quem vier "sem voos" ou com "≈" (GOL ainda só tem leitura genérica; taxas da Smiles vêm de outra chamada); (3) medir tempo e créditos por busca antes de pensar no painel do viajante. Os caminhos abaixo continuam válidos como alternativa.

A meta continua sendo mostrar ao usuário, na própria aba, uma tabela com programa, voo, horários, escalas, pontos + taxas e preço em dinheiro, do menor para o maior. Os caminhos possíveis, em ordem de recomendação:

### 4.1 Histórico das emissões do Clube (rápido, sem dependência externa)
O painel já recebe as passagens coletadas (`passagens.json`, histórico e panorama). Para a rota e o período pesquisados, mostrar as emissões recentes: programa, cabine, pontos, taxas, quando foi vista. Não é preço ao vivo, mas dá a referência de "quanto essa rota costuma sair" antes de abrir os sites. Funciona no celular e não quebra.
- Onde: aba Buscar voos, abaixo dos links.
- Dados: `GET /passagens/listar` (já exige membro ou operador).
- Pendência: definir a janela (ex.: últimos 90 dias) e como casar códigos de cidade (SAO, RIO) com os aeroportos das emissões.

### 4.2 Fonte de dados com acesso autorizado (preço ao vivo)
Preço ao vivo só com uma fonte que libere esse acesso: API de parceiro de agregador, sistema de distribuição (GDS/NDC) ou acordo direto com um programa. Levantar quais existem para o mercado brasileiro, custo, cobertura (pontos × dinheiro) e condições de uso.
- Pendência: pesquisa de mercado e decisão de custo.

### 4.3 Abrir todas as buscas de uma vez (uso próprio)
Botão "Abrir todas" que abre as pesquisas dos programas em abas, já preenchidas. Resolve a repetição para quem pesquisa muito, sem depender de nenhum dado externo.

## 5. O que não vai para o painel do viajante por enquanto
- A sonda (seção 2) é ferramenta de operação, só no Gestor e no Concierge.
- A tabela de pontos e preços só entra no painel do viajante depois de validada em um dos caminhos da seção 4.

## 6. Arquivos
- `painel-cdv/index.html` — aba `tab-buscavoos` (bloco `bv*`).
- `gestor-cdv/index.html` e `concierge/index.html` — aba Buscar voos (bloco `bv*`) + sonda (bloco `bvs*`).
- `painel-cdv/busca-voos.js` — sonda; `painel-cdv/busca-voos-precos.js` — preços ao vivo via ZenRows; `painel-cdv/index.js` — rotas `GET /voos/sonda`, `GET /voos/precos` e `GET /voos/precos/bruto`.
- `gestor-cdv/index.html` e `concierge/index.html` — cartão de preços (bloco `bvp*`, igual nos dois).
- `iata.js` (concierge, gestor e painel) — base de aeroportos.
