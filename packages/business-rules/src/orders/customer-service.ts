import {
  appError,
  err,
  ok,
  type CustomerTemplateKey,
  type OrderState,
  type Result,
} from '@vc/shared';
import { normalizeText } from '../discovery/classify';
import {
  isPaymentConfirmed,
  isShipmentVerified,
  refundableCents,
  type OrderFacts,
} from './order-engine';

/**
 * Atención al cliente: TODO lo que se le dice al comprador sale de hechos
 * verificados del pedido. Si un hecho no está respaldado, la plantilla no está
 * disponible (nunca se informa algo falso: p. ej. "despachado" sin comprobante).
 */

export interface CustomerFacts {
  readonly orderNumber: number;
  readonly order: OrderFacts;
  /** Plazo de devolución del proveedor (días desde la entrega), si está registrado. */
  readonly returnWindowDays: number | null;
  readonly deliveredAt: Date | null;
}

const PREPARING: readonly OrderState[] = [
  'PAYMENT_CONFIRMED',
  'SUPPLIER_STOCK_VERIFIED',
  'FINANCIAL_APPROVED',
  'SUPPLIER_ORDER_ACCEPTED',
];
const IN_REVIEW: readonly OrderState[] = [
  'BLOCKED_NO_STOCK',
  'BLOCKED_CASHFLOW',
  'BLOCKED_SUPPLIER',
  'MANUAL_REVIEW',
];

/** Estado para el comprador: verdadero y sin exponer detalles internos. */
export const buyerStatusText = (c: CustomerFacts): string => {
  const f = c.order;
  const n = `Pedido #${c.orderNumber}`;
  if (f.state === 'NEW' || f.state === 'PAYMENT_PENDING')
    return `${n}: lo recibimos y estamos esperando la confirmación del pago.`;
  if (PREPARING.includes(f.state))
    return `${n}: el pago está confirmado y el pedido está en preparación.`;
  if (f.state === 'SHIPPED' && f.shipment && isShipmentVerified(f.shipment)) {
    const delayed = f.shipment.status === 'DELAYED' ? ' El transportista informó una demora.' : '';
    return `${n}: fue despachado por ${f.shipment.carrier}. Número de seguimiento: ${f.shipment.trackingNumber}.${delayed}`;
  }
  if ((f.state === 'DELIVERED' || f.state === 'SETTLED') && f.shipment?.status === 'DELIVERED')
    return `${n}: el transportista informó la entrega.`;
  if (IN_REVIEW.includes(f.state))
    return `${n}: está en revisión. Te vamos a avisar apenas tengamos novedades.`;
  if (f.state === 'REFUND_REQUIRED') return `${n}: estamos gestionando el reintegro de tu pago.`;
  if (f.state === 'CANCELLED') {
    const refunded = f.payments.some((p) => p.kind === 'REFUND' && p.status === 'APPROVED');
    return refunded
      ? `${n}: fue cancelado y el reintegro quedó registrado en el medio de pago.`
      : `${n}: fue cancelado.`;
  }
  return `${n}: estamos revisando el estado.`;
};

interface TemplateDef {
  readonly label: string;
  /** null = disponible; string = motivo por el que NO se puede afirmar. */
  readonly requires: (c: CustomerFacts) => string | null;
  readonly render: (c: CustomerFacts) => string;
}

const TEMPLATES: Readonly<Record<CustomerTemplateKey, TemplateDef>> = {
  ORDER_RECEIVED: {
    label: 'Pedido recibido',
    requires: () => null,
    render: (c) =>
      `¡Hola! Recibimos tu pedido #${c.orderNumber}. Te avisamos cada novedad por este medio.`,
  },
  PAYMENT_PENDING: {
    label: 'Pago pendiente',
    requires: (c) =>
      c.order.state === 'NEW' || c.order.state === 'PAYMENT_PENDING'
        ? null
        : 'El pedido no está esperando pago',
    render: (c) =>
      `Tu pedido #${c.orderNumber} está esperando la confirmación del pago por parte del medio de pago.`,
  },
  PAYMENT_CONFIRMED: {
    label: 'Pago confirmado',
    requires: (c) => (isPaymentConfirmed(c.order) ? null : 'No hay evidencia de pago aprobado'),
    render: (c) => `Confirmamos el pago de tu pedido #${c.orderNumber}. Ya lo estamos preparando.`,
  },
  IN_PREPARATION: {
    label: 'En preparación',
    requires: (c) =>
      PREPARING.includes(c.order.state) ? null : 'El pedido no está en preparación',
    render: (c) =>
      `Tu pedido #${c.orderNumber} está en preparación. Te avisamos cuando se despache.`,
  },
  SHIPPED: {
    label: 'Despachado (con seguimiento)',
    requires: (c) =>
      ['SHIPPED', 'DELIVERED', 'SETTLED'].includes(c.order.state) &&
      isShipmentVerified(c.order.shipment)
        ? null
        : 'No hay despacho confirmado con comprobante',
    render: (c) =>
      `Tu pedido #${c.orderNumber} fue despachado por ${c.order.shipment?.carrier ?? ''}. Número de seguimiento: ${c.order.shipment?.trackingNumber ?? ''}.`,
  },
  DELIVERED: {
    label: 'Entregado',
    requires: (c) =>
      c.order.shipment?.status === 'DELIVERED' && c.order.shipment.deliveryEvidenceRef
        ? null
        : 'No hay evidencia de entrega',
    render: (c) =>
      `El transportista informó la entrega de tu pedido #${c.orderNumber}. ¿Llegó todo bien? Cualquier cosa, escribinos.`,
  },
  SHIPPING_DELAYED: {
    label: 'Envío demorado',
    requires: (c) =>
      c.order.shipment?.status === 'DELAYED' ? null : 'El transportista no informó demora',
    render: (c) =>
      `El transportista informó una demora en el envío de tu pedido #${c.orderNumber}. Podés seguirlo con el número ${c.order.shipment?.trackingNumber ?? ''}. Estamos atentos.`,
  },
  RETURN_INSTRUCTIONS: {
    label: 'Cómo devolver',
    requires: (c) =>
      c.returnWindowDays === null
        ? 'No hay plazo de devolución registrado del proveedor'
        : c.order.shipment?.status !== 'DELIVERED'
          ? 'El pedido no figura entregado'
          : c.deliveredAt &&
              c.order.now.getTime() - c.deliveredAt.getTime() > c.returnWindowDays * 86_400_000
            ? 'El plazo de devolución ya venció'
            : null,
    render: (c) =>
      `Podés solicitar la devolución del pedido #${c.orderNumber} dentro de los ${String(c.returnWindowDays)} días desde la entrega. Respondé este mensaje y te indicamos los pasos.`,
  },
  REFUND_IN_PROCESS: {
    label: 'Reintegro en gestión',
    requires: (c) =>
      c.order.state === 'REFUND_REQUIRED' && refundableCents(c.order) > 0
        ? null
        : 'No hay reintegro en gestión',
    render: (c) =>
      `Estamos gestionando el reintegro del pedido #${c.orderNumber} en el mismo medio de pago. Te avisamos cuando quede registrado.`,
  },
  ORDER_CANCELLED: {
    label: 'Pedido cancelado',
    requires: (c) => (c.order.state === 'CANCELLED' ? null : 'El pedido no está cancelado'),
    render: (c) => buyerStatusText(c),
  },
  ESCALATED: {
    label: 'Derivado a una persona',
    requires: () => null,
    render: (c) =>
      `Derivamos tu consulta sobre el pedido #${c.orderNumber} a una persona del equipo. Te respondemos a la brevedad.`,
  },
};

export const renderCustomerTemplate = (
  key: CustomerTemplateKey,
  c: CustomerFacts,
): Result<string> => {
  const t = TEMPLATES[key];
  const blocked = t.requires(c);
  return blocked
    ? err(appError('CONFLICT', `Plantilla no disponible: ${blocked}`))
    : ok(t.render(c));
};

export const availableTemplates = (c: CustomerFacts) =>
  (Object.keys(TEMPLATES) as CustomerTemplateKey[])
    .filter((k) => TEMPLATES[k].requires(c) === null)
    .map((k) => ({ key: k, label: TEMPLATES[k].label, body: TEMPLATES[k].render(c) }));

/** Plantillas sin pedido asociado: solo las que no afirman hechos de un pedido. */
export const GENERIC_ESCALATION_TEXT =
  'Derivamos tu consulta a una persona del equipo. Te respondemos a la brevedad.';

/* ================================ FAQ ================================ */

/** Sugiere FAQs por coincidencia de palabras clave (determinístico, sin IA). */
export const matchFaqs = <
  F extends { readonly id: string; readonly keywords: readonly string[]; readonly active: boolean },
>(
  text: string,
  faqs: readonly F[],
  limit = 3,
): F[] => {
  const words = ` ${normalizeText(text)} `;
  return faqs
    .filter((f) => f.active)
    .map((f) => ({
      f,
      score: f.keywords.filter(
        (k) => normalizeText(k).length > 0 && words.includes(` ${normalizeText(k)} `),
      ).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.f);
};

/* ================================ Escalamiento ================================ */

export const ESCALATION_KEYWORDS = [
  'reclamo',
  'denuncia',
  'estafa',
  'fraude',
  'abogado',
  'defensa del consumidor',
  'nunca llego',
  'me robaron',
  'carta documento',
] as const;

/** Decide si una consulta debe derivarse a un administrador (motivo o null). */
export const escalationReason = (text: string, state: OrderState | null): string | null => {
  const t = normalizeText(text);
  const kw = ESCALATION_KEYWORDS.find((k) => t.includes(k));
  if (kw) return `Mensaje con término sensible: "${kw}"`;
  if (state === 'MANUAL_REVIEW' || state === 'REFUND_REQUIRED')
    return `El pedido está en ${state}: requiere intervención humana`;
  return null;
};
