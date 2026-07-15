/**
 * disparar-msgs-concierge.js
 * GitHub Action — roda de hora em hora
 * Verifica modelos "programados" do concierge e envia via Baileys
 * quando o momento ideal de envio cair na janela atual (±30 min)
 *
 * Pré-requisito: reservas devem ter campo `grupo` preenchido.
 * Use o botão "Atualizar grupo em todas as reservas" na aba Config
 * do concierge para fazer o backfill das reservas existentes.
 */

const BAILEYS_DEFAULT = 'https://baileys-server-production-ebfe.up.railway.app';
const GH_TOKEN        = process.env.GH_TOKEN;
const GH_RAW          = 'https://raw.githubusercontent.com/davileles/concierge/main';
const PROXY           = 'https://cdv-proxy-production.up.railway.app';

// ── Helpers ──────────────────────────────────────────────────────

async function getConciergeJSON(file) {
  const url = `${GH_RAW}/${file}?t=${Date.now()}`;
  const headers = GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub raw ${file} → ${res.status}`);
  return res.json();
}

// Converte "YYYY-MM-DDTHH:mm" como horário de Brasília → Date UTC
// SP usa UTC-3 o ano todo (sem DST nos meses de inverno relevantes)
function parseSP(dtLocal) {
  const [datePart, timePart = '00:00'] = dtLocal.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm]  = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + 3, mm));
}

function subtrairAntecedencia(data, valor, unidade) {
  const ms = unidade === 'dias' ? valor * 86400000 : valor * 3600000;
  return new Date(data.getTime() - ms);
}

function interpolar(texto, cli, res, viagens) {
  const rv  = (t, k, v) => t.split(`{{${k}}}`).join(v ?? '');
  const fmt = s => { if (!s) return ''; const [y,m,d] = s.split('-'); return `${d}/${m}/${y}`; };
  let t = texto;
  if (cli) {
    t = rv(t, 'nome',          cli.nome);
    t = rv(t, 'primeiro_nome', (cli.nome || '').split(' ')[0]);
    t = rv(t, 'telefone',      cli.tel   || '');
    t = rv(t, 'email',         cli.email || '');
    t = rv(t, 'cidade',        cli.cidade || '');
  }
  if (res) {
    t = rv(t, 'origem',             res.origem             || '');
    t = rv(t, 'destino',            res.destino            || '');
    t = rv(t, 'data_ida',           fmt(res.dataIda));
    t = rv(t, 'data_chegada_ida',   fmt(res.dataChegadaIda));
    t = rv(t, 'hora_partida',       res.horaPartida        || '');
    t = rv(t, 'hora_chegada',       res.horaChegada        || '');
    t = rv(t, 'nvoo_ida',           res.nvooIda            || '');
    t = rv(t, 'cia',                res.ciaIda || res.cia  || '');
    t = rv(t, 'data_volta',         fmt(res.dataVolta));
    t = rv(t, 'data_chegada_volta', fmt(res.dataChegadaVolta));
    t = rv(t, 'hora_partida_volta', res.horaPartidaVolta   || '');
    t = rv(t, 'hora_chegada_volta', res.horaChegadaVolta   || '');
    t = rv(t, 'nvoo_volta',         res.nvooVolta          || '');
    t = rv(t, 'cia_volta',          res.ciaVolta           || '');
    t = rv(t, 'origem_volta',       res.origemVolta  || res.destino || '');
    t = rv(t, 'destino_volta',      res.destinoVolta || res.origem  || '');
    t = rv(t, 'classe',             res.classe   || '');
    t = rv(t, 'pnr',                res.pnr      || '');
    t = rv(t, 'programa',           res.programa || '');
    t = rv(t, 'milhas',             res.milhas   || '');
    t = rv(t, 'pax',                res.pax      || '');
    t = rv(t, 'hotel',              res.hotelNome || '');
    t = rv(t, 'checkin',            fmt(res.checkin));
    t = rv(t, 'checkout',           fmt(res.checkout));
    t = rv(t, 'conf',               res.conf || res.hotelConf || '');
    const viagemAssoc = (viagens || []).find(v =>
      (v.atividades || []).some(a => a.reservaId === res.id)
    );
    t = rv(t, 'nome_viagem', viagemAssoc ? (viagemAssoc.nome || viagemAssoc.destino || '') : '');
  }
  return t;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const agora = new Date();
  console.log(`\n🕐 ${agora.toISOString()} — Verificando mensagens programadas...\n`);

  const [modelosRaw, reservasRaw, viagensRaw, cfgRaw, enviosLogRaw] = await Promise.all([
    getConciergeJSON('modelos.json').catch(() => []),
    getConciergeJSON('reservas.json').catch(() => []),
    getConciergeJSON('viagens.json').catch(() => []),
    getConciergeJSON('cfg.json').catch(() => ({})),
    getConciergeJSON('msgs-enviadas.json').catch(() => []),
  ]);

  const modelos   = Array.isArray(modelosRaw)   ? modelosRaw   : (modelosRaw.data   || []);
  const reservas  = Array.isArray(reservasRaw)  ? reservasRaw  : (reservasRaw.data  || []);
  const viagens   = Array.isArray(viagensRaw)   ? viagensRaw   : (viagensRaw.data   || []);
  const enviosLog = Array.isArray(enviosLogRaw) ? enviosLogRaw : [];
  const baileysUrl = cfgRaw.baileys
    ? `https://${cfgRaw.baileys.replace(/^https?:\/\//, '')}`
    : BAILEYS_DEFAULT;

  const modelosProg = modelos.filter(m => m.modo === 'programado' && m.gatilho && m.antecedencia);
  console.log(`📋 ${modelos.length} modelos (${modelosProg.length} programados) | ${reservas.length} reservas\n`);

  if (!modelosProg.length) { console.log('Nenhum modelo programado configurado.\n'); return; }

  // Pré-calcular primeiro voo de cada viagem (para gatilho primeiro_voo_viagem)
  const primeiroVooPorViagem = {};
  for (const viagem of viagens) {
    const voos = (viagem.atividades || [])
      .map(a => reservas.find(r => r.id === a.reservaId && r.tipo === 'voo' && r.dataIda))
      .filter(Boolean)
      .sort((a, b) => a.dataIda.localeCompare(b.dataIda));
    if (voos.length) primeiroVooPorViagem[viagem.id] = voos[0];
  }

  const JANELA_MS = 30 * 60 * 1000; // ±30 min
  const disparos  = [];

  for (const modelo of modelosProg) {
    const { gatilho, antecedencia, horaRef } = modelo;
    const antVal  = antecedencia?.valor   || 0;
    const antUnit = antecedencia?.unidade || 'horas';
    const hrFix   = horaRef || '10:00'; // usado quando gatilho não carrega hora própria

    for (const res of reservas) {
      if (!res.grupo) continue; // sem grupo = não pode enviar

      let dataRef = null;

      switch (gatilho) {
        case 'voo_ida_dt':
          if (!res.dataIda) continue;
          dataRef = parseSP(`${res.dataIda}T${res.horaPartida || '00:00'}`);
          break;
        case 'voo_ida_d':
          if (!res.dataIda) continue;
          dataRef = parseSP(`${res.dataIda}T${hrFix}`);
          break;
        case 'voo_volta_dt':
          if (!res.dataVolta) continue;
          dataRef = parseSP(`${res.dataVolta}T${res.horaPartidaVolta || '00:00'}`);
          break;
        case 'voo_volta_d':
          if (!res.dataVolta) continue;
          dataRef = parseSP(`${res.dataVolta}T${hrFix}`);
          break;
        case 'checkin':
          if (!res.checkin) continue;
          dataRef = parseSP(`${res.checkin}T${hrFix}`);
          break;
        case 'viagem': {
          const v = viagens.find(v => (v.atividades || []).some(a => a.reservaId === res.id));
          if (!v?.inicio) continue;
          dataRef = parseSP(`${v.inicio}T${hrFix}`);
          break;
        }
        case 'primeiro_voo_viagem': {
          const v = viagens.find(v => (v.atividades || []).some(a => a.reservaId === res.id));
          if (!v) continue;
          const pv = primeiroVooPorViagem[v.id];
          if (!pv) continue;
          dataRef = parseSP(`${pv.dataIda}T${pv.horaPartida || '00:00'}`);
          break;
        }
        default: continue;
      }

      if (!dataRef) continue;

      const momentoEnvio = subtrairAntecedencia(dataRef, antVal, antUnit);
      const diff = momentoEnvio.getTime() - agora.getTime();

      if (diff < -JANELA_MS || diff > JANELA_MS) continue;

      const chave = `${modelo.id}|${res.id}`;
      if (enviosLog.includes(chave)) {
        console.log(`⏭  Já enviado: ${modelo.nome} → ${res.cliente} (${res.id})`);
        continue;
      }

      const texto = interpolar(modelo.texto, { nome: res.cliente }, res, viagens);
      disparos.push({ chave, grupo: res.grupo, texto, nomeModelo: modelo.nome, cliente: res.cliente });
    }
  }

  if (!disparos.length) {
    console.log('✅ Nenhuma mensagem na janela desta hora.\n');
    return;
  }

  console.log(`🚀 ${disparos.length} mensagem(ns) para enviar:\n`);
  const novosEnvios = [...enviosLog];

  for (const d of disparos) {
    console.log(`  → [${d.nomeModelo}] para ${d.cliente} (grupo: ${d.grupo})`);
    try {
      const r = await fetch(`${baileysUrl}/enviar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: d.grupo, mensagem: d.texto }),
      });
      const json = await r.json();
      if (json.ok || json.success) {
        console.log(`     ✅ Enviado!`);
        novosEnvios.push(d.chave);
      } else {
        console.log(`     ❌ Falha: ${json.erro || json.error || JSON.stringify(json)}`);
      }
    } catch(e) {
      console.log(`     ❌ Erro de rede: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Salvar log via proxy (mantém últimos 1000 registros)
  if (novosEnvios.length !== enviosLog.length) {
    const logTrimmed = novosEnvios.slice(-1000);
    try {
      const r = await fetch(`${PROXY}/concierge/msgs-enviadas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: logTrimmed }),
      });
      const j = await r.json();
      console.log(`\n💾 Log salvo (${logTrimmed.length} entradas): ${j.ok ? 'OK' : 'ERRO'}`);
    } catch(e) {
      console.log(`\n⚠️  Falha ao salvar log: ${e.message}`);
    }
  }

  console.log('\n✅ Concluído.\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
