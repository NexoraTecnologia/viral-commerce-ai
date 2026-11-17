import { z } from 'zod';

/** Contratos HTTP compartidos entre apps/api y apps/dashboard. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('viralcommerce-api'),
  version: z.string(),
  environment: z.enum(['development', 'staging', 'production']),
  commercialActionsEnabled: z.boolean(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const API_VERSION = '0.1.0';
