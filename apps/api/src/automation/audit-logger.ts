import { auditEvents, type Database } from '@vc/database';
import { redact } from '@vc/security';
import { newId } from '@vc/shared';
import type { Clock } from './types';

export interface AuditEntry {
  readonly tenantId: string | null;
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Audit Logger: registro append-only en `audit_events`. Los metadatos pasan por
 * `redact()`. Todo lo del motor de automatización se marca `dry_run = true`
 * mientras las acciones comerciales sigan deshabilitadas.
 */
export class AuditLogger {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditEvents).values({
        id: newId(),
        tenantId: entry.tenantId,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: (entry.metadata ? redact(entry.metadata) : null) as Record<
          string,
          unknown
        > | null,
        dryRun: true,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      // La auditoría nunca debe tumbar el trabajo; queda en los logs del Worker.
      console.error('No se pudo registrar auditoría', {
        action: entry.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
