/**
 * passagens-escopo.js — classifica uma rota como nacional ou internacional.
 *
 * Fonte: iata.js (já presente no repo), onde cada entrada tem o formato
 * "COD|Cidade – Aeroporto (País)". Extrai as cidades com país "Brazil".
 * O arquivo não exporta nada (é script de browser), então é lido via fs e
 * parseado por regex — evita duplicar a base de 4.949 cidades.
 *
 * Regra: nacional apenas quando origem E destino são brasileiras.
 * Cidade desconhecida é tratada como estrangeira — na base atual 59 das 61
 * cidades ausentes do iata.js são de fato estrangeiras (nomes em português:
 * Amsterdã, Nova York, Londres...). As duas brasileiras estão em EXCECOES_BR.
 */

const fs = require('fs');
const path = require('path');

function chave(v) {
  return String(v == null ? '' : v)
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Cidades brasileiras ausentes do iata.js ou grafadas de forma divergente
// na base de passagens (inclui erro de digitação já presente no histórico).
const EXCECOES_BR = new Set([
  'jericoacoara',
  'caxias do sul',
  'caixias do sul',   // grafia incorreta presente no backfill da planilha
]);

let CIDADES_BR = null;

function carregarCidadesBR() {
  if (CIDADES_BR) return CIDADES_BR;
  const br = new Set(EXCECOES_BR);
  try {
    const src = fs.readFileSync(path.join(__dirname, 'iata.js'), 'utf8');
    for (const m of src.matchAll(/"([A-Z]{3})\|([^|"]+?)\s+–\s+[^(]*\(([^)]+)\)"/g)) {
      if (m[3] === 'Brazil') br.add(chave(m[2]));
    }
  } catch (e) {
    console.warn(`[escopo] iata.js indisponivel: ${e.message} — usando apenas excecoes`);
  }
  CIDADES_BR = br;
  return br;
}

function ehBrasileira(cidade) {
  return carregarCidadesBR().has(chave(cidade));
}

/** @returns {'nacional'|'internacional'} */
function escopoRota(origem, destino) {
  return (ehBrasileira(origem) && ehBrasileira(destino)) ? 'nacional' : 'internacional';
}

module.exports = { escopoRota, ehBrasileira, chave };
