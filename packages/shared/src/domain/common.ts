import { z } from 'zod';

/** Basis points: 0..10000 (10000 = 100 %). */
export const BpsSchema = z.number().int().min(0).max(10_000);
/** Centavos enteros no negativos. */
export const CentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Fecha-hora ISO-8601 con zona. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Origen de un dato: nunca se aceptan datos sin procedencia declarada. */
export const DataSourceSchema = z.enum(['MANUAL', 'SUPPLIER_REPORT', 'INTEGRATION']);
export type DataSource = z.infer<typeof DataSourceSchema>;

export const IdParamSchema = z.uuid();
