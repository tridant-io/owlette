/**
 * Firestore trigger on `sites/{siteId}/logs/{logId}`: cuts every url query string
 * out of a `deployment_failed` row's details. An agent that could not download an
 * installer names the url in its error, and a signed url's query is its
 * credential. Mirrors the agent's `installer_utils.redact_query_strings`, so rows
 * from agents that write the url whole read the same as rows from those that cut it.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';

// the agent's installer_utils._QUERY_STRING
const QUERY_STRING = /\?[^\s'"()]+/g;

export async function redactDeploymentLog(
  data: DocumentData | undefined,
  ref: Pick<DocumentReference, 'update'>,
): Promise<void> {
  if (data?.action !== 'deployment_failed' || typeof data.details !== 'string') return;
  const details = data.details.replace(QUERY_STRING, '?<redacted>');
  if (details !== data.details) await ref.update({ details });
}

export const onDeploymentLogCreated = onDocumentCreated(
  'sites/{siteId}/logs/{logId}',
  async (event) => {
    if (event.data) await redactDeploymentLog(event.data.data(), event.data.ref);
  },
);
