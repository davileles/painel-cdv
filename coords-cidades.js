#!/usr/bin/env node
// coords-cidades.js — resolve automaticamente lat/lon das cidades novas do
// Mapa de Emissões.
//
// Por que existe: o mapa (index.html) só desenha cidades que tenham coordenada.
// Antes havia apenas a lista fixa MAPA_COORDS e toda cidade nova (Helsinki,
// Bangcoc, Mendoza...) fazia a emissão sumir do mapa em silêncio — 431 de
// 4.944 em out/2026. Agora este script roda a cada mudança em passagens.json
// (workflow coords-cidades.yml), encontra os nomes sem coordenada e grava em
// cidades-coords.json, que o painel mescla em MAPA_COORDS ao abrir o mapa.
//
// Resolução: Claude (mesma ANTHROPIC_API_KEY já usada nos coletores), em lote,
// só para os nomes que faltam. Sem nada faltando, não chama API nenhuma.
// Nome que não é lugar (lixo, typo irreconhecível) vai para naoResolvidas e
// só é tentado de novo depois de 7 dias.
//
// Formato de cidades-coords.json:
//   { atualizadoEm, cidades: { "<chave normalizada>": [nomeExibido, lat, lon, brasil] },
//     naoResolvidas: { "<chave>": "<data ISO da tentativa>" } }
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ARQ = path.join(DIR, 'cidades-coords.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const RETENTAR_DIAS = 7;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function lerJSON(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return padrao; }
}

// Coordenadas embutidas no index.html (MAPA_COORDS): chave → nome exibido.
function coordsEmbutidas() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const ini = html.indexOf('const MAPA_COORDS = {');
  if (ini < 0) throw new Error('MAPA_COORDS não encontrado no index.html');
  const bloco = html.slice(ini, html.indexOf('};', ini));
  const mapa = {};
  for (const m of bloco.matchAll(/'([^']+)':\['([^']+)',/g)) mapa[m[1]] = m[2];
  return mapa;
}

// Todos os nomes de cidade presentes em passagens.json (origem e destino).
function nomesDasPassagens() {
  const j = lerJSON(path.join(DIR, 'passagens.json'), { items: [] });
  const nomes = new Map(); // chave normalizada → nome original mais frequente
  for (const it of j.items || []) {
    for (const n of [it.origem, it.destino]) {
      const k = norm(n);
      if (k && !nomes.has(k)) nomes.set(k, String(n).trim());
    }
  }
  return nomes;
}

async function perguntarClaude(nomes, exibidos) {
  const prompt =
    'Você recebe nomes de cidades/aeroportos usados num site brasileiro de passagens com milhas. ' +
    'Alguns podem ser códigos IATA (ex.: "VVI"), grafias em inglês ou português, ilhas ou destinos turísticos.\n' +
    'Para cada nome, devolva a localização da cidade (centro da cidade ou do aeroporto principal).\n' +
    'Campo "exibicao": o nome usual em português do Brasil. Se o lugar for o MESMO de um destes nomes já usados no mapa, ' +
    'use exatamente o nome da lista (ex.: "Bangcoc" → "Bangkok" se "Bangkok" estiver na lista):\n' +
    JSON.stringify(exibidos) + '\n' +
    'Campo "brasil": true se fica no Brasil.\n' +
    'Se o nome não for um lugar identificável, devolva lat e lon null.\n' +
    'Retorne SOMENTE um JSON válido, sem markdown: um array na mesma ordem, cada item ' +
    '{"nome": <nome recebido>, "exibicao": string, "lat": número, "lon": número, "brasil": boolean}.\n\n' +
    'NOMES:\n' + JSON.stringify(nomes);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `Anthropic HTTP ${r.status}`);
  const bloco = (data.content || []).find(b => b.type === 'text');
  if (!bloco) throw new Error('Sem resposta da IA');
  const arr = JSON.parse(bloco.text.replace(/```json|```/g, '').trim());
  if (!Array.isArray(arr)) throw new Error('A IA não devolveu um array');
  return arr;
}

async function main() {
  const embutidas = coordsEmbutidas();
  const estado = lerJSON(ARQ, {});
  estado.cidades = estado.cidades || {};
  estado.naoResolvidas = estado.naoResolvidas || {};

  const limite = new Date(Date.now() - RETENTAR_DIAS * 864e5).toISOString();
  const faltando = [];
  for (const [k, nome] of nomesDasPassagens()) {
    if (embutidas[k] || estado.cidades[k]) continue;
    if (estado.naoResolvidas[k] && estado.naoResolvidas[k] > limite) continue;
    faltando.push([k, nome]);
  }
  if (!faltando.length) { console.log('✓ Todas as cidades de passagens.json já têm coordenada.'); return; }
  console.log(`${faltando.length} cidade(s) sem coordenada:`, faltando.map(f => f[1]).join(', '));
  if (!ANTHROPIC_API_KEY) { console.error('::error::ANTHROPIC_API_KEY ausente — não dá para resolver.'); process.exit(1); }

  const exibidos = [...new Set([...Object.values(embutidas), ...Object.values(estado.cidades).map(v => v[0])])].sort();
  let novas = 0;
  for (let i = 0; i < faltando.length; i += 40) {
    const lote = faltando.slice(i, i + 40);
    const resp = await perguntarClaude(lote.map(f => f[1]), exibidos);
    lote.forEach(([k, nome], idx) => {
      const r = resp.find(x => x && norm(x.nome) === k) || resp[idx] || {};
      const ok = typeof r.lat === 'number' && typeof r.lon === 'number'
        && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && r.exibicao;
      if (!ok) { estado.naoResolvidas[k] = new Date().toISOString(); console.warn(`  ✗ ${nome}: não identificado`); return; }
      estado.cidades[k] = [String(r.exibicao).trim(), Math.round(r.lat * 100) / 100, Math.round(r.lon * 100) / 100, !!r.brasil];
      delete estado.naoResolvidas[k];
      novas++;
      console.log(`  ✓ ${nome} → ${estado.cidades[k].join(', ')}`);
    });
  }
  estado.atualizadoEm = new Date().toISOString();
  // Chaves ordenadas: diff legível e estável.
  const ordenar = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
  fs.writeFileSync(ARQ, JSON.stringify({ atualizadoEm: estado.atualizadoEm, cidades: ordenar(estado.cidades), naoResolvidas: ordenar(estado.naoResolvidas) }, null, 1) + '\n');
  console.log(`✓ ${novas} coordenada(s) nova(s) gravada(s) em cidades-coords.json.`);
}

main().catch(e => { console.error('::error::' + e.message); process.exit(1); });
