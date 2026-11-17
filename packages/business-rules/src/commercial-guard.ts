import { appError, err, ok, type Result } from '@vc/shared';

/**
 * Tipos de acción con efecto comercial real (dinero, publicaciones, terceros).
 * Toda acción de este tipo DEBE pasar por `assertCommercialActionAllowed`.
 */
export type CommercialAction =
  | 'publish_listing'
  | 'place_supplier_order'
  | 'charge_customer'
  | 'refund_customer'
  | 'send_customer_message';

export interface CommercialGuardContext {
  readonly commercialActionsEnabled: boolean;
}

/**
 * Interruptor maestro. Mientras `COMMERCIAL_ACTIONS_ENABLED` sea false, todas las
 * acciones comerciales se rechazan y el sistema opera en modo simulación (dry-run).
 */
export const assertCommercialActionAllowed = (
  action: CommercialAction,
  ctx: CommercialGuardContext,
): Result<{ action: CommercialAction }> =>
  ctx.commercialActionsEnabled
    ? ok({ action })
    : err(
        appError(
          'COMMERCIAL_ACTIONS_DISABLED',
          `Acción comercial "${action}" bloqueada: el sistema está en modo simulación`,
        ),
      );
