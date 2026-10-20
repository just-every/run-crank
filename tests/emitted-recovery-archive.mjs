import assert from 'node:assert/strict';

/** Observe a real export snapshot, kill its process, then reconcile through
 * the owner's transfer doors. Application state is never injected by IPC. */
export async function archiveRecovery(h, flow, time, inFlight) {
  // A few real pending runs keep the streaming snapshot large enough to inspect
  // its durable building phase before killing the executor. They send nothing.
  for (let index = 0; index < 5; index++) await h.post(`flows/${flow.id}/runs`, {
    event_id: 'archive-process-loss-' + index, input: { invoice: 'INV-ARCHIVE-' + index, note: 'acceptance-data '.repeat(2000) },
  }, 201);
  const invitation = await h.send('/auth/invite', { email: 'recovery-member@example.test', displayName: 'Recovery reader', role: 'member' });
  assert.equal(invitation.status, 202);
  const message = (await h.command('mail')).findLast(message => message.to.includes('recovery-member@example.test'));
  assert.ok(message, 'native invitation reaches the mail network edge');
  const link = message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/);
  assert.ok(link);
  const token = new URL(link[1].replaceAll('&amp;', '&'), 'http://acceptance.test').searchParams.get('token');
  const member = await h.send('/auth/confirm', { token }, '');
  assert.equal(member.status, 303); assert.ok(member.cookie);

  await h.get('data/transfers'); // Initialize Base's real portability tables.
  const observed = h.command('await-building-export');
  const download = inFlight(h.send('/api/crank/data/export', {}));
  const building = await observed;
  assert.equal(building.phase, 'building');
  await h.restart();
  assert.ok((await download).error, 'killing an in-flight export interrupts its HTTP response');
  const transfer = (await h.get('data/transfers')).find(job => job.id === building.id);
  assert.ok(transfer, 'the interrupted export remains visible after restart');
  assert.equal(transfer.phase, 'building', 'an interrupted export never claims completion');
  const before = await h.get('reports/operations');
  const operation = before.recovery.operations.find(job => job.kind === 'archive.export');
  assert.ok(operation); assert.equal(operation.status, 'running');
  assert.equal(before.recovery.backup.last_generated_at, null);
  assert.equal(before.recovery.backup.verified_external_copy, false);
  const path = `/api/crank/data/transfers/${building.id}/abort`;
  assert.equal((await h.send(path, {}, '')).status, 401);
  assert.equal((await h.send(path, {}, member.cookie)).status, 403);
  assert.equal((await h.get('data/transfers')).find(job => job.id === building.id).phase, 'building', 'refused callers do not abort the export');
  const aborted = await h.post(`data/transfers/${building.id}/abort`);
  assert.equal(aborted.phase, 'aborted');
  const audit = await h.get(`audit?kind=archive_transfer&id=${building.id}`);
  assert.equal(audit.filter(row=>row.action==='data.transfer.abort' && row.detail.kind==='export').length,1);
  await h.command('tick', { time: time + 40 * 60000 });
  const reconciled = await h.get('reports/operations');
  assert.equal(reconciled.recovery.operations.find(job => job.id === operation.id).status, 'interrupted');
  const archive = await h.send('/api/crank/data/export', {});
  assert.equal(archive.status, 200);
  const after = await h.get('reports/operations');
  assert.ok(after.recovery.backup.last_generated_at);
  assert.equal(after.recovery.backup.verified_external_copy, false, 'archive generation does not establish external custody');
  assert.equal((await h.get('data/transfers')).find(job => job.id === building.id).phase, 'aborted');
}
