#!/usr/bin/env python3
"""
Validador do catalogo de cartoes.

Regra central: um campo factual so pode ter valor se houver, no proprio
registro, uma URL de fonte oficial declarada para AQUELE campo.
Sem procedencia -> o valor e zerado e o campo entra em campos_pendentes.

Isso torna estruturalmente impossivel um numero aparecer na base sem
alguem ter apontado de onde ele veio.
"""
import json, sys
from urllib.parse import urlparse

DOMINIOS_OFICIAIS = {
    'bb.com.br','bradesco.com.br','brb.com.br','btgpactual.com','c6bank.com.br',
    'caixa.gov.br','bancointer.com.br','inter.co','itau.com.br','nubank.com.br',
    'santander.com.br','sicredi.com.br','sicoob.com.br','xpi.com.br',
    'banco.bradesco','assets.bradesco','safra.com.br','banrisul.com.br',
    'genial.com.vc','genialinvestimentos.com.br','unicred.com.br',
    'portobank.com.br','porto.com.br','banestes.com.br',
    'elo.com.br','mastercard.com','mastercard.com.br','visa.com.br',
    'visa-infinite.com','americanexpress.com',
}

CAMPOS_FACTUAIS = ['anuidade','anuidade_parcelas','isencao','renda_minima',
                   'adicionais_gratis','pontos','cashback','spread','iof',
                   'salas_vip','transfere_para','requisito_acesso']

def oficial(url):
    try:
        h = urlparse(str(url)).hostname or ''
        h = h.lower().replace('www.','',1)
        return any(h == d or h.endswith('.'+d) for d in DOMINIOS_OFICIAIS)
    except Exception:
        return False

def vazio(v):
    return v is None or v == '' or v == [] or v == {}

def validar(cartao, corrigir=False):
    """Retorna (cartao, problemas)."""
    probs = []
    proc = cartao.get('procedencia') or {}
    pend = set(cartao.get('campos_pendentes') or [])

    for url in cartao.get('fontes') or []:
        if not oficial(url):
            probs.append(f"fonte nao oficial em 'fontes': {url}")

    for campo in CAMPOS_FACTUAIS:
        v = cartao.get(campo)
        tem_valor = not vazio(v)
        fonte = proc.get(campo)
        fonte_ok = bool(fonte) and oficial(fonte)

        if tem_valor and not fonte_ok:
            probs.append(f"{campo}={v!r} SEM procedencia oficial"
                         + (f" (fonte declarada: {fonte})" if fonte else ""))
            if corrigir:
                cartao[campo] = [] if isinstance(v, list) else None
                pend.add(campo)
        if tem_valor and fonte_ok and campo in pend:
            probs.append(f"{campo} tem valor E esta em campos_pendentes (contradicao)")
            if corrigir:
                pend.discard(campo)
        if not tem_valor and campo not in pend:
            if corrigir:
                pend.add(campo)

    if corrigir:
        cartao['campos_pendentes'] = sorted(pend)
    return cartao, probs

def main():
    caminho = sys.argv[1] if len(sys.argv) > 1 else 'cartoes-catalogo.json'
    corrigir = '--corrigir' in sys.argv
    d = json.load(open(caminho, encoding='utf-8'))

    total_probs = 0
    for c in d.get('cartoes', []):
        _, probs = validar(c, corrigir=corrigir)
        if probs:
            total_probs += len(probs)
            print(f"\n[{c.get('slug')}]")
            for p in probs:
                print("   -", p)

    if corrigir:
        d['_meta']['validado_em'] = '2026-07-27'
        d['_meta']['regra'] = ('Campo factual so tem valor se houver URL oficial '
                               'declarada em procedencia[campo]. Validado por valida_catalogo.py.')
        json.dump(d, open(caminho, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f"\nCorrigido e salvo: {caminho}")

    print(f"\nTotal de problemas: {total_probs}")
    return 1 if (total_probs and not corrigir) else 0

if __name__ == '__main__':
    sys.exit(main())
