# CLAUDE.md

## Commits e push: direto na `main`

- Faça commit e push **direto na branch `main`**. Não crie branch de feature nem abra pull request, a menos que eu peça.
- Isso vale também para as sessões do Claude Code na nuvem: esta regra substitui a branch de desenvolvimento que a sessão indicar (`claude/...`).
- O push na `main` pode publicar em produção na hora (deploy automático). Antes de enviar, confira que o código funciona: rode os testes ou checagens que o projeto tiver (no mínimo `node --check` nos arquivos JS alterados).
- Se o push for recusado porque a `main` andou, faça `git pull --rebase origin main` e envie de novo. Nunca use `push --force` na `main`.
