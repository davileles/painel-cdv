/**
 * Alunos CDV → Google Contatos  (painel-cdv/google-contatos/Codigo.gs, desde 13/11/2026)
 *
 * Roda na conta Google do Davi (script.google.com). Lê a lista de alunos do proxy
 * do CDV (GET /hubla/contatos) e deixa o nome de cada um como
 *     "<Nome> <SIGLA> <dd/mm/aa>"      ex.: "William Camargo CDV 16/09/27"
 * - acha o contato pelo telefone (DDD + 8 últimos dígitos) ou pelo e-mail;
 * - contato que já existe: troca só o fim do nome (sigla + data) e mantém o nome
 *   que você deu a ele;
 * - aluno que não está na agenda: cria o contato (nome, telefone, e-mail);
 * - marca cada aluno com "Alunos CDV · Ativos" ou "Alunos CDV · Vencidos";
 * - nunca apaga contato e nunca mexe em quem não é aluno.
 *
 * Funções (escolha no menu de cima e clique em Executar):
 *   ensaio()             mostra o que mudaria, sem mudar nada (relatório no gestor)
 *   sincronizarAgora()   aplica as mudanças
 *   ligarAutomatico()    passa a rodar sozinho a cada 6 horas
 *   desligarAutomatico() para de rodar sozinho
 *
 * Configuração (uma vez): Configurações do projeto → Propriedades do script →
 * CDV_OP_KEY = a chave de operador do gestor (a mesma CAMPANHAS_KEY do Railway).
 * Serviços → + → "Google People API" (identificador People).
 */

const PROXY = 'https://cdv-proxy-production.up.railway.app';
const MARCADOR_ATIVOS = 'Alunos CDV · Ativos';
const MARCADOR_VENCIDOS = 'Alunos CDV · Vencidos';
const LOTE = 100;              // contatos por chamada de gravação
const PAUSA_MS = 1500;         // entre gravações (limite da API do Google)
const TEMPO_MAX_MS = 5 * 60 * 1000; // o Apps Script corta em 6 min

function ensaio() { return rodar_('ensaio'); }
function sincronizarAgora() { return rodar_('valendo'); }

function ligarAutomatico() {
  desligarAutomatico();
  ScriptApp.newTrigger('sincronizarAgora').timeBased().everyHours(6).create();
  Logger.log('Ligado: roda sozinho a cada 6 horas.');
}
function desligarAutomatico() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizarAgora')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ───────────────────────────────────────────────────────────────────────────

function rodar_(modo) {
  const t0 = Date.now();
  const inicio = new Date().toISOString();
  const chave = PropertiesService.getScriptProperties().getProperty('CDV_OP_KEY');
  if (!chave) throw new Error('Falta a propriedade CDV_OP_KEY (Configurações do projeto → Propriedades do script).');

  const r = UrlFetchApp.fetch(PROXY + '/hubla/contatos', { headers: { 'X-CDV-Op': chave }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Proxy respondeu ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  const dados = JSON.parse(r.getContentText());
  const reSufixo = new RegExp(dados.padraoSufixo);

  // 1. Agenda inteira
  const pessoas = [];
  let pageToken;
  do {
    const resp = People.People.Connections.list('people/me', {
      personFields: 'names,phoneNumbers,emailAddresses,memberships', pageSize: 1000, pageToken: pageToken,
    });
    (resp.connections || []).forEach(p => pessoas.push(p));
    pageToken = resp.nextPageToken;
  } while (pageToken);

  const porTel = {}, porEmail = {};
  pessoas.forEach(p => {
    (p.phoneNumbers || []).forEach(n => { const k = chaveTelefone_(n.canonicalForm || n.value); if (k) (porTel[k] = porTel[k] || []).push(p); });
    (p.emailAddresses || []).forEach(e => { const k = String(e.value || '').toLowerCase().trim(); if (k) (porEmail[k] = porEmail[k] || []).push(p); });
  });

  // 2. O que muda
  const atualizar = [], criar = [], erros = [];
  const usados = {};
  const rotulo = {}; // resourceName → 'ativos' | 'vencidos'
  let iguais = 0, conflitos = 0;
  dados.contatos.forEach(al => {
    const achados = {};
    (al.chavesTelefone || []).forEach(k => (porTel[k] || []).forEach(p => { achados[p.resourceName] = p; }));
    (al.emails || []).forEach(e => (porEmail[e] || []).forEach(p => { achados[p.resourceName] = p; }));
    const lista = Object.keys(achados).map(k => achados[k]);
    if (!lista.length) {
      criar.push({ nome: al.nomeContato, telefones: al.telefones, emails: al.emails, ativo: al.ativo });
      return;
    }
    lista.forEach(p => {
      if (usados[p.resourceName]) { conflitos++; erros.push({ tipo: 'conflito', contato: nomeDe_(p), aluno: al.nomeContato, outro: usados[p.resourceName] }); return; }
      usados[p.resourceName] = al.nomeContato;
      rotulo[p.resourceName] = al.ativo ? 'ativos' : 'vencidos';
      const atual = nomeDe_(p);
      const base = atual.replace(reSufixo, '').trim() || al.nome;
      const novo = (base + ' ' + al.sufixo).trim();
      if (novo === atual) { iguais++; return; }
      atualizar.push({ rn: p.resourceName, etag: p.etag, de: atual, para: novo });
    });
  });

  const totais = { alunos: dados.contatos.length, contatosNaAgenda: pessoas.length,
    atualizar: atualizar.length, criar: criar.length, iguais: iguais, conflitos: conflitos };
  let completo = true;

  // 3. Grava (só no modo valendo)
  if (modo === 'valendo') {
    let feitosAt = 0, feitosCr = 0;
    for (let i = 0; i < atualizar.length; i += LOTE) {
      if (Date.now() - t0 > TEMPO_MAX_MS) { completo = false; break; }
      const contatos = {};
      atualizar.slice(i, i + LOTE).forEach(a => { contatos[a.rn] = { etag: a.etag, names: [{ givenName: a.para }] }; });
      try {
        People.People.batchUpdateContacts({ contacts: contatos, updateMask: 'names', readMask: 'names' });
        feitosAt += Object.keys(contatos).length;
      } catch (e) { erros.push({ tipo: 'atualizar', lote: i, erro: String(e.message || e).slice(0, 300) }); }
      Utilities.sleep(PAUSA_MS);
    }
    for (let i = 0; i < criar.length; i += LOTE) {
      if (Date.now() - t0 > TEMPO_MAX_MS) { completo = false; break; }
      const lote = criar.slice(i, i + LOTE);
      try {
        const resp = People.People.batchCreateContacts({
          contacts: lote.map(c => ({ contactPerson: {
            names: [{ givenName: c.nome }],
            phoneNumbers: (c.telefones || []).map(t => ({ value: '+' + comDdi_(t) })),
            emailAddresses: (c.emails || []).map(e => ({ value: e })),
          } })),
          readMask: 'names',
        });
        (resp.createdPeople || []).forEach((cp, j) => {
          if (cp.person && cp.person.resourceName) rotulo[cp.person.resourceName] = lote[j].ativo ? 'ativos' : 'vencidos';
        });
        feitosCr += lote.length;
      } catch (e) { erros.push({ tipo: 'criar', lote: i, erro: String(e.message || e).slice(0, 300) }); }
      Utilities.sleep(PAUSA_MS);
    }
    try { aplicarMarcadores_(rotulo, pessoas); } catch (e) { erros.push({ tipo: 'marcadores', erro: String(e.message || e).slice(0, 300) }); }
    totais.atualizados = feitosAt;
    totais.criados = feitosCr;
  }

  // 4. Relatório (aparece no gestor → Assinaturas → Google Contatos)
  const relatorio = { modo: modo, inicio: inicio, fim: new Date().toISOString(), completo: completo, totais: totais,
    atualizar: atualizar.map(a => ({ de: a.de, para: a.para })),
    criar: criar.map(c => ({ nome: c.nome, telefone: (c.telefones || [])[0] || '', email: (c.emails || [])[0] || '' })),
    erros: erros };
  UrlFetchApp.fetch(PROXY + '/hubla/contatos/relatorio', {
    method: 'post', contentType: 'application/json', headers: { 'X-CDV-Op': chave },
    payload: JSON.stringify(relatorio), muteHttpExceptions: true,
  });

  Logger.log((modo === 'ensaio' ? 'ENSAIO (nada foi mudado). ' : '') + JSON.stringify(totais));
  atualizar.slice(0, 30).forEach(a => Logger.log('  ' + a.de + '  →  ' + a.para));
  if (criar.length) Logger.log('Novos contatos: ' + criar.slice(0, 30).map(c => c.nome).join(', ') + (criar.length > 30 ? '…' : ''));
  if (!completo) Logger.log('Parou no limite de tempo; a próxima rodada continua do ponto em que está.');
  return totais;
}

function aplicarMarcadores_(rotulo, pessoas) {
  const grupos = People.ContactGroups.list({ pageSize: 1000 }).contactGroups || [];
  const achar = nome => {
    const g = grupos.find(x => x.name === nome);
    return g ? g.resourceName : People.ContactGroups.create({ contactGroup: { name: nome } }).resourceName;
  };
  const gA = achar(MARCADOR_ATIVOS), gV = achar(MARCADOR_VENCIDOS);
  const em = {}; // resourceName → Set de grupos atuais
  pessoas.forEach(p => { em[p.resourceName] = (p.memberships || []).map(m => m.contactGroupMembership && m.contactGroupMembership.contactGroupResourceName).filter(Boolean); });
  const addA = [], addV = [], remA = [], remV = [];
  Object.keys(rotulo).forEach(rn => {
    const atuais = em[rn] || [];
    if (rotulo[rn] === 'ativos') { if (atuais.indexOf(gA) < 0) addA.push(rn); if (atuais.indexOf(gV) >= 0) remV.push(rn); }
    else { if (atuais.indexOf(gV) < 0) addV.push(rn); if (atuais.indexOf(gA) >= 0) remA.push(rn); }
  });
  const modificar = (g, add, rem) => {
    for (let i = 0; i < Math.max(add.length, rem.length); i += 500) {
      const body = { resourceNamesToAdd: add.slice(i, i + 500), resourceNamesToRemove: rem.slice(i, i + 500) };
      if (!body.resourceNamesToAdd.length && !body.resourceNamesToRemove.length) continue;
      People.ContactGroups.Members.modify(body, g);
      Utilities.sleep(PAUSA_MS);
    }
  };
  modificar(gA, addA, remA);
  modificar(gV, addV, remV);
}

function nomeDe_(p) {
  const n = (p.names || [])[0];
  if (!n) return '';
  return n.displayName || [n.givenName, n.middleName, n.familyName].filter(Boolean).join(' ');
}
// Mesmo cruzamento do proxy: DDI 55 + DDD + 8 últimos dígitos.
function chaveTelefone_(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.indexOf('55') === 0 && (d.length === 12 || d.length === 13)) return d.slice(0, 4) + d.slice(-8);
  if (d.length === 10 || d.length === 11) return '55' + d.slice(0, 2) + d.slice(-8);
  return d;
}
function comDdi_(t) {
  const d = String(t || '').replace(/\D/g, '');
  return (d.length === 10 || d.length === 11) ? '55' + d : d;
}
