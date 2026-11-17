import { Hono } from 'hono';
import {
  ChangeSupplierStatusRequestSchema,
  CreateSupplierRequestSchema,
  RecordEvidenceRequestSchema,
  ReviewEvidenceRequestSchema,
  UpdateSupplierRequestSchema,
} from '@vc/shared';
import type { AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import {
  changeSupplierStatus,
  createSupplier,
  getSupplierDetail,
  listSuppliers,
  recordEvidence,
  reviewEvidence,
  updateSupplier,
} from './service';

export const supplierRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json({ items: await listSuppliers(c.var.db, c.var.tenantId) }))

  .post('/', async (c) => {
    const body = await readJson(c, CreateSupplierRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return c.json(await createSupplier(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })

  .get('/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await getSupplierDetail(c.var.db, c.var.tenantId, id.value, new Date()));
  })

  .patch('/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateSupplierRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await updateSupplier(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
    );
  })

  .post('/:id/evidence', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordEvidenceRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordEvidence(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })

  .post('/:id/evidence/:evidenceId/review', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const evidenceId = idParam(c, 'evidenceId');
    if (!evidenceId.ok) return fail(c, evidenceId.error);
    const body = await readJson(c, ReviewEvidenceRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await reviewEvidence(
        c.var.db,
        c.var.tenantId,
        id.value,
        evidenceId.value,
        body.value,
        new Date(),
      ),
    );
  })

  .post('/:id/status', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, ChangeSupplierStatusRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await changeSupplierStatus(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
    );
  });
