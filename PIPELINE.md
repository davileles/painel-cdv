# Pipeline de Pesquisa — Salas VIP CDV

> Documento oficial do processo de coleta e atualização do banco de dados `lounges-db.json`.  
> Versão: 1.0 | Criado: 2026-07-10

---

## Hierarquia de fontes

### Tier 1 — Bases oficiais (acesso PP/LK/DP)

As três fontes abaixo são as **únicas** autorizadas a determinar se uma sala aceita ou não os programas Priority Pass, LoungeKey e DragonPass. Se uma sala não aparece nessas fontes para um programa, ela NÃO aceita esse programa — independente do que outros sites afirmem.

| # | Fonte | URL de entrada | O que fornece |
|---|---|---|---|
| 1 | **DragonPass** | `dragonpass.com/explore/country/brazil/BR` → IDs → `dragonpass.com/explore/airport/[ID]` | Salas DP, fotos CDN |
| 2 | **Priority Pass** | `site:prioritypass.com [IATA]` → fetch da página | Salas PP, horários, notas, tipo de experiência |
| 3 | **LoungeKey / Mastercard** | `site:airport.mastercard.com [IATA]` → fetch por código `[IATA][N]` | Salas LK, fotos Cloudfront, localização oficial, políticas |

### Tier 2 — Enriquecimento

Usadas para complementar com fotos, localização detalhada, outros tipos de acesso (companhia aérea, banco, cartão específico), restaurantes com crédito e novidades recentes.

| # | Fonte | O que fornece |
|---|---|---|
| 4 | **LoungePair** | Fotos complementares, dados operacionais |
| 5 | **LoungeReview** | Slugs canônicos, reviews, salas fechadas |
| 6 | **Global Lounge Network** | Salas GLN com fotos e dados próprios |
| 7 | **Passageiro de Primeira / Melhores Destinos** | Salas exclusivas de banco, novidades, fechamentos |
| 8 | **Cartões de Crédito.me / Melhores Cartões** | Restaurantes com crédito DragonPass, salas de banco |

---

## Passo a passo por aeroporto

### Passo 1 — DragonPass
1. Fetch `dragonpass.com/explore/country/brazil/BR` → extrai IDs dos aeroportos brasileiros
2. Para internacionais: busca `site:dragonpass.com explore airport [nome]` → pega URL → fetch
3. Fetch `dragonpass.com/explore/airport/[ID]` para cada aeroporto
4. ⚠️ **Nunca usar Google para listar salas DP** — ele trunca. Fetch direto é obrigatório
5. Se não aparece na página Brasil → busca `site:dragonpass.com [NOME DO AEROPORTO]` para achar o ID

### Passo 2 — Priority Pass
1. Busca `site:prioritypass.com [IATA]` → URL da cidade
2. Fetch da página do aeroporto → lista completa de experiências
3. Extrai: códigos de sala (ex: `GIG9`), horários, notas, tipo (lounge / spa / restaurante), políticas

### Passo 3 — LoungeKey / Mastercard
1. Busca `site:airport.mastercard.com [IATA]` ou `airport.mastercard.com loungecode [IATA] [nome]` → confirma códigos
2. Fetch `airport.mastercard.com/en/lounge-finder/lounge?loungecode=[CÓDIGO]` para cada sala
3. ⚠️ Se retornar aeroporto diferente, o código não existe — buscar o código correto antes de novo fetch
4. Extrai: fotos Cloudfront, localização exata, políticas completas

### Passo 4 — LoungeReview
1. Busca `site:loungereview.com [IATA] [ano]`
2. Hubs grandes (+5 salas): buscas adicionais por operadora
3. Extrai: slugs canônicos, reviews, salas fechadas ou renomeadas

### Passo 5 — LoungePair
1. Fetch `loungepair.com/at/[IATA]/`
2. Extrai: fotos CDN complementares, dados operacionais

### Passo 6 — Tier 2 brasileiro (somente aeroportos nacionais)
1. Busca `site:passageirodeprimeira.com [IATA]`
2. Busca `site:cartoesdecredito.me [IATA]`
3. Extrai: salas exclusivas de banco, restaurantes com crédito DragonPass, reformas, inaugurações

---

## Regras obrigatórias

### Nome da sala
Apenas o nome limpo. Nunca incluir datas, status ou informações operacionais.
```
✅ "W Premium Lounge (Internacional)"
❌ "W Premium Lounge (Internacional) — inaugurada jun/2026"
❌ "VIP Lounge Inter (Em breve)"
```

### Visa Airport Companion = DragonPass
Registrar sempre como `DragonPass`. Nunca usar "Visa Airport Companion" como programa.

### Deduplicação
Mesmo aeroporto + mesma localização/terminal + nomes similares = mesmo local.  
Criar um único registro consolidando todos os programas de acesso.

### Fotos de restaurantes e experiências
Só incluir foto se houver imagem real e específica do estabelecimento em fonte pública.  
Sem foto própria → omitir campo `foto` (placeholder 🛋️ no painel).  
Nunca usar foto de outra sala como substituta.

### Acesso removido
Se DP, PP ou LK não listam mais uma sala que antes era aceita, atualizar o campo `programas` e registrar no campo `obs`. Não assumir que acesso permanece sem confirmação nas fontes oficiais.

---

## Estrutura do JSON por sala

```json
{
  "nome": "nome limpo, sem datas ou status",
  "slug": "slug canônico do LoungeReview",
  "terminal": "localização oficial LoungeKey",
  "horario": "horário oficial LoungeKey ou PP",
  "localizacao": "texto exato LoungeKey em português",
  "overview": "síntese das fontes",
  "foto": "URL por ordem de prioridade (omitir para restaurantes sem foto própria)",
  "amenidades": {
    "comida": [],
    "bebida": [],
    "outros": []
  },
  "obs": "políticas críticas — máx. horas, restrições, alertas de acesso",
  "programas": ["lista unificada, usando DragonPass (nunca Visa Airport Companion)"],
  "fontes": ["LoungeKey", "Priority Pass", "DragonPass"],
  "urlLoungereview": "https://loungereview.com/lounges/[slug]/",
  "urlFotos": "https://loungereview.com/lounges/[slug]/#photos"
}
```

---

## Prioridade de foto

```
1º LoungeKey Cloudfront  (d10mzz35brm2m8.cloudfront.net)  — melhor qualidade
2º DragonPass CDN        (image.m.dragonpass.com)          — profissional
3º LoungePair CDN        (is.loungepair.com)               — editorial
4º Global Lounge Network (globalloungenetwork.com/wp-...)  — salas GLN
5º Mesma operadora       (visual aproximado, só salas VIP) — fallback
6º Placeholder 🛋️                                         — restaurantes sem foto + último recurso
```

---

## Constância de revisão

| Ciclo | Escopo | Critério |
|---|---|---|
| **Semanal** | GRU, GIG, CNF, CGH, BSB, POA | Aeroportos de maior movimento — verificar adições/remoções nas 3 bases oficiais |
| **Mensal** | Todos os aeroportos do Bloco 1 e 2 | Revisão completa do pipeline para salas brasileiras principais |
| **Trimestral** | Blocos 3 e 4 (internacionais e secundários) | Revisão completa internacionais e aeroportos menores |
| **Urgente** | Aeroporto afetado | Qualquer notícia de abertura, fechamento ou mudança de programa em PdP, Melhores Destinos ou GLN |

---

## Status dos blocos

| Bloco | Aeroportos | Status | Última revisão |
|---|---|---|---|
| **1** | GRU, GIG, BSB, CNF, CGH, CWB, SSA, FOR, REC, POA | ✅ Concluído | 2026-07-10 |
| **2** | FLN, MAO, NVT, IGU, NAT, SDU, VCP, GYN, BEL, SLZ, CGB | ✅ Concluído | 2026-07-10 |
| **3** | LIS, MIA, LHR, AMS, CDG, EZE, SCL, LIM, DOH | ✅ Concluído | 2026-07-10 |
| **4** | Demais brasileiros e internacionais | 🔲 A fazer | — |
