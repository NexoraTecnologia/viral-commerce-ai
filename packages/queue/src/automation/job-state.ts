import type { JobStatus } from '@vc/shared';

/** Transiciones válidas del ciclo de vida de un trabajo. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  SCHEDULED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'RETRYING', 'DEAD_LETTER'],
  RETRYING: ['RUNNING', 'CANCELLED', 'DEAD_LETTER'],
  COMPLETED: [],
  FAILED: ['RETRYING'],
  CANCELLED: [],
  DEAD_LETTER: ['RETRYING'],
};

/** Estados desde los que un trabajo puede ser tomado para ejecutar. */
export const CLAIMABLE_STATUSES = [
  'PENDING',
  'SCHEDULED',
  'RETRYING',
] as const satisfies readonly JobStatus[];

export const TERMINAL_STATUSES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DEAD_LETTER',
] as const satisfies readonly JobStatus[];

export const canTransitionJob = (from: JobStatus, to: JobStatus): boolean =>
  JOB_TRANSITIONS[from].includes(to);

export const isTerminal = (s: JobStatus): boolean =>
  (TERMINAL_STATUSES as readonly JobStatus[]).includes(s);

/** Prioridad: menor = más urgente. Los eventos comerciales van primero. */
export const PRIORITY = {
  COMMERCIAL: 10,
  HIGH: 30,
  NORMAL: 50,
  LOW: 80,
} as const;
