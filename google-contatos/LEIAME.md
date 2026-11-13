# Alunos CDV → Google Contatos

Script do Google Apps Script que deixa o nome de cada aluno no Google Contatos como
`Nome SIGLA dd/mm/aa` (ex.: `William Camargo CDV 16/09/27`), pela última assinatura
que dá acesso a grupos do CDV. A lista vem do proxy (`GET /hubla/contatos`, regra em
`painel-cdv/google-contatos.js`); o resultado de cada rodada aparece no gestor-cdv →
Assinaturas → **Google Contatos**.

Siglas: Travel Concierge **TRC** · Consultoria Individual **CIN** · Escola do Viajante **EDV** ·
Clube do Viajante **CDV** · Clube do Viajante Premium **CDVP** · Balcão CDV **BAL** · Comunidade do
Viajante **COM** (BAL e COM só para quem não tem outro produto ativo) · vitalício sai com **VIT** no lugar da data.

## Instalação (uma vez, tudo pelo navegador)

1. Abra <https://script.google.com> com a conta Google da sua agenda → **Novo projeto**.
   Dê o nome "Alunos CDV → Contatos".
2. Apague o conteúdo de `Código.gs` e cole o `Codigo.gs` desta pasta. Salve.
3. Menu da esquerda → **Serviços** (+) → **Google People API** → Adicionar
   (identificador `People`).
4. Menu da esquerda → **Configurações do projeto** (engrenagem) → **Propriedades do script** →
   Adicionar: `CDV_OP_KEY` = a chave de operador do gestor (a mesma `CAMPANHAS_KEY`
   do Railway).
5. Volte ao editor, escolha a função **ensaio** no menu de cima e clique **Executar**.
   Na primeira vez o Google pede permissão para ler e editar seus contatos e acessar
   serviço externo: autorize (aparece "app não verificado" porque o script é seu →
   Avançado → Acessar).
6. Confira no gestor (Assinaturas → Google Contatos) os nomes que vão mudar e os
   contatos que vão ser criados.
7. Se estiver certo: execute **sincronizarAgora** e depois **ligarAutomatico**
   (passa a rodar sozinho a cada 6 horas).

## Como decide

- Acha o contato pelo telefone (DDD + 8 últimos dígitos, com ou sem o 9) ou pelo e-mail.
- Contato existente: troca só o fim do nome (sigla + data); o nome que você deu fica.
- Aluno que não está na agenda: cria o contato com nome, telefone e e-mail.
- Marca cada aluno com "Alunos CDV · Ativos" ou "Alunos CDV · Vencidos".
- Nunca apaga contato e nunca mexe em quem não é aluno.
