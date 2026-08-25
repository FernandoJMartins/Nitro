"""Geração de frases por IA (opcional, roda só quando o usuário pede).

Usa o modelo mais barato da OpenAI (gpt-4o-mini por padrão). A IA se baseia
NAS FRASES QUE O USUÁRIO JÁ CADASTROU do tipo escolhido, mantendo o mesmo tom,
tamanho e nível de malícia (duplo sentido).

A montagem do prompt e o parsing da resposta são funções puras (testáveis sem
chave de API). Só `generate_phrases` faz a chamada de rede.
"""
from __future__ import annotations

import re

from ..config import settings

SYSTEM_PROMPT = (
    "Você é um criador de frases curtas e picantes, em português brasileiro, "
    "para aparecerem DENTRO de vídeos curtos de redes sociais. Seu forte é o "
    "duplo sentido: a frase parece inocente, mas sugere algo mais. Cada frase "
    "tem no máximo uma linha curta. Nunca use conteúdo explícito, apenas insinuação."
)


def build_messages(
    tipo_nome: str,
    exemplos: list[str],
    quantidade: int,
    instrucao_extra: str | None = None,
) -> list[dict[str, str]]:
    """Monta as mensagens enviadas ao modelo (função pura)."""
    if exemplos:
        bloco_exemplos = "\n".join(f"- {e}" for e in exemplos)
        base = (
            f"Tipo de frase: {tipo_nome}.\n"
            f"Siga EXATAMENTE o estilo, o tom e o tamanho destes exemplos que já existem:\n"
            f"{bloco_exemplos}\n\n"
        )
    else:
        base = (
            f"Tipo de frase: {tipo_nome}.\n"
            f"Ainda não há exemplos cadastrados; crie no tom sugerido pelo nome do tipo.\n\n"
        )

    pedido = (
        f"Gere {quantidade} frases NOVAS e originais (não repita os exemplos), "
        f"uma por linha, sem numeração, sem aspas, sem comentários."
    )
    if instrucao_extra:
        pedido += f" Instrução adicional: {instrucao_extra.strip()}"

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": base + pedido},
    ]


def parse_phrases(text: str, limit: int | None = None) -> list[str]:
    """Extrai as frases da resposta do modelo (função pura).

    Remove numeração (1. / 1) / -), aspas nas pontas e linhas vazias.
    """
    frases: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r"^\s*(\d+[\.\)]|[-*•])\s*", "", line)  # tira "1." "1)" "-" "*" "•"
        line = line.strip().strip('"').strip("'").strip()
        if line:
            frases.append(line)
    if limit is not None:
        frases = frases[:limit]
    return frases


def generate_phrases(
    tipo_nome: str,
    exemplos: list[str],
    quantidade: int,
    instrucao_extra: str | None = None,
) -> list[str]:
    """Chama a OpenAI e retorna a lista de frases geradas.

    Levanta RuntimeError se não houver chave de API configurada.
    """
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY não configurada no .env — necessária para gerar frases por IA."
        )

    from openai import OpenAI  # import tardio: só carrega quando a IA é usada

    client = OpenAI(api_key=settings.openai_api_key)
    resp = client.chat.completions.create(
        model=settings.openai_model,
        messages=build_messages(tipo_nome, exemplos, quantidade, instrucao_extra),
        temperature=1.0,
        max_tokens=400,
    )
    conteudo = resp.choices[0].message.content or ""
    return parse_phrases(conteudo, limit=quantidade)


CAPTION_SYSTEM = (
    "Você escreve legendas curtas e chamativas para posts do Instagram (Reels), "
    "em português brasileiro, com um toque de duplo sentido leve. Formato: 1 a 2 "
    "linhas de legenda + 3 a 5 hashtags relevantes na mesma resposta."
)


def build_caption_messages(texto_no_video: str | None, tipo_nome: str | None) -> list[dict[str, str]]:
    """Monta as mensagens para gerar a legenda da postagem (função pura)."""
    ctx = []
    if texto_no_video:
        ctx.append(f'O texto que aparece na tela do vídeo é: "{texto_no_video}".')
    if tipo_nome:
        ctx.append(f"O tom/categoria é: {tipo_nome}.")
    contexto = " ".join(ctx) or "Vídeo curto e provocante para redes sociais."
    return [
        {"role": "system", "content": CAPTION_SYSTEM},
        {
            "role": "user",
            "content": (
                f"{contexto}\nEscreva a legenda da postagem (não repita literalmente o "
                f"texto da tela) seguida das hashtags. Responda só com a legenda final."
            ),
        },
    ]


def generate_caption(texto_no_video: str | None = None, tipo_nome: str | None = None) -> str:
    """Chama a OpenAI e retorna a legenda da postagem. RuntimeError se sem chave."""
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY não configurada — necessária para gerar legenda por IA.")

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key)
    resp = client.chat.completions.create(
        model=settings.openai_model,
        messages=build_caption_messages(texto_no_video, tipo_nome),
        temperature=0.9,
        max_tokens=200,
    )
    return (resp.choices[0].message.content or "").strip()
