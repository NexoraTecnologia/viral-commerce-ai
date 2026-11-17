import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

export const CreateTenantRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'Slug: minúsculas, números y guiones'),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const TenantDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type TenantDto = z.infer<typeof TenantDtoSchema>;

export const listOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
