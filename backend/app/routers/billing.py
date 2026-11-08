"""Cobrança (Stripe): planos, assinatura via Checkout (cartão, mensal), portal do
cliente e webhook que mantém o status da assinatura no banco.

Fluxo:
  1. GET  /billing/plans            -> planos e limites (público p/ usuário logado)
  2. POST /billing/checkout {plano} -> URL do Stripe Checkout; o usuário paga lá
  3. Stripe chama POST /billing/webhook -> grava plano/status no usuário
  4. POST /billing/portal           -> URL do portal (trocar cartão, mudar plano, cancelar)
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..billing import limits
from ..billing.plans import PLANS
from ..config import settings
from ..database import get_db
from ..deps import get_authenticated_user
from ..models import User

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])


def _stripe():
    if not settings.stripe_secret_key:
        raise HTTPException(503, "Pagamento ainda não configurado (STRIPE_SECRET_KEY).")
    import stripe

    stripe.api_key = settings.stripe_secret_key
    return stripe


def _price_ids() -> dict[str, str]:
    return {
        "basico": settings.stripe_price_basico,
        "pro": settings.stripe_price_pro,
        "agencia": settings.stripe_price_agencia,
    }


def _plan_from_price(price_id: str | None) -> str | None:
    for plano, pid in _price_ids().items():
        if pid and pid == price_id:
            return plano
    return None


@router.get("/plans")
def list_plans():
    return [p.as_dict() for p in PLANS.values()]


@router.get("/me")
def my_billing(user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)):
    plan = limits.effective_plan(user)
    return {
        "is_admin": user.is_admin,
        "plano": user.plano,
        "assinatura_status": user.assinatura_status,
        "periodo_fim": user.periodo_fim,
        "acesso_manual_ate": user.acesso_manual_ate,
        "tem_acesso": plan is not None,
        "recursos": plan.as_dict() if plan else None,
        "uso": limits.usage_summary(db, user),
        "pagamento_configurado": bool(settings.stripe_secret_key),
    }


class CheckoutBody(BaseModel):
    plano: str


@router.post("/checkout")
def create_checkout(body: CheckoutBody, user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)):
    if user.is_admin:
        raise HTTPException(400, "Administradores não precisam de assinatura.")
    if body.plano not in PLANS:
        raise HTTPException(400, "Plano inválido.")
    price = _price_ids()[body.plano]
    if not price:
        raise HTTPException(503, f"Preço do plano {body.plano} não configurado (STRIPE_PRICE_{body.plano.upper()}).")
    stripe = _stripe()
    # já assina? troca de plano é pelo portal (a Stripe calcula o proporcional)
    if user.stripe_subscription_id and user.assinatura_status in limits.STATUS_COM_ACESSO:
        raise HTTPException(409, "Você já tem uma assinatura ativa. Use 'Gerenciar assinatura' para mudar de plano.")

    if not user.stripe_customer_id:
        customer = stripe.Customer.create(email=user.email, metadata={"user_id": str(user.id)})
        user.stripe_customer_id = customer.id
        db.commit()

    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=user.stripe_customer_id,
        client_reference_id=str(user.id),
        line_items=[{"price": price, "quantity": 1}],
        payment_method_types=["card"],
        success_url=f"{settings.app_url}/planos?status=sucesso",
        cancel_url=f"{settings.app_url}/planos?status=cancelado",
        subscription_data={"metadata": {"user_id": str(user.id), "plano": body.plano}},
        allow_promotion_codes=True,
    )
    return {"url": session.url}


@router.post("/portal")
def create_portal(user: User = Depends(get_authenticated_user)):
    if not user.stripe_customer_id:
        raise HTTPException(400, "Você ainda não tem assinatura.")
    stripe = _stripe()
    portal = stripe.billing_portal.Session.create(
        customer=user.stripe_customer_id, return_url=f"{settings.app_url}/planos"
    )
    return {"url": portal.url}


# ---------------- webhook ----------------
def _as_dict(obj) -> dict:
    """StripeObject -> dict puro (independe da versão da lib)."""
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if hasattr(obj, "to_dict_recursive"):
        return obj.to_dict_recursive()
    return dict(obj)


def _apply_subscription(db: Session, sub: dict) -> None:
    """Grava no usuário o estado de uma assinatura Stripe (objeto Subscription)."""
    user = None
    uid = (sub.get("metadata") or {}).get("user_id")
    if uid and str(uid).isdigit():
        user = db.get(User, int(uid))
    if user is None and sub.get("customer"):
        user = db.scalar(select(User).where(User.stripe_customer_id == sub["customer"]))
    if user is None:
        return

    items = (sub.get("items") or {}).get("data") or []
    price_id = items[0]["price"]["id"] if items else None
    plano = _plan_from_price(price_id) or (sub.get("metadata") or {}).get("plano")
    # current_period_end: no objeto (API antiga) ou no item (API nova)
    fim = sub.get("current_period_end") or (items[0].get("current_period_end") if items else None)

    user.stripe_customer_id = sub.get("customer") or user.stripe_customer_id
    user.stripe_subscription_id = sub.get("id")
    user.assinatura_status = sub.get("status")
    if plano in PLANS:
        user.plano = plano
    user.periodo_fim = datetime.fromtimestamp(fim, tz=timezone.utc) if fim else None
    db.commit()


@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    stripe = _stripe()
    if not settings.stripe_webhook_secret:
        raise HTTPException(503, "STRIPE_WEBHOOK_SECRET não configurado.")
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        stripe.Webhook.construct_event(payload, sig, settings.stripe_webhook_secret)  # valida a assinatura
    except Exception:  # noqa: BLE001 — assinatura inválida ou payload quebrado
        raise HTTPException(400, "Webhook inválido.")
    event = json.loads(payload)

    tipo = event["type"]
    obj = event["data"]["object"]
    if tipo == "checkout.session.completed" and obj.get("subscription"):
        _apply_subscription(db, _as_dict(stripe.Subscription.retrieve(obj["subscription"])))
    elif tipo in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        _apply_subscription(db, obj)
    elif tipo in ("invoice.paid", "invoice.payment_failed"):
        sub_id = obj.get("subscription") or ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
        if sub_id:
            _apply_subscription(db, _as_dict(stripe.Subscription.retrieve(sub_id)))
    return {"ok": True}
