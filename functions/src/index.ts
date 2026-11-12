/** Owlette Cloud Functions entry point. */

import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { onMetricsWrite } from './metricsHistory';
export { onCommandCompleted } from './deploymentStatus';
export { sweepStaleDeployments } from './deploymentSweeper';
export { sweepScheduledRollouts } from './rolloutScheduler';
export { onRoostWritten, onTargetStateWritten } from './distributionFanout';
export { verifyChunk } from './chunkVerify';
export { chunkGcNightly } from './chunkGc';
export { preUploadCheck, reconcileQuota } from './quotaEnforce';
export {
  aggregateTelemetry,
  getUsageSummaryHttp,
  recordUsageEvent,
} from './telemetry';
export {
  exportAuditDaily,
  recordAuditEvent,
  verifyAuditChain,
} from './auditLog';
export { exportSecurityBoundaryAuditDevDaily } from './securityBoundaryAuditExport';
export { emitWebhook, processRetryQueue } from './webhookDispatch';
export { sweepExpiredApiKeysDaily } from './apiKeyExpire';
export { sweepExpiredIdempotencyCacheDaily } from './idempotencyCleanup';
export { onTalonLogEventCreated } from './talonLogEvents';
export { onDeploymentLogCreated } from './deploymentLogRedaction';
// reconcileDeploymentStatus / reconcileDistributionStatus were removed
// 2026-05-30: they triggered on commands/pending, but the agent only writes
// status to commands/completed, so they never fired. onCommandCompleted
// (deploymentStatus.ts) is the canonical deployment reconciler.
