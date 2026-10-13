#!/usr/bin/env bash
# salvar-estado.sh REPO_DIR SUBPASTA ORIGEM "ARQUIVOS" "MENSAGEM"
#
# Grava o resultado de uma coleta num repositório sem perder o que outros
# escritores (o proxy, outra coleta) gravaram no meio: guarda o resultado fora
# da árvore (ORIGEM), leva a árvore para o remoto atual e reaplica com
# reconciliar-estado.js (une ofertas por id, respeita rejeições/aprovações).
# Push rejeitado só refaz o ciclo. Usado para o painel-cdv (raiz) e para o repo
# privado de dados (subpasta painel/), desde a fase 2 da segurança (out/2026).
set -euo pipefail
REPO_DIR=$1; SUB=$2; ORIGEM=$3; ARQS=$4; MSG=$5
RECONCILIAR="$(cd "$(dirname "$0")/.." && pwd)/reconciliar-estado.js"
cd "$REPO_DIR"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
RAMO=$(git rev-parse --abbrev-ref HEAD)
PREF=""; [ -n "$SUB" ] && PREF="$SUB/"
for tent in 1 2 3 4 5; do
  git fetch -q origin "$RAMO"
  git reset -q --hard "origin/$RAMO"
  (cd "${SUB:-.}" && node "$RECONCILIAR" "$ORIGEM")
  for f in $ARQS; do [ -f "$PREF$f" ] && git add "$PREF$f" || true; done
  if git diff --staged --quiet; then
    echo "Nada mudou em $REPO_DIR — nada a commitar."
    exit 0
  fi
  git commit -q -m "$MSG"
  if git push -q origin "HEAD:$RAMO"; then
    echo "✓ Salvo em $REPO_DIR na tentativa $tent."
    exit 0
  fi
  echo "Push rejeitado (remoto mudou). Nova tentativa em ${tent}0s..."
  sleep "${tent}0"
done
echo "::error::Não consegui salvar em $REPO_DIR após 5 tentativas."
exit 1
