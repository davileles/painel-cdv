#!/usr/bin/env python3
"""
cdv_commit.py — commit seguro via GitHub API para o ecossistema CDV.

Resolve os problemas recorrentes do fluxo manual:
  - falha de validacao NAO pode deixar o PUT rodar (bug do `&&` ausente)
  - arquivos >1MB: Contents API devolve encoding:none -> le via git/blobs
  - raw.githubusercontent.com cacheia -> nunca usado para validar
  - SHA sempre buscado imediatamente antes do PUT
  - re-tentativa automatica em 409 (commits de background: crons, registros)
  - verificacao pos-commit lendo o blob do commit criado
  - guarda de remocao: aborta se o resultado apagar muito codigo sem aviso
  - guarda de superficie: respeita .github/superficie.json do repositorio

POR QUE O GUARDA DE REMOCAO EXISTE
  Em 09/08/2026 o commit 8bf01d9c no baileys-server tinha mensagem "feat:" e
  removia 463 linhas: apagou a integracao Awin inteira. Causa: a edicao foi
  feita numa copia local do server.js baixada horas antes, e o SHA do PUT foi
  buscado fresco — o GitHub aceitou sem 409, porque o SHA fresco diz "estou
  ciente da versao atual". Este script ja e imune a isso (rele o arquivo a
  cada tentativa e aplica a transformacao sobre o conteudo fresco), mas o
  guarda pega tambem o caso de um --script mal escrito.

Uso (replace literal):
  python3 cdv_commit.py --repo painel-cdv --path passagens.json \
      --old '"pontos": 265800' --new '"pontos": 465800' --count 1 \
      -m "Corrige pontos emissao GIG-CDG"

Uso (transformacao arbitraria):
  python3 cdv_commit.py --repo concierge --path index.html \
      --script meu_patch.py -m "Ajusta aba Configuracao"
  # meu_patch.py deve definir:  def transform(texto: str) -> str

Flags uteis:
  --dry-run      mostra o diff e NAO comita
  --retries N    tentativas em caso de 409 (default 3)
"""

import argparse
import base64
import difflib
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

API = "https://api.github.com"
OWNER = "davileles"


def die(msg, code=1):
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(code)


def api(url, token, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"message": body}


def ler_arquivo(repo, path, token):
    """Retorna (sha, texto). Usa git/blobs -> imune ao limite de 1MB e a cache."""
    st, meta = api(f"{API}/repos/{OWNER}/{repo}/contents/{path}", token)
    if st != 200:
        die(f"nao consegui ler metadados de {repo}/{path}: {meta.get('message')}")
    sha = meta["sha"]
    st, blob = api(f"{API}/repos/{OWNER}/{repo}/git/blobs/{sha}", token)
    if st != 200:
        die(f"nao consegui ler blob {sha}: {blob.get('message')}")
    texto = base64.b64decode(blob["content"]).decode("utf-8")
    return sha, texto


def validar(path, texto):
    """Valida sintaxe conforme a extensao. Levanta excecao se invalido."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        json.loads(texto)
        return "JSON valido"
    if ext in (".js", ".mjs"):
        return _node_check(texto, ".js")
    if ext == ".html":
        # extrai todos os blocos <script> nao-externos e concatena
        import re
        blocos = re.findall(
            r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", texto, re.S | re.I
        )
        if not blocos:
            return "HTML sem <script> inline — nada a validar"
        return _node_check("\n;\n".join(blocos), ".js") + f" ({len(blocos)} blocos)"
    return "extensao sem validador — conteudo aceito como texto"


def _node_check(codigo, ext):
    with tempfile.NamedTemporaryFile("w", suffix=ext, delete=False, encoding="utf-8") as f:
        f.write(codigo)
        tmp = f.name
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if r.returncode != 0:
            raise SyntaxError(r.stderr.strip())
        return "sintaxe JS valida"
    finally:
        os.unlink(tmp)


def aplicar(texto, args):
    if args.script:
        ns = {}
        exec(open(args.script, encoding="utf-8").read(), ns)
        if "transform" not in ns:
            die(f"{args.script} nao define transform(texto) -> texto")
        novo = ns["transform"](texto)
        if not isinstance(novo, str):
            die("transform() nao devolveu string")
        if novo == texto:
            die("transform() nao alterou nada — abortando")
        return novo

    n = texto.count(args.old)
    if n != args.count:
        die(f"esperava {args.count} ocorrencia(s) de {args.old!r}, encontrei {n} — abortando")
    return texto.replace(args.old, args.new, args.count)


def diff(antes, depois, path):
    d = list(difflib.unified_diff(
        antes.splitlines(), depois.splitlines(),
        fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=1))
    return "\n".join(d[:60]) + ("\n... (truncado)" if len(d) > 60 else "")


def superficie_do_repo(repo, path, token):
    """Marcadores declarados para este arquivo em .github/superficie.json."""
    try:
        _, txt = ler_arquivo(repo, ".github/superficie.json", token)
        cfg = json.loads(txt)
    except SystemExit:
        return {}
    except Exception:
        return {}
    return (cfg.get("arquivos") or {}).get(path) or {}


def checar_guardas(args, antes, depois, token):
    """Barra o PUT quando o resultado apaga o que nao deveria."""
    erros = []

    # a) marcadores passados na linha de comando
    for g in args.guard:
        if g not in depois:
            erros.append(f"marcador ausente no resultado: {g!r}")

    # b) contrato versionado do repositorio — mesma fonte que o CI usa
    regras = superficie_do_repo(args.repo, args.path, token)
    for marca in regras.get("obrigatorio", []):
        if marca in antes and marca not in depois:
            erros.append(f"superficie.json: o marcador {marca!r} existia e sumiu")
    minimo = regras.get("minLinhas")
    if minimo and len(depois.split("\n")) < minimo:
        erros.append(f"superficie.json: arquivo ficou com "
                     f"{len(depois.split(chr(10)))} linhas (minimo {minimo})")

    # c) volume: remocao liquida grande sem autorizacao explicita
    liquido = len(antes.split("\n")) - len(depois.split("\n"))
    if liquido >= args.max_remocao and not args.permitir_remocao:
        erros.append(
            f"remocao liquida de {liquido} linhas (limite {args.max_remocao}).\n"
            f"  Se e intencional, repita com --permitir-remocao.\n"
            f"  Se nao e, a transformacao provavelmente rodou sobre a base errada."
        )

    if erros:
        raise RuntimeError("\n".join("  - " + e for e in erros))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--path", required=True)
    p.add_argument("-m", "--message", required=True)
    p.add_argument("--old")
    p.add_argument("--new")
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--script")
    p.add_argument("--branch", default="main")
    p.add_argument("--retries", type=int, default=3)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--guard", action="append", default=[],
                   help="texto que DEVE existir no resultado (repetivel)")
    p.add_argument("--max-remocao", type=int, default=150,
                   help="remocao liquida de linhas que aborta o commit")
    p.add_argument("--permitir-remocao", action="store_true",
                   help="autoriza remocao acima de --max-remocao")
    args = p.parse_args()

    if not args.script and (args.old is None or args.new is None):
        die("informe --old/--new ou --script")

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        die("defina GITHUB_TOKEN no ambiente (nao passe token por argumento)")

    for tentativa in range(1, args.retries + 1):
        # 1. SHA + conteudo, sempre frescos, imediatamente antes do PUT
        sha, antes = ler_arquivo(args.repo, args.path, token)

        # 2. aplicar (aborta o processo inteiro se a pre-condicao falhar)
        depois = aplicar(antes, args)

        # 3. validar sintaxe — excecao aqui impede o PUT
        try:
            print(f"[validacao] {validar(args.path, depois)}")
        except Exception as e:
            die(f"validacao falhou, PUT NAO executado:\n{e}")

        # 3b. guardas de conteudo — rodam ANTES do PUT
        try:
            checar_guardas(args, antes, depois, token)
        except Exception as e:
            die(f"guarda bloqueou o commit, PUT NAO executado:\n{e}")

        print(f"[diff]\n{diff(antes, depois, args.path)}\n")

        if args.dry_run:
            print("[dry-run] nada foi comitado.")
            return

        # 4. PUT com o SHA da leitura desta mesma iteracao
        st, r = api(
            f"{API}/repos/{OWNER}/{args.repo}/contents/{args.path}",
            token, "PUT",
            {
                "message": args.message,
                "content": base64.b64encode(depois.encode("utf-8")).decode(),
                "sha": sha,
                "branch": args.branch,
            },
        )

        if st == 409 or (st == 422 and "sha" in str(r.get("message", "")).lower()):
            print(f"[409] conflito com commit de background — tentativa {tentativa}/{args.retries}")
            continue
        if st not in (200, 201):
            die(f"PUT falhou ({st}): {r.get('message')}")

        commit = r["commit"]["sha"]
        print(f"[commit] {commit}")

        # 5. verificacao pos-commit lendo o blob real (nunca via raw)
        _, agora = ler_arquivo(args.repo, args.path, token)
        if args.old and args.old in agora:
            die(f"pos-verificacao: {args.old!r} ainda presente — "
                f"um commit de background provavelmente sobrescreveu. Reexecute.")
        print("[ok] alteracao confirmada no HEAD.")
        return

    die(f"esgotadas {args.retries} tentativas por conflito de SHA")


if __name__ == "__main__":
    main()
