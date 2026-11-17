import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runOrderSimulation, SIMULATION_SCENARIOS } from '@vc/business-rules';
import {
  appError,
  CancelOrderRequestSchema,
  CreateFaqRequestSchema,
  CreateOrderRequestSchema,
  CreateTicketRequestSchema,
  EscalateTicketRequestSchema,
  OrderStateSchema,
  RecordFundsSnapshotRequestSchema,
  RecordLedgerEntryRequestSchema,
  RecordPaymentRequestSchema,
  RegisterShipmentRequestSchema,
  ReplyTicketRequestSchema,
  RequestDispatchRequestSchema,
  RequestReturnSchema,
  ResolveReviewRequestSchema,
  ReturnDecisionSchema,
  ReturnReceivedSchema,
  ShipmentEventRequestSchema,
  SimulationScenarioSchema,
  SupplierResponseRequestSchema,
} from '@vc/shared';
import type { AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import * as svc from './service';
import * as support from './support';

const rtOf = (c: Context<AppBindings>): svc.OrderRuntime => ({
  db: c.var.db,
  tenantId: c.var.tenantId,
  config: c.var.config,
  now: new Date(),
});

/** POST /:id/<accion> con cuerpo validado. */
const withBody =
  <S extends z.ZodType>(
    schema: S,
    fn: (rt: svc.OrderRuntime, id: string, body: z.output<S>) => Promise<unknown>,
  ) =>
  async (c: Context<AppBindings>) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, schema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, (await fn(rtOf(c), id.value, body.value)) as Parameters<typeof respond>[1]);
  };

export const orderRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const raw = c.req.query('state');
    const state = raw === undefined ? undefined : OrderStateSchema.safeParse(raw);
    if (state && !state.success) return fail(c, appError('VALIDATION_ERROR', 'Estado inválido'));
    return c.json({ items: await svc.listOrders(rtOf(c), state?.data) });
  })
  .post('/', async (c) => {
    const body = await readJson(c, CreateOrderRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.createOrder(rtOf(c), body.value), 201);
  })

  /* ---- Simulaciones (en memoria, sin efectos) ---- */
  .get('/simulations', (c) => c.json({ items: SIMULATION_SCENARIOS }))
  .post('/simulations/:scenario', (c) => {
    const s = SimulationScenarioSchema.safeParse(c.req.param('scenario'));
    if (!s.success) return fail(c, appError('NOT_FOUND', 'Escenario inexistente'));
    return c.json(runOrderSimulation(s.data, new Date()));
  })

  .get('/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.getOrderDetail(rtOf(c), id.value));
  })
  .post('/:id/advance', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.advanceOrder(rtOf(c), id.value, 'USER'));
  })
  .post(
    '/:id/payments',
    withBody(RecordPaymentRequestSchema, (rt, id, b) => svc.recordPayment(rt, id, b)),
  )
  .post(
    '/:id/dispatch-request',
    withBody(RequestDispatchRequestSchema, (rt, id, b) => svc.requestDispatch(rt, id, b)),
  )
  .post(
    '/:id/supplier-response',
    withBody(SupplierResponseRequestSchema, (rt, id, b) => svc.recordSupplierResponse(rt, id, b)),
  )
  .post(
    '/:id/shipments',
    withBody(RegisterShipmentRequestSchema, (rt, id, b) => svc.registerShipment(rt, id, b)),
  )
  .post(
    '/:id/shipment-events',
    withBody(ShipmentEventRequestSchema, (rt, id, b) => svc.recordShipmentEvent(rt, id, b)),
  )
  .post(
    '/:id/cancel',
    withBody(CancelOrderRequestSchema, (rt, id, b) => svc.cancelOrder(rt, id, b.reason)),
  )
  .post(
    '/:id/returns',
    withBody(RequestReturnSchema, (rt, id, b) => svc.requestReturn(rt, id, b.reason)),
  )
  .post(
    '/:id/returns/decision',
    withBody(ReturnDecisionSchema, (rt, id, b) => svc.decideReturn(rt, id, b.decision, b.note)),
  )
  .post(
    '/:id/returns/received',
    withBody(ReturnReceivedSchema, (rt, id, b) => svc.receiveReturn(rt, id, b.evidenceRef)),
  )
  .post('/:id/refund-execution', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.requestRefundExecution(rtOf(c), id.value));
  })
  .post(
    '/:id/resolve',
    withBody(ResolveReviewRequestSchema, (rt, id, b) => svc.resolveReview(rt, id, b)),
  )
  .post(
    '/:id/ledger',
    withBody(RecordLedgerEntryRequestSchema, (rt, id, b) => svc.recordLedgerEntry(rt, id, b)),
  );

/* ================================ Fondos ================================ */

export const fundsRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json({ items: await svc.listFunds(rtOf(c)) }))
  .post('/', async (c) => {
    const body = await readJson(c, RecordFundsSnapshotRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.recordFunds(rtOf(c), body.value), 201);
  });

/* ============================ Atención al cliente ============================ */

export const supportRoutes = new Hono<AppBindings>()
  .get('/tickets', async (c) => c.json({ items: await support.listTickets(rtOf(c)) }))
  .post('/tickets', async (c) => {
    const body = await readJson(c, CreateTicketRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await support.createTicket(rtOf(c), body.value), 201);
  })
  .post(
    '/tickets/:id/reply',
    withBody(ReplyTicketRequestSchema, (rt, id, b) => support.replyTicket(rt, id, b)),
  )
  .post(
    '/tickets/:id/escalate',
    withBody(EscalateTicketRequestSchema, (rt, id, b) => support.escalateTicket(rt, id, b.reason)),
  )
  .post('/tickets/:id/close', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await support.closeTicket(rtOf(c), id.value));
  })
  .get('/order-status/:number', async (c) => {
    const n = z.coerce.number().int().positive().safeParse(c.req.param('number'));
    if (!n.success) return fail(c, appError('NOT_FOUND', 'Pedido inexistente'));
    return respond(c, await support.orderStatusByNumber(rtOf(c), n.data));
  })
  .get('/faqs', async (c) => c.json({ items: await support.listFaqs(rtOf(c)) }))
  .post('/faqs', async (c) => {
    const body = await readJson(c, CreateFaqRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await support.createFaq(rtOf(c), body.value), 201);
  })
  .patch(
    '/faqs/:id',
    withBody(z.object({ active: z.boolean() }), (rt, id, b) =>
      support.setFaqActive(rt, id, b.active),
    ),
  );
