/**
 * disparar-msgs-concierge.js
 * GitHub Action — roda de hora em hora
 * Verifica modelos "programados" do concierge e envia via Baileys
 * quando o horário calculado cair na janela atual (±30 min)
 */

const PROXY    = 'https://cdv-proxy-production.up.railway.app';
const BAILEYS  = 'https://baileys-server-production-ebfe.up.railway.app';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_RAW   = 'https://raw.githubusercontent.com/davileles/concierge/main';

// ── Helpers ──────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function getConciergeJSON(file) {
  const url = `${GH_RAW}/${file}?t=${Date.now()}`;
  const headers = GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub raw ${file} → ${res.status}`);
  return res.json();
}

// Resolve data de referência de uma reserva dado o gatilho
// Retorna Date (UTC) ou null
function resolverDataGatilho(reserva, viagens, gatilho) {
  switch (gatilho) {
    case 'voo_ida_dt': {
      if (!reserva.dataIda) return null;
      const hora = reserva.horaPartida || '00:00';
      return parseSP(`${reserva.dataIda}T${hora}`);
    }
    case 'voo_ida_d': {
      if (!reserva.dataIda) return null;
      const horaRef = '10:00'; // será sobrescrito pela horaRef do modelo
      return parseSP(`${reserva.dataIda}T${horaRef}`);
    }
    case 'voo_volta_dt': {
      if (!reserva.dataVolta) return null;
      const hora = reserva.horaPartidaVolta || '00:00';
      return parseSP(`${reserva.dataVolta}T${hora}`);
    }
    case 'voo_volta_d': {
      if (!reserva.dataVolta) return null;
      return parseSP(`${reserva.dataVolta}T10:00`);
    }
    case 'checkin': {
      if (!reserva.checkin) return null;
      return parseSP(`${reserva.checkin}T10:00`);
    }
    case 'viagem':
    case 'primeiro_voo_viagem': {
      // Achar viagem associada a esta reserva
      const viagem = (viagens || []).find(v =>
        (v.atividades || []).some(a => a.reservaId === reserva.id)
      );
      if (!viagem) return null;
      if (gatilho === 'viagem' && viagem.inicio) {
        return parseSP(`${viagem.inicio}T10:00`);
      }
      if (gatilho === 'primeiro_voo_viagem') {
        // Achar o voo com a menor dataIda da viagem
        // Precisa de todas as reservas da viagem
        return null; // calculado fora
      }
      return null;
    }
    default:
      return null;
  }
}

// Converte "YYYY-MM-DDTHH:mm" como horário de Brasília → Date UTC
function parseSP(dtLocal) {
  // SP = UTC-3 (sem DST no inverno). Usando offset fixo -3.
  const [datePart, timePart] = dtLocal.split('T');
  const [y, m, d]  = datePart.split('-').map(Number);
  const [hh, mm]   = (timePart || '00:00').split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + 3, mm)); // +3 para converter SP→UTC
}

// Subtrai antecedência (horas ou dias) de uma data
function subtrairAntecedencia(data, valor, unidade) {
  const ms = unidade === 'dias' ? valor * 24 * 60 * 60 * 1000 : valor * 60 * 60 * 1000;
  return new Date(data.getTime() - ms);
}

// Interpola variáveis {{chave}} no texto
function interpolar(texto, cli, res, viagens) {
  const rv = (t, k, v) => t.split(`{{${k}}}`).join(v || '');
  const fmtDate = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  };
  let t = texto;
  if (cli) {
    t = rv(t, 'nome',          cli.nome);
    t = rv(t, 'primeiro_nome', (cli.nome || '').split(' ')[0]);
    t = rv(t, 'telefone',      cli.tel);
    t = rv(t, 'email',         cli.email);
    t = rv(t, 'cpf',           cli.cpf);
    t = rv(t, 'cidade',        cli.cidade);
  }
  if (res) {
    t = rv(t, 'origem',              res.origem);
    t = rv(t, 'destino',             res.destino);
    t = rv(t, 'data_ida',            fmtDate(res.dataIda));
    t = rv(t, 'data_chegada_ida',    fmtDate(res.dataChegadaIda));
    t = rv(t, 'hora_partida',        res.horaPartida);
    t = rv(t, 'hora_chegada',        res.horaChegada);
    t = rv(t, 'nvoo_ida',            res.nvooIda || '');
    t = rv(t, 'cia',                 res.ciaIda || res.cia || '');
    t = rv(t, 'data_volta',          fmtDate(res.dataVolta));
    t = rv(t, 'data_chegada_volta',  fmtDate(res.dataChegadaVolta));
    t = rv(t, 'hora_partida_volta',  res.horaPartidaVolta || '');
    t = rv(t, 'hora_chegada_volta',  res.horaChegadaVolta || '');
    t = rv(t, 'nvoo_volta',          res.nvooVolta || '');
    t = rv(t, 'cia_volta',           res.ciaVolta || '');
    t = rv(t, 'origem_volta',        res.origemVolta || res.destino || '');
    t = rv(t, 'destino_volta',       res.destinoVolta || res.origem || '');
    t = rv(t, 'classe',              res.classe);
    t = rv(t, 'pnr',                 res.pnr);
    t = rv(t, 'programa',            res.programa);
    t = rv(t, 'milhas',              res.milhas);
    t = rv(t, 'pax',                 res.pax);
    t = rv(t, 'hotel',               res.hotelNome);
    t = rv(t, 'checkin',             fmtDate(res.checkin));
    t = rv(t, 'checkout',            fmtDate(res.checkout));
    t = rv(t, 'conf',                res.conf || res.hotelConf || '');
    const viagemAssoc = (viagens || []).find(v =>
      (v.atividades || []).some(a => a.reservaId === res.id)
    );
    t = rv(t, 'nome_viagem', viagemAssoc ? (viagemAssoc.nome || viagemAssoc.destino || '') : '');
  }
  return t;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🕐 ${new Date().toISOString()} — Verificando mensagens programadas...\n`);

  // 1. Carregar dados
  const [modelosRaw, reservasRaw, viagensRaw, cfgRaw] = await Promise.all([
    getConciergeJSON('modelos.json').catch(() => []),
    getConciergeJSON('reservas.json').catch(() => []),
    getConciergeJSON('viagens.json').catch(() => []),
    getConciergeJSON('cfg.json').catch(() => ({})),
  ]);

  const modelos  = Array.isArray(modelosRaw) ? modelosRaw : (modelosRaw.data || []);
  const reservas = Array.isArray(reservasRaw) ? reservasRaw : (reservasRaw.data || []);
  const viagens  = Array.isArray(viagensRaw)  ? viagensRaw  : (viagensRaw.data || []);
  const baileysUrl = cfgRaw.baileys
    ? `https://${cfgRaw.baileys.replace(/^https?:\/\//, '')}`
    : BAILEYS;

  // 2. Carregar clientes via proxy (membros da planilha)
  let clientes = [];
  try {
    const d = await fetchJSON(`${PROXY}/concierge/portal?email=_all_clientes_action`).catch(() => null);
    // Fallback: o proxy não tem endpoint all-clientes ainda — usar mapeamento a partir das reservas
    // Clientes serão identificados pelo campo res.cliente + res.grupo
  } catch(e) {}

  // 3. Carregar log de envios já realizados (evitar duplicatas)
  let enviosLog = [];
  try {
    enviosLog = await getConciergeJSON('msgs-enviadas.json');
    if (!Array.isArray(enviosLog)) enviosLog = [];
  } catch(e) { enviosLog = []; }

  const agora = new Date();
  const JANELA_MS = 30 * 60 * 1000; // ±30 min → janela total de 1h (frequência da action)

  // 4. Pré-calcular primeiro voo por viagem
  const primeiroVooPorViagem = {};
  for (const viagem of viagens) {
    const voosViagem = (viagem.atividades || [])
      .map(a => reservas.find(r => r.id === a.reservaId && r.tipo === 'voo'))
      .filter(Boolean)
      .filter(r => r.dataIda)
      .sort((a, b) => a.dataIda.localeCompare(b.dataIda));
    if (voosViagem.length) primeiroVooPorViagem[viagem.id] = voosViagem[0];
  }

  // 5. Modelos programados ativos
  const modelosProg = modelos.filter(m => m.modo === 'programado' && m.gatilho && m.antecedencia);
  console.log(`📋 ${modelos.length} modelos | ${modelosProg.length} programados | ${reservas.length} reservas\n`);

  const disparos = [];

  for (const modelo of modelosProg) {
    const { gatilho, antecedencia, horaRef } = modelo;
    const antVal  = antecedencia?.valor  || 0;
    const antUnit = antecedencia?.unidade || 'horas';

    for (const res of reservas) {
      // Calcular data de referência
      let dataRef = null;

      if (gatilho === 'primeiro_voo_viagem') {
        // Achar viagem que contém esta reserva
        const viagem = viagens.find(v =>
          (v.atividades || []).some(a => a.reservaId === res.id)
        );
        if (!viagem) continue;
        const primVoo = primeiroVooPorViagem[viagem.id];
        if (!primVoo) continue;
        const hora = primVoo.horaPartida || '00:00';
        dataRef = parseSP(`${primVoo.dataIda}T${hora}`);
      } else {
        // Para gatilhos com hora fixa (voo_ida_dt, voo_volta_dt) usa hora da reserva
        // Para os demais usa horaRef do modelo (padrão 10:00)
        const GATILHOS_COM_HORA = ['voo_ida_dt', 'voo_volta_dt', 'primeiro_voo_viagem'];
        let hrStr = GATILHOS_COM_HORA.includes(gatilho) ? null : (horaRef || '10:00');

        switch (gatilho) {
          case 'voo_ida_dt':
            if (!res.dataIda) continue;
            dataRef = parseSP(`${res.dataIda}T${res.horaPartida || '00:00'}`);
            break;
          case 'voo_ida_d':
            if (!res.dataIda) continue;
            dataRef = parseSP(`${res.dataIda}T${hrStr}`);
            break;
          case 'voo_volta_dt':
            if (!res.dataVolta) continue;
            dataRef = parseSP(`${res.dataVolta}T${res.horaPartidaVolta || '00:00'}`);
            break;
          case 'voo_volta_d':
            if (!res.dataVolta) continue;
            dataRef = parseSP(`${res.dataVolta}T${hrStr}`);
            break;
          case 'checkin':
            if (!res.checkin) continue;
            dataRef = parseSP(`${res.checkin}T${hrStr}`);
            break;
          case 'viagem': {
            const viagem = viagens.find(v =>
              (v.atividades || []).some(a => a.reservaId === res.id)
            );
            if (!viagem?.inicio) continue;
            dataRef = parseSP(`${viagem.inicio}T${hrStr}`);
            break;
          }
          default: continue;
        }
      }

      if (!dataRef) continue;

      // Momento ideal de envio = dataRef - antecedência
      const momentoEnvio = subtrairAntecedencia(dataRef, antVal, antUnit);

      // Está na janela?
      const diff = momentoEnvio.getTime() - agora.getTime();
      if (diff < -JANELA_MS || diff > JANELA_MS) continue;

      // Chave de deduplicação
      const chave = `${modelo.id}|${res.id}`;
      if (enviosLog.includes(chave)) {
        console.log(`⏭  Já enviado: ${chave}`);
        continue;
      }

      // Buscar grupo do cliente na reserva
      // O campo grupo está nos clientes (planilha). Tentamos via res.grupo ou cfg
      // Por ora, o cliente precisa ter o grupo salvo em algum lugar acessível.
      // Estratégia: o concierge salva grupo em cfg como parte do cliente? Não.
      // → Vamos usar endpoint /concierge/portal que aceita email para pegar grupo
      // → Mas não temos email aqui. Fallback: buscar por nome.
      let grupo = res.grupo || null;
      if (!grupo) {
        // Tentar buscar na planilha via proxy
        try {
          const pd = await fetchJSON(`${PROXY}/concierge/portal?nome=${encodeURIComponent(res.cliente)}`);
          grupo = pd?.grupo || null;
        } catch(e) {}
      }

      if (!grupo) {
        console.log(`⚠️  Sem grupo para "${res.cliente}" — modelo ${modelo.nome} / reserva ${res.id}`);
        continue;
      }

      // Interpolar texto
      // clientes da planilha: sem acesso direto aqui, passa cli=null e usa campos da reserva
      const texto = interpolar(modelo.texto, { nome: res.cliente }, res, viagens);

      disparos.push({ chave, grupo, texto, modelo: modelo.nome, cliente: res.cliente, res: res.id });
    }
  }

  if (!disparos.length) {
    console.log('✅ Nenhuma mensagem para enviar nesta janela.\n');
    return;
  }

  console.log(`🚀 ${disparos.length} mensagem(ns) para enviar:\n`);

  const novosEnvios = [...enviosLog];

  for (const d of disparos) {
    console.log(`  → ${d.cliente} | ${d.modelo} | grupo: ${d.grupo}`);
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
      console.log(`     ❌ Erro: ${e.message}`);
    }
    // Pausa entre envios para não sobrecarregar
    await new Promise(r => setTimeout(r, 2000));
  }

  // Salvar log atualizado via proxy
  if (novosEnvios.length !== enviosLog.length) {
    try {
      // Manter apenas últimos 500 registros
      const logTrimmed = novosEnvios.slice(-500);
      await fetch(`${PROXY}/concierge/msgs-enviadas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: logTrimmed }),
      });
      console.log(`\n💾 Log salvo (${logTrimmed.length} entradas).`);
    } catch(e) {
      console.log(`\n⚠️  Falha ao salvar log: ${e.message}`);
    }
  }

  console.log('\n✅ Concluído.\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
