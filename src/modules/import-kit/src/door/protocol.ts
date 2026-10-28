export type DoorAction = 'uploads' | 'plan' | 'apply' | 'status' | 'reconcile' | 'undo' | 'cancel' | 'archive' | 'restore-check';
/** Grant-only actions: the owner-session mount answers them 404. */
export const GRANT_ONLY_ACTIONS: readonly DoorAction[] = ['cancel', 'archive', 'restore-check'];

export interface DoorGrant {
  v: 1;
  iss: string;
  aud: string;
  installationId: string;
  email: string;
  jti: string;
  iat: number;
  exp: number;
  action: DoorAction;
  namespace: string;
  maxBytes: number;
  maxChunks: number;
  maxRecords: number;
  fingerprint?: string;
  approvalRecordId?: string;
  approvedAt?: string;
  catchup?: 'bounded';
}

export class DoorError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status = 403, details?: Record<string, unknown>) {
    super(code);
    this.name = 'DoorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

