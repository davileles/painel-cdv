// icones.mjs — monta as imagens-fonte de ícone e abertura do app a partir do
// logocdv.png do painel (logo completa: pássaro + "clube do viajante", fundo branco).
// Ícone e abertura em fundo branco, como a logo foi desenhada. Depois o
// @capacitor/assets gera todos os tamanhos de Android e iOS (npm run icones).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOGO = join(AQUI, '..', 'logocdv.png');
const OUT = join(AQUI, 'assets');
const BRANCO = '#ffffff';
mkdirSync(OUT, { recursive: true });

const fundo = (lado, cor) => sharp({ create: { width: lado, height: lado, channels: 4, background: cor } });
// Logo ajustada (sem distorcer) a uma largura; fundo transparente onde é branco puro
// só quando pedido (ícone adaptativo do Android, que tem camada de fundo própria).
async function logo(largura, semFundo) {
  let img = sharp(LOGO).ensureAlpha().resize({ width: largura, kernel: 'lanczos3' });
  if (!semFundo) return img.png().toBuffer();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= 248 && data[i + 1] >= 248 && data[i + 2] >= 248) data[i + 3] = 0;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function comLogo(lado, cor, proporcao, arquivo, semFundo = false) {
  const buf = await logo(Math.round(lado * proporcao), semFundo);
  const { width, height } = await sharp(buf).metadata();
  await fundo(lado, cor)
    .composite([{ input: buf, left: Math.round((lado - width) / 2), top: Math.round((lado - height) / 2) }])
    .png().toFile(join(OUT, arquivo));
}

await comLogo(1024, BRANCO, 0.78, 'icon-only.png');                 // iOS (sem transparência)
await comLogo(1024, '#00000000', 0.6, 'icon-foreground.png', true); // Android adaptativo (área segura)
await fundo(1024, BRANCO).png().toFile(join(OUT, 'icon-background.png'));
await comLogo(2732, BRANCO, 0.34, 'splash.png');
await comLogo(2732, BRANCO, 0.34, 'splash-dark.png');
console.log('icones: assets/ pronto');
