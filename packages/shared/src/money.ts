import { z } from 'zod';

/**
 * Montos SIEMPRE en unidades mínimas enteras (centavos) para evitar errores
 * de punto flotante. Nunca usar `number` decimal para dinero.
 */
export const CurrencySchema = z.enum(['ARS', 'USD']);
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.object({
  amountCents: z.number().int(),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

export const money = (amountCents: number, currency: Currency): Money => {
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(`amountCents debe ser un entero seguro, recibido: ${amountCents}`);
  }
  return { amountCents, currency };
};

/** Formatea para mostrar en UI (es-AR). No usar el resultado para cálculos. */
export const formatMoney = (value: Money, locale = 'es-AR'): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(
    value.amountCents / 100,
  );
