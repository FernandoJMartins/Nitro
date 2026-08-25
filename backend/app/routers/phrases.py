"""Rotas de tipos de frase e frases (módulo 4). Frases aparecem DENTRO do vídeo."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Phrase, PhraseType
from ..schemas import (
    AIGenerateRequest,
    AIGenerateResponse,
    PhraseBulkSave,
    PhraseCreate,
    PhraseOut,
    PhraseTypeCreate,
    PhraseTypeOut,
)
from ..services import ai

router = APIRouter(prefix="/api/v1", tags=["phrases"])

# Quantas frases existentes são enviadas como exemplo para a IA.
MAX_EXEMPLOS = 15


# ---------- Tipos de frase ----------
@router.post("/phrase-types", response_model=PhraseTypeOut)
def create_phrase_type(body: PhraseTypeCreate, db: Session = Depends(get_db)):
    nome = body.nome.strip()
    if not nome:
        raise HTTPException(status_code=400, detail="nome é obrigatório")
    if db.scalar(select(PhraseType).where(PhraseType.nome == nome)):
        raise HTTPException(status_code=409, detail=f"Já existe um tipo '{nome}'")
    pt = PhraseType(nome=nome, descricao=body.descricao)
    db.add(pt)
    db.commit()
    db.refresh(pt)
    return pt


@router.get("/phrase-types", response_model=list[PhraseTypeOut])
def list_phrase_types(db: Session = Depends(get_db)):
    return list(db.scalars(select(PhraseType).order_by(PhraseType.nome)))


@router.delete("/phrase-types/{type_id}", status_code=204)
def delete_phrase_type(type_id: int, db: Session = Depends(get_db)):
    pt = db.get(PhraseType, type_id)
    if not pt:
        raise HTTPException(status_code=404, detail="Tipo não encontrado")
    db.delete(pt)  # cascade remove as frases do tipo
    db.commit()


# ---------- Frases ----------
@router.get("/phrases", response_model=list[PhraseOut])
def list_phrases(tipo_id: int | None = None, db: Session = Depends(get_db)):
    stmt = select(Phrase).order_by(Phrase.criado_em.desc())
    if tipo_id is not None:
        stmt = stmt.where(Phrase.phrase_type_id == tipo_id)
    return list(db.scalars(stmt))


@router.post("/phrases", response_model=PhraseOut)
def create_phrase(body: PhraseCreate, db: Session = Depends(get_db)):
    if not db.get(PhraseType, body.phrase_type_id):
        raise HTTPException(status_code=404, detail="Tipo de frase não encontrado")
    texto = body.texto.strip()
    if not texto:
        raise HTTPException(status_code=400, detail="texto é obrigatório")
    ph = Phrase(phrase_type_id=body.phrase_type_id, texto=texto, origem="manual")
    db.add(ph)
    db.commit()
    db.refresh(ph)
    return ph


@router.post("/phrases/bulk-save", response_model=list[PhraseOut])
def bulk_save_phrases(body: PhraseBulkSave, db: Session = Depends(get_db)):
    """Salva várias frases de uma vez (usado ao aceitar sugestões da IA)."""
    if not db.get(PhraseType, body.phrase_type_id):
        raise HTTPException(status_code=404, detail="Tipo de frase não encontrado")
    criadas = []
    for texto in body.textos:
        t = texto.strip()
        if not t:
            continue
        ph = Phrase(phrase_type_id=body.phrase_type_id, texto=t, origem=body.origem)
        db.add(ph)
        criadas.append(ph)
    db.commit()
    for ph in criadas:
        db.refresh(ph)
    return criadas


@router.delete("/phrases/{phrase_id}", status_code=204)
def delete_phrase(phrase_id: int, db: Session = Depends(get_db)):
    ph = db.get(Phrase, phrase_id)
    if not ph:
        raise HTTPException(status_code=404, detail="Frase não encontrada")
    db.delete(ph)
    db.commit()


# ---------- IA (só quando o usuário pede) ----------
@router.post("/phrases/ai", response_model=AIGenerateResponse)
def generate_with_ai(body: AIGenerateRequest, db: Session = Depends(get_db)):
    pt = db.get(PhraseType, body.phrase_type_id)
    if not pt:
        raise HTTPException(status_code=404, detail="Tipo de frase não encontrado")

    quantidade = max(1, min(body.quantidade, 20))
    exemplos = [
        p.texto
        for p in db.scalars(
            select(Phrase)
            .where(Phrase.phrase_type_id == pt.id)
            .order_by(Phrase.criado_em.desc())
            .limit(MAX_EXEMPLOS)
        )
    ]

    try:
        frases = ai.generate_phrases(pt.nome, exemplos, quantidade, body.instrucao_extra)
    except RuntimeError as exc:  # sem chave de API
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — erro da OpenAI/rede
        raise HTTPException(status_code=502, detail=f"Falha ao gerar com IA: {exc}") from exc

    # As sugestões NÃO são salvas automaticamente — o usuário escolhe quais salvar.
    return AIGenerateResponse(frases=frases, modelo=ai.settings.openai_model, baseado_em=len(exemplos))
