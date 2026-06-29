const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED = ['comparemania.com.br'];

// CORS completo — aceita qualquer origem, trata preflight OPTIONS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/fetch', async (req, res) => {
  const target = req.query.url;

  if (!target) {
    return res.status(400).json({ error: 'Parâmetro ?url= obrigatório' });
  }

  const isAllowed = ALLOWED.some(domain => target.includes(domain));
  if (!isAllowed) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }

  try {
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      timeout: 15000
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Destino retornou ${response.status}` });
    }

    const html = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`CDV Proxy rodando na porta ${PORT}`));
