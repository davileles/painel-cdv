// ═══════════════════════════════════════════════════════════════════════════
// montar.mjs — gera app/www (o que vai dentro do app) a partir do painel.
//
// O app NÃO tem cópia própria do painel: a cada compilação ele pega o
// index.html e os arquivos ao lado dele em painel-cdv/ (raiz do repo) e:
//   • troca o Chart.js do CDN pela cópia local (funciona sem internet);
//   • faz o cidades-coords.json vir do site (é atualizado pelo Actions);
//   • põe viewport-fit=cover (o app desenha atrás da barra de status);
//   • injeta capacitor-plugins.js + nativo.js + nativo.css no <head>.
// Qualquer mudança no painel entra no app na próxima compilação.
//
// Uso: node montar.mjs   (rodado pelo workflow app-android.yml / app-ios.yml)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PAINEL = join(AQUI, '..');
const WWW = join(AQUI, 'www');
const SITE = 'https://painel.clubedoviajante.com.br';
const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
const VERSAO = process.env.VERSAO_APP || pkg.version;

function trocarUmaVez(texto, antigo, novo, nome) {
  const n = texto.split(antigo).length - 1;
  if (n !== 1) throw new Error(`montar: esperava 1 ocorrência de ${nome}, achei ${n}. O index.html mudou — ajuste montar.mjs.`);
  return texto.replace(antigo, () => novo);
}

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

// 1) Arquivos do painel usados pelo index.html
for (const arq of ['cdv-redesign.css', 'cdv-redesign.js', 'iata.js', 'logocdv.png', 'cidades-coords.json']) {
  const origem = join(PAINEL, arq);
  if (!existsSync(origem)) throw new Error(`montar: falta ${arq} no painel-cdv`);
  copyFileSync(origem, join(WWW, arq));
}

// 2) Chart.js local (mesma versão do CDN usado pelo painel)
copyFileSync(join(AQUI, 'node_modules/chart.js/dist/chart.umd.js'), join(WWW, 'chart.umd.min.js'));

// 3) Capacitor sem bundler: core + plugins em build IIFE, num arquivo só
const MODS = ['core/dist/capacitor.js', 'app', 'browser', 'share', 'status-bar', 'splash-screen', 'haptics', 'preferences']
  .map((m) => '@capacitor/' + (m.includes('/') ? m : `${m}/dist/plugin.js`));
// Plugins de terceiros (build IIFE em dist/plugin.js): Face ID/digital.
MODS.push('@capacitor/push-notifications/dist/plugin.js');
MODS.push('@capgo/capacitor-native-biometric/dist/plugin.js');
const bundle = MODS.map((m) => {
  const cod = readFileSync(join(AQUI, 'node_modules', m), 'utf8').replace(/\/\/# sourceMappingURL=.*$/gm, '');
  return `/* ── ${m} ── */\n${cod}`;
}).join('\n;\n');
writeFileSync(join(WWW, 'capacitor-plugins.js'), bundle);

// 4) Ponte nativa
writeFileSync(join(WWW, 'nativo.js'), readFileSync(join(AQUI, 'src/nativo.js'), 'utf8').replace('__VERSAO_APP__', VERSAO));
copyFileSync(join(AQUI, 'src/nativo.css'), join(WWW, 'nativo.css'));

// 5) index.html adaptado
let h = readFileSync(join(PAINEL, 'index.html'), 'utf8');
h = trocarUmaVez(h,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n' +
  '<script src="capacitor-plugins.js"></script>\n<script src="nativo.js"></script>',
  'meta viewport');
h = trocarUmaVez(h,
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>',
  '<script src="chart.umd.min.js"></script>',
  'Chart.js do CDN');
h = trocarUmaVez(h,
  '<link rel="stylesheet" href="cdv-redesign.css">',
  '<link rel="stylesheet" href="cdv-redesign.css">\n<link rel="stylesheet" href="nativo.css">',
  'link do cdv-redesign.css');
h = trocarUmaVez(h, "fetch('cidades-coords.json?", `fetch('${SITE}/cidades-coords.json?`, 'cidades-coords.json');
writeFileSync(join(WWW, 'index.html'), h);

console.log(`montar: www/ pronto (app ${VERSAO}, index.html ${(h.length / 1024).toFixed(0)} KB)`);
