import { and, desc, eq } from 'drizzle-orm';
import {
  assertCommercialActionAllowed,
  availableTemplates,
  buyerStatusText,
  escalationReason,
  GENERIC_ESCALATION_TEXT,
  matchFaqs,
  renderCustomerTemplate,
  type CustomerFacts,
} from '@vc/business-rules';
import {
  faqEntries,
  orderEvents,
  orders,
  supportMessages,
  supportTickets,
  type SupportTicketRow,
} from '@vc/database';
import {
  appError,
  err,
  newId,
  ok,
  type CreateFaqRequest,
  type CreateTicketRequest,
  type FaqDto,
  type ReplyTicketRequest,
  type Result,
  type SupportTicketDto,
} from '@vc/shared';
import { iso, isoOrNull, notFound } from '../../http';
import { findOrder, getOrderDetail, type OrderRuntime } from './service';

/**
 * Atención al cliente. Las respuestas salen de plantillas que solo afirman hechos
 * verificados del pedido, de FAQs cargadas por el negocio o de texto escrito por
 * una persona. ENVIAR es una acción comercial: con el interruptor apagado, la
 * respuesta queda preparada pero bloqueada (no se contacta al cliente).
 */

const customerFactsOf = async (
  rt: OrderRuntime,
  orderId: string,
): Promise<CustomerFacts | null> => {
  const detail = await getOrderDetail(rt, orderId);
  if (!detail.ok) return null;
  const d = detail.value;
  const ship = d.shipments[0];
  const facts: CustomerFacts = {
    orderNumber: d.order.number,
    returnWindowDays: null,
    deliveredAt: ship?.deliveredAt ? new Date(ship.deliveredAt) : null,
    order: {
      state: d.order.state,
      totalCents: d.order.totalCents,
      currency: d.order.currency,
      payments: d.payments.map((p) => ({
        kind: p.kind,
        status: p.status,
        amountCents: p.amountCents,
        currency: p.currency,
        evidenceRef: p.evidenceRef,
      })),
      selection: null,
      financial: null,
      supplierOrder: null,
      shipment: ship
        ? {
            status: ship.status,
            carrier: ship.carrier,
            trackingNumber: ship.trackingNumber,
            confirmationRef: ship.confirmationRef,
            estimatedDeliveryAt: ship.estimatedDeliveryAt
              ? new Date(ship.estimatedDeliveryAt)
              : null,
            deliveryEvidenceRef: ship.deliveryEvidenceRef,
          }
        : null,
      openReturn: null,
      reconciliation: null,
      now: rt.now,
    },
  };
  return facts;
};

const listFaqRows = (rt: OrderRuntime) =>
  rt.db.select().from(faqEntries).where(eq(faqEntries.tenantId, rt.tenantId));

const toTicketDto = async (rt: OrderRuntime, t: SupportTicketRow): Promise<SupportTicketDto> => {
  const messages = await rt.db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.ticketId, t.id))
    .orderBy(supportMessages.createdAt);
  const order = t.orderId ? await findOrder(rt.db, rt.tenantId, t.orderId) : undefined;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'INBOUND');
  const faqs = lastInbound ? matchFaqs(lastInbound.body, await listFaqRows(rt)) : [];
  const facts = t.orderId ? await customerFactsOf(rt, t.orderId) : null;
  return {
    id: t.id,
    orderId: t.orderId,
    orderNumber: order?.number ?? null,
    channel: t.channel,
    contactRef: t.contactRef,
    subject: t.subject,
    status: t.status,
    escalationReason: t.escalationReason,
    escalatedAt: isoOrNull(t.escalatedAt),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      templateKey: (m.templateKey as SupportTicketDto['messages'][number]['templateKey']) ?? null,
      faqId: m.faqId,
      status: m.status,
      detail: m.detail,
      createdAt: iso(m.createdAt),
    })),
    suggestions: [
      ...faqs.map((f) => ({ kind: 'FAQ' as const, key: f.id, label: f.question, body: f.answer })),
      ...(facts
        ? availableTemplates(facts).map((x) => ({
            kind: 'TEMPLATE' as const,
            key: x.key,
            label: x.label,
            body: x.body,
          }))
        : []),
    ],
  };
};

const findTicket = (rt: OrderRuntime, id: string) =>
  rt.db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.id, id), eq(supportTickets.tenantId, rt.tenantId)))
    .get();

const reloadTicket = async (rt: OrderRuntime, id: string): Promise<Result<SupportTicketDto>> => {
  const t = await findTicket(rt, id);
  return t ? ok(await toTicketDto(rt, t)) : notFound('Consulta');
};

export const listTickets = async (rt: OrderRuntime) => {
  const rows = await rt.db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.tenantId, rt.tenantId))
    .orderBy(desc(supportTickets.updatedAt))
    .limit(100);
  return Promise.all(rows.map((t) => toTicketDto(rt, t)));
};

const escalate = async (rt: OrderRuntime, t: SupportTicketRow, reason: string) => {
  await rt.db
    .update(supportTickets)
    .set({ status: 'ESCALATED', escalationReason: reason, escalatedAt: rt.now, updatedAt: rt.now })
    .where(eq(supportTickets.id, t.id));
  if (t.orderId) {
    await rt.db.insert(orderEvents).values({
      id: newId(),
      tenantId: rt.tenantId,
      orderId: t.orderId,
      type: 'SUPPORT_ESCALATED',
      actor: 'SYSTEM',
      detail: { ticketId: t.id, reason },
      createdAt: rt.now,
    });
  }
};

/** Nueva consulta: se registra, se sugieren respuestas y se escala si corresponde. */
export const createTicket = async (
  rt: OrderRuntime,
  input: CreateTicketRequest,
): Promise<Result<SupportTicketDto>> => {
  const order = input.orderId ? await findOrder(rt.db, rt.tenantId, input.orderId) : undefined;
  if (input.orderId && !order) return notFound('Pedido');
  const id = newId();
  await rt.db.insert(supportTickets).values({
    id,
    tenantId: rt.tenantId,
    orderId: order?.id ?? null,
    channel: input.channel,
    contactRef: input.contactRef,
    subject: input.subject,
    status: 'OPEN',
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  await rt.db.insert(supportMessages).values({
    id: newId(),
    tenantId: rt.tenantId,
    ticketId: id,
    direction: 'INBOUND',
    body: input.message,
    status: 'RECEIVED',
    createdAt: rt.now,
  });
  const reason = escalationReason(`${input.subject} ${input.message}`, order?.state ?? null);
  const t = await findTicket(rt, id);
  if (reason && t) await escalate(rt, t, reason);
  return reloadTicket(rt, id);
};

/**
 * Prepara una respuesta. Las plantillas se niegan si el hecho no está verificado
 * (p. ej. "despachado" sin comprobante). El envío pasa por el Commercial Guard.
 */
export const replyTicket = async (
  rt: OrderRuntime,
  id: string,
  input: ReplyTicketRequest,
): Promise<Result<SupportTicketDto>> => {
  const t = await findTicket(rt, id);
  if (!t) return notFound('Consulta');
  if (t.status === 'CLOSED') return err(appError('CONFLICT', 'La consulta está cerrada'));
  let body: string;
  if (input.templateKey) {
    if (input.templateKey === 'ESCALATED' && !t.orderId) body = GENERIC_ESCALATION_TEXT;
    else {
      if (!t.orderId)
        return err(appError('CONFLICT', 'Las plantillas de estado requieren un pedido asociado'));
      const facts = await customerFactsOf(rt, t.orderId);
      if (!facts) return notFound('Pedido');
      const rendered = renderCustomerTemplate(input.templateKey, facts);
      if (!rendered.ok) return rendered;
      body = rendered.value;
    }
  } else if (input.faqId) {
    const faq = await rt.db
      .select()
      .from(faqEntries)
      .where(and(eq(faqEntries.id, input.faqId), eq(faqEntries.tenantId, rt.tenantId)))
      .get();
    if (!faq?.active) return notFound('Pregunta frecuente');
    body = faq.answer;
  } else {
    body = input.text ?? '';
  }
  const guard = assertCommercialActionAllowed('send_customer_message', {
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
  });
  await rt.db.insert(supportMessages).values({
    id: newId(),
    tenantId: rt.tenantId,
    ticketId: id,
    direction: 'OUTBOUND',
    body,
    templateKey: input.templateKey ?? null,
    faqId: input.faqId ?? null,
    // Sin integración de envío desde atención: aun habilitado, queda preparada
    // para enviarse por el canal (módulo de mensajes) y se marca como borrador.
    status: guard.ok ? 'DRAFT' : 'BLOCKED',
    detail: guard.ok
      ? 'Respuesta preparada: enviarla desde el canal correspondiente'
      : guard.error.message,
    createdAt: rt.now,
  });
  await rt.db.update(supportTickets).set({ updatedAt: rt.now }).where(eq(supportTickets.id, id));
  return reloadTicket(rt, id);
};

export const escalateTicket = async (rt: OrderRuntime, id: string, reason: string) => {
  const t = await findTicket(rt, id);
  if (!t) return notFound('Consulta');
  await escalate(rt, t, reason);
  return reloadTicket(rt, id);
};

export const closeTicket = async (rt: OrderRuntime, id: string) => {
  const t = await findTicket(rt, id);
  if (!t) return notFound('Consulta');
  await rt.db
    .update(supportTickets)
    .set({ status: 'CLOSED', updatedAt: rt.now })
    .where(eq(supportTickets.id, id));
  return reloadTicket(rt, id);
};

/** Consulta de estado por número de pedido: solo hechos verificados. */
export const orderStatusByNumber = async (rt: OrderRuntime, number: number) => {
  const order = await rt.db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, rt.tenantId), eq(orders.number, number)))
    .get();
  if (!order) return notFound('Pedido');
  const facts = await customerFactsOf(rt, order.id);
  if (!facts) return notFound('Pedido');
  return ok({ orderNumber: number, status: buyerStatusText(facts) });
};

/* ================================ FAQ ================================ */

const toFaqDto = (f: typeof faqEntries.$inferSelect): FaqDto => ({
  id: f.id,
  question: f.question,
  answer: f.answer,
  keywords: f.keywords,
  active: f.active,
});

export const listFaqs = async (rt: OrderRuntime) => (await listFaqRows(rt)).map(toFaqDto);

export const createFaq = async (rt: OrderRuntime, input: CreateFaqRequest) => {
  const row = await rt.db
    .insert(faqEntries)
    .values({
      id: newId(),
      tenantId: rt.tenantId,
      question: input.question,
      answer: input.answer,
      keywords: input.keywords,
      createdAt: rt.now,
      updatedAt: rt.now,
    })
    .returning();
  return row[0] ? ok(toFaqDto(row[0])) : err(appError('INTERNAL_ERROR', 'No se guardó'));
};

export const setFaqActive = async (rt: OrderRuntime, id: string, active: boolean) => {
  const row = await rt.db
    .update(faqEntries)
    .set({ active, updatedAt: rt.now })
    .where(and(eq(faqEntries.id, id), eq(faqEntries.tenantId, rt.tenantId)))
    .returning();
  return row[0] ? ok(toFaqDto(row[0])) : notFound('Pregunta frecuente');
};
