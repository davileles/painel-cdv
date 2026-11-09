// icones.mjs — monta as imagens-fonte de ícone e abertura do app a partir do
// logocdv.png do painel (pássaro sobre o azul-marinho da marca). Depois o
// @capacitor/assets gera todos os tamanhos de Android e iOS (npm run icones).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOGO = join(AQUI, '..', 'logocdv.png');
const OUT = join(AQUI, 'assets');
const NAVY = '#262e42';
const NAVY_ESCURO = '#1c2333';
mkdirSync(OUT, { recursive: true });

const fundo = (lado, cor) => sharp({ create: { width: lado, height: lado, channels: 4, background: cor } });
// O logocdv.png tem fundo branco: branco puro vira transparente (o corpo do
// pássaro é cinza #ededed e fica; os contornos brancos passam a mostrar o fundo).
async function logoSemFundo() {
  const { data, info } = await sharp(LOGO).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= 248 && data[i + 1] >= 248 && data[i + 2] >= 248) data[i + 3] = 0;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}
const LOGO_SEM_FUNDO = await logoSemFundo();
const logo = (lado) => sharp(LOGO_SEM_FUNDO).resize(lado, lado, { kernel: 'lanczos3' }).png().toBuffer();

async function comLogo(lado, cor, proporcao, arquivo) {
  const l = Math.round(lado * proporcao);
  const off = Math.round((lado - l) / 2);
  await fundo(lado, cor).composite([{ input: await logo(l), left: off, top: off }]).png().toFile(join(OUT, arquivo));
}

await comLogo(1024, NAVY, 0.86, 'icon-only.png');            // iOS (sem transparência)
await comLogo(1024, '#00000000', 0.62, 'icon-foreground.png'); // Android adaptativo
await fundo(1024, NAVY).png().toFile(join(OUT, 'icon-background.png'));
await comLogo(2732, NAVY, 0.22, 'splash.png');
await comLogo(2732, NAVY_ESCURO, 0.22, 'splash-dark.png');
console.log('icones: assets/ pronto');
