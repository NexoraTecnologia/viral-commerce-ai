import type { OrderStatus } from '@vc/shared';

/**
 * Normaliza el estado de una orden de Mercado Libre. Siempre se conserva el estado
 * original (`rawStatus`); lo no reconocido queda OTHER: no se adivina.
 */
export const normalizeMercadoLibreOrderStatus = (raw: string): OrderStatus => {
  switch (raw) {
    case 'confirmed':
      return 'CONFIRMED';
    case 'payment_required':
    case 'payment_in_process':
    case 'partially_paid':
      return 'PAYMENT_PENDING';
    case 'paid':
      return 'PAID';
    case 'cancelled':
    case 'invalid':
      return 'CANCELLED';
    default:
      return 'OTHER';
  }
};
