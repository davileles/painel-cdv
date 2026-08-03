/**
 * passagens-datas.js — normalização dos campos datas_ida / datas_volta
 *
 * O campo é texto livre digitado/gerado em ~10 formatos diferentes ao longo do
 * tempo. Este módulo converte para datas ISO, marcando a PRECISÃO de cada uma:
 *
 *   'dia'       → data exata informada ("Ago/26: 15", "15-23 Junho", "2026-05-07")
 *   'mes'       → só o mês foi informado ("Junho", "Maio a Agosto"). Usa-se o dia
 *                 15 como representante e a análise pode filtrar por precisão.
 *   'intervalo' → resumo com data inicial e final ("47 datas entre 05/08 e 15/05")
 *
 * Nunca inventa datas diárias a partir de informação mensal — isso inflaria a
 * amostra e distorceria medianas e percentis.
 *
 * Usado por: index.js (POST /passagens/registrar), arquivar-passagens.js
 * e a análise de comportamento de disponibilidade.
 */

const MESES = {
  jan: 1, janeiro: 1,
  fev: 2, fevereiro: 2,
  mar: 3, marco: 3, 'março': 3,
  abr: 4, abril: 4,
  mai: 5, maio: 5,
  jun: 6, junho: 6,
  jul: 7, julho: 7,
  ago: 8, agosto: 8,
  set: 9, setembro: 9, sep: 9,
  out: 10, outubro: 10,
  nov: 11, novembro: 11,
  dez: 12, dezembro: 12,
};

// Comparados por igualdade contra o texto inteiro (sem acento, minúsculo).
// NUNCA usar substring solta aqui: '-' casaria com "16-26/11" e zeraria o registro.
const SEM_DISPONIBILIDADE = new Set([
  'nao encontrado', 'nao encontrada', 'nao encontrados', 'nao encontradas',
  'nao disponivel', 'nao disponiveis', 'indisponivel',
  'sem disponibilidade', 'sem datas', 'nenhuma', 'nenhum', 'n/a', 'na', '-', '--', '',
]);

// Texto que indica disponibilidade existente mas não quantificada
const INDETERMINADO = ['multiplas', 'multiplos', 'varias', 'varios', 'diversas'];

function semAcento(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function mesDe(nome) {
  const k = semAcento(nome).toLowerCase().trim();
  if (MESES[k] !== undefined) return MESES[k];
  return MESES[k.slice(0, 3)];
}

function anoDe(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return n < 100 ? 2000 + n : n;
}

function iso(ano, mes, dia) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  // rejeita overflow (31/02 vira 03/03)
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return d.toISOString().slice(0, 10);
}

/** Ano implícito: primeira ocorrência do mês igual ou posterior à referência. */
function anoImplicito(mes, ref) {
  const [ay, am] = [ref.getUTCFullYear(), ref.getUTCMonth() + 1];
  return mes >= am ? ay : ay + 1;
}

/** "01-04, 09, 10" ou "16-26" → [1,2,3,4,9,10] */
function expandirDias(txt) {
  const out = [];
  for (const parte of String(txt).split(/[,\s]+|\se\s/)) {
    const p = parte.trim();
    if (!p) continue;
    const faixa = p.match(/^(\d{1,2})\s*[-–a]\s*(\d{1,2})$/);
    if (faixa) {
      const [a, b] = [Number(faixa[1]), Number(faixa[2])];
      if (a <= b && b <= 31) for (let d = a; d <= b; d++) out.push(d);
    } else if (/^\d{1,2}$/.test(p)) {
      out.push(Number(p));
    }
  }
  return out;
}

/**
 * @param {string} texto   conteúdo de datas_ida / datas_volta
 * @param {string|Date} referencia  enviadoEm — usado para inferir ano omitido
 * @returns {{status:string, precisao:string|null, datas:string[]}}
 */
function normalizarDatas(texto, referencia) {
  const ref = referencia instanceof Date ? referencia : new Date(referencia);
  const vazio = { status: 'vazio', precisao: null, datas: [] };
  if (!texto || !String(texto).trim()) return vazio;

  const bruto = String(texto).trim();
  const plano = semAcento(bruto).toLowerCase();

  if (SEM_DISPONIBILIDADE.has(plano) || /^nao (encontr|dispon)/.test(plano)) {
    return { status: 'sem_disponibilidade', precisao: null, datas: [] };
  }

  const push = (set, v) => { if (v) set.add(v); };

  // ── 1. Datas ISO completas: "2026-05-07 00:00:00" ──────────────────────────
  {
    const s = new Set();
    for (const m of bruto.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
      push(s, iso(Number(m[1]), Number(m[2]), Number(m[3])));
    }
    if (s.size) return { status: 'ok', precisao: 'dia', datas: [...s].sort() };
  }

  // ── 2. Resumo com intervalo explícito (antes das regras de dia) ────────────
  //    "Ago/26 - Mai/27: 47 datas disponíveis entre 05/08/2026 e 15/05/2027"
  {
    const m = bruto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\D+?(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const a = iso(Number(m[3]), Number(m[2]), Number(m[1]));
      const b = iso(Number(m[6]), Number(m[5]), Number(m[4]));
      if (a && b) return { status: 'ok', precisao: 'intervalo', datas: [a, b] };
    }
  }

  // ── 3. "Mes[/ano]: dias" — cobre "Ago/26: 15, 20" e "Março: 03, 09-11" ─────
  {
    const s = new Set();
    const re = /([A-Za-zçÇ\u00C0-\u00FF]{3,10})\s*(?:\/\s*(\d{2,4}))?\s*:\s*([0-9][0-9,\s\-–]*)/g;
    for (const m of bruto.matchAll(re)) {
      const mes = mesDe(m[1]);
      if (!mes) continue;
      const ano = m[2] ? anoDe(m[2]) : anoImplicito(mes, ref);
      for (const d of expandirDias(m[3])) push(s, iso(ano, mes, d));
    }
    if (s.size) return { status: 'ok', precisao: 'dia', datas: [...s].sort() };
  }

  // ── 4. "dias de Mes [ano]" e "dias Mes" ────────────────────────────────────
  //    "18,19,20 e 21 de Junho" | "15-23 Junho" | "01-02,04,08-11 Dez"
  {
    const s = new Set();
    const DIA = '\\d{1,2}(?:\\s*[-–a]\\s*\\d{1,2})?';
    const LISTA = `${DIA}(?:\\s*(?:,|e)\\s*${DIA})*`;
    const re = new RegExp(`(${LISTA})\\s*(?:de\\s+)?([A-Za-zçÇ\u00C0-\u00FF]{3,10})\\s*(\\d{4})?`, 'g');
    for (const m of bruto.matchAll(re)) {
      const mes = mesDe(m[2]);
      if (!mes) continue;
      const ano = m[3] ? anoDe(m[3]) : anoImplicito(mes, ref);
      for (const d of expandirDias(m[1])) push(s, iso(ano, mes, d));
    }
    if (s.size) return { status: 'ok', precisao: 'dia', datas: [...s].sort() };
  }

  // ── 5. "dias/mm" separados por ; | ─────────────────────────────────────────
  //    "26,27/03;04,07/06" | "14, 22, 28-29, 31/07 | 01-03/08"
  {
    const s = new Set();
    for (const grupo of bruto.split(/[;|]/)) {
      const m = grupo.trim().match(/^([0-9][0-9,\s\-–]*)\s*\/\s*(\d{1,2})$/);
      if (!m) continue;
      const mes = Number(m[2]);
      if (mes < 1 || mes > 12) continue;
      const ano = anoImplicito(mes, ref);
      for (const d of expandirDias(m[1])) push(s, iso(ano, mes, d));
    }
    if (s.size) return { status: 'ok', precisao: 'dia', datas: [...s].sort() };
  }

  // ── 6. Varredura global de "dd/mm" e "dd-dd/mm" ────────────────────────────
  //    Cobre listas soltas por vírgula/quebra de linha, que a regra 5 não pega:
  //    "23/03, 26/03, 29/03" | "03-04/03, 06/03, 10-15/03" | "26/09, 10/10"
  {
    const s = new Set();
    for (const m of bruto.matchAll(/(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\s*\/\s*(\d{1,2})(?!\d|\s*\/)/g)) {
      const mes = Number(m[2]);
      if (mes < 1 || mes > 12) continue;
      const ano = anoImplicito(mes, ref);
      for (const d of expandirDias(m[1])) push(s, iso(ano, mes, d));
    }
    if (s.size) return { status: 'ok', precisao: 'dia', datas: [...s].sort() };
  }

  // ── 7. Meses sem dia ───────────────────────────────────────────────────────
  //    "Junho" | "Maio a Agosto" | "Mai-Jun" | "Abril/Maio/Junho"
  //    "Jun/2026 a Mai/2027" | "Jun/2026, Jul/2026, Ago/2026"
  {
    const achados = [];
    const re = /([A-Za-zçÇ\u00C0-\u00FF]{3,10})(?:\s*\/\s*(\d{2,4}))?/g;
    for (const m of bruto.matchAll(re)) {
      const mes = mesDe(m[1]);
      if (!mes) continue;
      achados.push({ mes, ano: m[2] ? anoDe(m[2]) : null });
    }
    if (achados.length) {
      const faixa = /\s(a|ate|-|–)\s/i.test(semAcento(bruto)) || /[A-Za-zç]-[A-Za-zç]/.test(bruto);
      const s = new Set();

      const resolver = (item, anterior) => {
        if (item.ano) return item.ano;
        if (anterior) {
          // sequência crescente; vira o ano quando o mês retrocede
          return item.mes >= anterior.mes ? anterior.ano : anterior.ano + 1;
        }
        return anoImplicito(item.mes, ref);
      };

      let anterior = null;
      const lista = achados.map((it) => {
        const ano = resolver(it, anterior);
        anterior = { mes: it.mes, ano };
        return { mes: it.mes, ano };
      });

      const alvos = [];
      if (faixa && lista.length >= 2) {
        // expande do primeiro ao último mês
        let { mes, ano } = lista[0];
        const fim = lista[lista.length - 1];
        for (let i = 0; i < 24; i++) {
          alvos.push({ mes, ano });
          if (mes === fim.mes && ano === fim.ano) break;
          mes++;
          if (mes > 12) { mes = 1; ano++; }
        }
      } else {
        alvos.push(...lista);
      }

      // dia 15 como representante do mês
      for (const a of alvos) push(s, iso(a.ano, a.mes, 15));
      if (s.size) return { status: 'ok', precisao: 'mes', datas: [...s].sort() };
    }
  }

  if (INDETERMINADO.some((t) => plano.includes(t))) {
    return { status: 'indeterminado', precisao: null, datas: [] };
  }

  return { status: 'nao_reconhecido', precisao: null, datas: [] };
}

module.exports = { normalizarDatas, MESES };

/**
 * Resumo compacto para persistir junto do registro.
 * O array completo de datas NÃO é gravado: em passagens.json ele triplicaria o
 * arquivo (1,17 MB → 3,48 MB). Como normalizarDatas() é determinístico, o array
 * é recomputado sob demanda; o resumo serve para consulta rápida e como guarda
 * contra mudança silenciosa do parser (se `n` divergir, o parser mudou).
 *
 * { n, min, max, ant_min, ant_max, p } — ~70 bytes por registro.
 */
function resumirDatas(texto, referencia) {
  const r = normalizarDatas(texto, referencia);
  if (r.status !== 'ok' || !r.datas.length) return { n: 0, st: r.status };
  const ref = referencia instanceof Date ? referencia : new Date(String(referencia).slice(0, 10));
  const dias = r.datas.map((d) => Math.round((new Date(d) - ref) / 86400000));
  return {
    n: r.datas.length,
    min: r.datas[0],
    max: r.datas[r.datas.length - 1],
    ant_min: Math.min(...dias),
    ant_max: Math.max(...dias),
    p: r.precisao,
  };
}

module.exports.resumirDatas = resumirDatas;
