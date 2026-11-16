// Prepara (e opcionalmente reenvia) a revisão da App Store dos apps do Clube do
// Viajante e do Team Rausch pela API do App Store Connect, sem abrir o site.
// Roda no workflow loja-revisao.yml.
//
// Faz, para cada app pedido:
//   1. acha a versão 1.0 que ainda não está à venda;
//   2. troca o build da versão pelo número pedido (e marca a criptografia
//      isenta, se o build ainda não tiver essa resposta);
//   3. grava em "Informações da revisão do app" a conta de demonstração e as
//      Notas (com o link do vídeo, quando informado);
//   4. com ENVIAR=true, reenvia a revisão (submissão com problemas não resolvidos
//      ou uma submissão nova).
//
// O código da conta de revisão NÃO fica aqui (repo público): vem do proxy
// (GET /revisao/credenciais-lojas, chave CDV_OP_KEY) e é mascarado no log.
//
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, CDV_OP_KEY, APPS (cdv|teamrausch|ambos),
//      BUILD_CDV, BUILD_TR, VIDEO_CDV, VIDEO_TR, ENVIAR (true|false).

import crypto from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com';
const PROXY = 'https://cdv-proxy-production.up.railway.app';

const APPS = {
  cdv: { id: '6832521696', nome: 'Clube do Viajante' },
  teamrausch: { id: '6833047244', nome: 'Team Rausch' },
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jwt() {
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: agora, exp: agora + 15 * 60, aud: 'appstoreconnect-v1' }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${corpo}`), {
    key: process.env.ASC_KEY_P8,
    dsaEncoding: 'ieee-p1363',
  });
  return `${cab}.${corpo}.${b64url(assinatura)}`;
}

async function asc(metodo, caminho, corpo) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const erros = (json && json.errors || []).map((e) => `${e.title}: ${e.detail}${e.meta && e.meta.associatedErrors ? ' → ' + JSON.stringify(e.meta.associatedErrors) : ''}`).join(' | ') || texto.slice(0, 300);
    throw new Error(`${metodo} ${caminho} → HTTP ${r.status}: ${erros}`);
  }
  return json;
}

function notasCdv(c, video) {
  return `Hello App Review team, thank you for the feedback.

1. SCREEN RECORDING
${video || '[screen recording link]'}
Recorded on a physical iPhone with the latest iOS. It shows app launch, login with a one-time code, the main features, and account deletion.

2. PURPOSE AND AUDIENCE
Clube do Viajante (CDV) is a Brazilian education community that teaches people to earn and use airline miles and credit card points to travel for less. The app is the members' panel: it compares the value of points across loyalty programs, alerts members to bonus transfers and point purchase promotions, alerts them to award flights, and includes a personal miles management tool. The audience is adult travelers in Brazil. The app is in Portuguese.

3. DEMO ACCOUNT
The app has no password. Members sign in with their email and a 6-digit code sent by email. For review:
Email: ${c.usuario}
Code: ${c.codigo} (fixed for this account, no inbox needed)
The features are in the bottom bar and in the "Mais" menu.

4. ACCOUNTS, PAYMENTS AND DELETION
Accounts are not created in the app. Access comes with a membership bought outside the app on Hubla, a Brazilian membership platform. The app has no sign-up, no purchases, no prices and no links to buy.
Account deletion: "Mais" menu > "Minha conta" > "Excluir minha conta". After confirmation, the member's data and access are deleted immediately. Billing for the membership is managed on Hubla.

5. EXTERNAL SERVICES
Hubla (membership/access), Railway (backend hosting), GitHub (data storage), Resend (login code email), Anthropic Claude (server-side AI for writing offer texts), Apple Push Notification service.

6. REGIONS
The app works the same in all regions. Its content is about Brazilian loyalty programs, in Portuguese.

7. REGULATED INDUSTRY
Not applicable. The app is educational. It does not sell flights, miles or financial products.`;
}

function notasTr(c, video) {
  return `Hello App Review team, thank you for the feedback.

1. SCREEN RECORDING
${video || '[screen recording link]'}
Recorded on a physical iPhone with the latest iOS. It shows app launch, login with a one-time code, the main features, and account deletion.

2. PURPOSE AND AUDIENCE
Team Rausch is a strength training studio in Belo Horizonte, Brazil. The app is the official app for its students: they book and change classes, manage their fixed weekly schedule, follow their attendance and achievements, and receive studio notices. The audience is the studio's adult students. The app is in Portuguese.

3. DEMO ACCOUNT
The app has no password. Users sign in with their phone number and a 6-digit code. For review:
Phone: ${c.usuario}
Code: ${c.codigo} (fixed for this number, nothing is sent)
Main tabs: Agendar, Meus horários, Meus dados.

4. ACCOUNTS AND DELETION
Students create their own account in the app with their phone number. The app has no in-app purchases.
Account deletion: "Meus dados" > "Minha conta" > "Excluir minha conta". After confirmation, the account, its connected devices and future bookings are deleted immediately.

5. EXTERNAL SERVICES
Railway (backend hosting), WhatsApp (login codes and studio notices), Wellhub (corporate wellness partner some students use to check in), Resend (email notices to the studio), Apple Push Notification service.

6. REGIONS
The app works the same in all regions. It serves the studio's students in Brazil and is in Portuguese.

7. REGULATED INDUSTRY
Not applicable.`;
}

async function credenciais() {
  const r = await fetch(`${PROXY}/revisao/credenciais-lojas`, { headers: { 'X-CDV-Op': process.env.CDV_OP_KEY || '' } });
  if (!r.ok) throw new Error(`proxy /revisao/credenciais-lojas → HTTP ${r.status}`);
  const j = await r.json();
  for (const k of ['cdv', 'teamrausch']) {
    if (j[k] && j[k].codigo) console.log(`::add-mask::${j[k].codigo}`);
  }
  return j;
}

async function prepararApp(chave, cred, numeroBuild, video, enviar) {
  const app = APPS[chave];
  console.log(`\n=== ${app.nome} ===`);
  if (!cred || !cred.usuario || !cred.codigo) throw new Error('conta de revisão não configurada no proxy');

  // 1. versão em aberto
  const vs = await asc('GET', `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`);
  const versao = (vs.data || []).find((v) => !['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE'].includes(v.attributes.appStoreState));
  if (!versao) throw new Error('nenhuma versão em aberto');
  console.log(`versão ${versao.attributes.versionString} · estado ${versao.attributes.appStoreState}`);

  // 2. build
  if (numeroBuild) {
    const bs = await asc('GET', `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(numeroBuild)}&limit=5`);
    const build = (bs.data || [])[0];
    if (!build) throw new Error(`build ${numeroBuild} não encontrado (ainda processando no TestFlight?)`);
    console.log(`build ${numeroBuild} · ${build.attributes.processingState}`);
    if (build.attributes.processingState !== 'VALID') throw new Error(`build ${numeroBuild} ainda não está pronto (${build.attributes.processingState})`);
    if (build.attributes.usesNonExemptEncryption == null) {
      await asc('PATCH', `/v1/builds/${build.id}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } });
      console.log('criptografia: marcada como isenta');
    }
    await asc('PATCH', `/v1/appStoreVersions/${versao.id}`, {
      data: { type: 'appStoreVersions', id: versao.id, relationships: { build: { data: { type: 'builds', id: build.id } } } },
    });
    console.log(`build ${numeroBuild} vinculado à versão`);
  }

  // 3. informações da revisão
  const atributos = {
    demoAccountRequired: true,
    demoAccountName: cred.usuario,
    demoAccountPassword: cred.codigo,
    notes: chave === 'cdv' ? notasCdv(cred, video) : notasTr(cred, video),
  };
  let detalhe = null;
  try {
    detalhe = (await asc('GET', `/v1/appStoreVersions/${versao.id}/appStoreReviewDetail`)).data;
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
  }
  if (detalhe && detalhe.id) {
    await asc('PATCH', `/v1/appStoreReviewDetails/${detalhe.id}`, { data: { type: 'appStoreReviewDetails', id: detalhe.id, attributes: atributos } });
  } else {
    await asc('POST', '/v1/appStoreReviewDetails', {
      data: { type: 'appStoreReviewDetails', attributes: atributos, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } } },
    });
  }
  console.log(`Notas e conta de demonstração gravadas${video ? ' (com vídeo)' : ' (SEM link do vídeo)'}`);

  // 4. reenviar
  if (!enviar) { console.log('reenvio: não pedido'); return; }
  if (!video) throw new Error('reenvio recusado: falta o link do vídeo que a Apple pediu');
  const subs = await asc('GET', `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&limit=10`);
  const aberta = (subs.data || []).find((s) => ['UNRESOLVED_ISSUES', 'READY_FOR_REVIEW'].includes(s.attributes.state));
  if (aberta) {
    await asc('PATCH', `/v1/reviewSubmissions/${aberta.id}`, { data: { type: 'reviewSubmissions', id: aberta.id, attributes: { submitted: true } } });
    console.log(`reenviado para revisão (submissão ${aberta.attributes.state})`);
  } else {
    const nova = await asc('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } },
    });
    await asc('POST', '/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: nova.data.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } } },
    });
    await asc('PATCH', `/v1/reviewSubmissions/${nova.data.id}`, { data: { type: 'reviewSubmissions', id: nova.data.id, attributes: { submitted: true } } });
    console.log('enviado para revisão (submissão nova)');
  }
}

async function main() {
  for (const k of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8', 'CDV_OP_KEY']) {
    if (!process.env[k]) throw new Error(`falta o secret ${k}`);
  }
  const escolha = (process.env.APPS || 'ambos').trim();
  const lista = escolha === 'ambos' ? ['cdv', 'teamrausch'] : [escolha];
  const enviar = String(process.env.ENVIAR || '').toLowerCase() === 'true';
  const cred = await credenciais();
  let falhou = false;
  for (const chave of lista) {
    if (!APPS[chave]) throw new Error(`app desconhecido: ${chave}`);
    const build = chave === 'cdv' ? process.env.BUILD_CDV : process.env.BUILD_TR;
    const video = ((chave === 'cdv' ? process.env.VIDEO_CDV : process.env.VIDEO_TR) || '').trim();
    try {
      await prepararApp(chave, cred[chave], (build || '').trim(), video, enviar);
    } catch (e) {
      falhou = true;
      console.error(`ERRO (${APPS[chave].nome}): ${e.message}`);
    }
  }
  if (falhou) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
