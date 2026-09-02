// reconciliar-estado.js
// Aplica o resultado de uma coleta sobre a versão MAIS RECENTE do repositório,
// sem perder o que o proxy gravou enquanto a coleta rodava.
//
// PROBLEMA QUE RESOLVE
// O step "Salvar arquivos" fazia `git pull --rebase` e, no primeiro conflito,
// abortava o rebase e saía com código 1 — o commit da coleta era DESCARTADO.
// Em 01/09 isso aconteceu duas vezes (11h01 e 15h15): os coletores rodaram,
// as pontuações foram extraídas e nada foi salvo. O log era sempre o mesmo:
//     CONFLICT (content): Merge conflict in ofertas.json
// Faz sentido: ofertas.json e ofertas-pendentes.json são escritos pelos DOIS
// lados — pelo coletor aqui e pelo proxy (aprovar/rejeitar oferta no gerador).
// Git não tem como saber unir duas listas de ofertas; nós temos.
//
// COMO FUNCIONA
// O workflow salva o resultado da coleta numa pasta fora da árvore do git,
// faz `git reset --hard origin/main` (árvore = remoto atual) e chama este
// script. Para cada arquivo:
//   - lista com `items[]` e `id`  → une job + remoto por id
//   - qualquer outro              → o arquivo do job vence
// Depois disso não existe conflito possível: o commit já nasce em cima do
// remoto atual.
//
// REGRAS DE UNIÃO (as que o git não conseguiria inferir)
//   1. Oferta rejeitada pelo operador (ofertas-rejeitadas.json do remoto) não
//      volta para as pendentes — sem isso, cada coleta ressuscitaria o que
//      acabou de ser recusado.
//   2. Oferta já aprovada (presente em ofertas.json do remoto) sai das
//      pendentes — senão apareceria nos dois lugares.
//   3. Item do job vem primeiro; empate de id, o do job vence (é o mais novo).
//
// Uso: node reconciliar-estado.js <pasta-com-o-resultado-da-coleta>

const fs = require('fs');
const path = require('path');

// Tetos iguais aos de quem gera cada arquivo — reconciliar não pode fazer a
// lista crescer além do que o coletor deixaria.
const MAX_POR_ARQUIVO = {
  'ofertas.json': 100,             // MAX_OFERTAS_APROVADAS, mensagem-radar.js
  'ofertas-pendentes.json': 100,   // teto do coletar.js; o radar já corta em 60
};
const MAX_IDS_PROCESSADOS = 2000;  // mesmo slice(-2000) do coletar-radar.js

// Arquivos com escrita concorrente (coletor + proxy): união por id.
const UNIR_POR_ID = ['ofertas.json', 'ofertas-pendentes.json'];

// Listas planas de IDs já vistos: união de conjuntos, mantendo o fim da lista
// (os mais recentes) — perder um ID daqui faz uma oferta velha ser reprocessada.
const UNIR_LISTA_IDS = ['ofertas-processados.json'];

// Arquivos de dono único (só os coletores escrevem): a versão do job vence.
const SOBRESCREVER = [
  'historico.json',
  'alertas.json',
  'variacoes-notificadas.json',
  'meliuz-lojas.json',
  'topcashback-lojas.json',
  'cashback-intl-estado.txt',
  'validades-livelo.json',
];

function lerJson(arquivo, padrao) {
  try {
    if (!fs.existsSync(arquivo)) return padrao;
    const bruto = fs.readFileSync(arquivo, 'utf8');
    if (!bruto.trim()) return padrao;
    return JSON.parse(bruto);
  } catch (e) {
    console.warn(`[RECONCILIAR] ${arquivo} ilegível (${e.message}) — usando padrão.`);
    return padrao;
  }
}

function itensDe(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.items)) return obj.items;
  return [];
}

function unirPorId(doJob, doRemoto, excluir, teto) {
  const vistos = new Set();
  const saida = [];
  for (const item of [...doJob, ...doRemoto]) {
    const id = item && item.id != null ? String(item.id) : null;
    if (!id) continue;
    if (vistos.has(id)) continue;      // job já entrou; o remoto é o duplicado
    if (excluir.has(id)) continue;
    vistos.add(id);
    saida.push(item);
  }
  return saida.slice(0, teto);
}

function main() {
  const origem = process.argv[2];
  if (!origem) {
    console.error('Uso: node reconciliar-estado.js <pasta-com-o-resultado-da-coleta>');
    process.exit(2);
  }
  if (!fs.existsSync(origem)) {
    console.log(`[RECONCILIAR] ${origem} não existe — nada a aplicar.`);
    return;
  }

  // Estes dois vêm do REMOTO (a árvore está em origin/main neste ponto) e são
  // lidos antes de qualquer escrita.
  const rejeitadasRemoto = new Set(
    (lerJson('ofertas-rejeitadas.json', []) || []).map(String)
  );
  const aprovadasRemoto = new Set(
    itensDe(lerJson('ofertas.json', { items: [] })).map(o => String(o.id))
  );

  for (const nome of SOBRESCREVER) {
    const doJob = path.join(origem, nome);
    if (!fs.existsSync(doJob)) continue;
    fs.copyFileSync(doJob, nome);
    console.log(`[RECONCILIAR] ${nome}: versão da coleta aplicada.`);
  }

  for (const nome of UNIR_POR_ID) {
    const doJob = path.join(origem, nome);
    if (!fs.existsSync(doJob)) continue;

    const jobObj    = lerJson(doJob, { geradoEm: null, items: [] });
    const remotoObj = lerJson(nome,  { geradoEm: null, items: [] });
    const itensJob    = itensDe(jobObj);
    const itensRemoto = itensDe(remotoObj);

    // Rejeitada nunca volta. Aprovada não fica pendurada nas pendentes.
    const excluir = new Set(rejeitadasRemoto);
    if (nome === 'ofertas-pendentes.json') {
      for (const id of aprovadasRemoto) excluir.add(id);
    }

    const teto = MAX_POR_ARQUIVO[nome] || 100;
    const unidos = unirPorId(itensJob, itensRemoto, excluir, teto);

    // Só grava se a LISTA mudou. Reescrever só para atualizar `geradoEm`
    // criaria um commit a cada coleta mesmo sem oferta nova — e cada commit
    // dispara um pages-build, que é parte do volume que degradou o agendador.
    if (JSON.stringify(unidos) === JSON.stringify(itensRemoto)) {
      console.log(`[RECONCILIAR] ${nome}: sem mudança em relação ao remoto — mantido.`);
      continue;
    }

    fs.writeFileSync(nome, JSON.stringify(
      { geradoEm: new Date().toISOString(), items: unidos }, null, 2
    ));
    console.log(
      `[RECONCILIAR] ${nome}: ${itensJob.length} da coleta + ${itensRemoto.length} do remoto `
      + `→ ${unidos.length} (descartados por rejeição/aprovação: ${excluir.size ? 'sim' : 'não'}).`
    );
  }

  for (const nome of UNIR_LISTA_IDS) {
    const doJob = path.join(origem, nome);
    if (!fs.existsSync(doJob)) continue;

    const idsJob    = (lerJson(doJob, []) || []).map(String);
    const idsRemoto = (lerJson(nome,  []) || []).map(String);
    // Remoto primeiro: o fim da lista tem que ser o mais recente, que é o que
    // o slice(-N) preserva.
    const unidos = [...new Set([...idsRemoto, ...idsJob])].slice(-MAX_IDS_PROCESSADOS);
    if (JSON.stringify(unidos) === JSON.stringify(idsRemoto)) {
      console.log(`[RECONCILIAR] ${nome}: sem ID novo — mantido.`);
      continue;
    }
    fs.writeFileSync(nome, JSON.stringify(unidos, null, 2));
    console.log(
      `[RECONCILIAR] ${nome}: ${idsJob.length} da coleta ∪ ${idsRemoto.length} do remoto → ${unidos.length} IDs.`
    );
  }
}

main();
