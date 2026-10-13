// dados-dir.js
// Pasta onde os coletores leem e gravam o conteúdo pago do painel (histórico,
// ofertas, passagens, alertas...). Desde a fase 2 da segurança (out/2026) esses
// arquivos moram no repo PRIVADO de dados, em painel/; o workflow faz checkout
// dele e passa o caminho em CDV_DADOS_DIR. Sem a variável (rodando à mão, na
// raiz do painel-cdv), cai na pasta do próprio script, como antes.
const path = require('path');
module.exports = process.env.CDV_DADOS_DIR ? path.resolve(process.env.CDV_DADOS_DIR) : __dirname;
