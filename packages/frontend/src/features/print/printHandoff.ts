import { createPrintHandoff } from '../../lib/api';

export async function openPrintHandoff(documentId: string): Promise<void> {
  const handoff = await createPrintHandoff(documentId);
  const url = new URL(handoff.printOrigin);
  url.searchParams.set('handoff', handoff.handoffToken || handoff.token);
  url.searchParams.set('mode', handoff.defaultMode);
  url.searchParams.set('source', 'normaldocs');
  window.location.href = url.toString();
}
