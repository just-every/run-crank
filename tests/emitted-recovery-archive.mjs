import assert from 'node:assert/strict';

/** BASE-003: a real bounded archive job survives executor loss between chunks;
 * every transition and byte crosses the owner's public Data door. */
export async function archiveRecovery(h) {
  const invitation = await h.send('/auth/invite', { email: 'recovery-member@example.test', displayName: 'Recovery reader', role: 'member' });
  assert.equal(invitation.status, 202);
  const message = (await h.command('mail')).findLast(message => message.to.includes('recovery-member@example.test'));
  const token = new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), 'http://acceptance.test').searchParams.get('token');
  const member = await h.send('/auth/confirm', { token }, '');
  assert.equal(member.status, 303); assert.ok(member.cookie);
  for (const cookie of ['', member.cookie]) assert.equal((await h.send('/api/crank/data/transfers',{kind:'export'},cookie)).status,cookie?403:401);
  const job = await h.post('data/transfers',{kind:'export'},201);
  assert.equal(job.phase,'building'); assert.equal(job.completed,0);
  await h.restart(); // Actual SIGKILL while the durable transfer is active.
  assert.equal((await h.get('data/transfers')).find(t=>t.id===job.id).phase,'building');
  const path = `data/transfers/${job.id}`;
  for (const cookie of ['', member.cookie]) {
    assert.equal((await h.send('/api/crank/'+path+'/advance',{maxParts:1},cookie)).status,cookie?403:401);
    assert.equal((await h.send('/api/crank/'+path+'/download',undefined,cookie)).status,cookie?403:401);
    assert.equal((await h.send('/api/crank/'+path+'/abort',{},cookie)).status,cookie?403:401);
  }
  await h.post(path+'/advance',{maxParts:0},400);
  let status = await h.post(path+'/advance',{maxParts:1});
  await h.restart(); // Retained completed parts and cursor survive another kill.
  assert.equal((await h.get('data/transfers')).find(t=>t.id===job.id).completed,status.completed);
  while(status.phase==='building') status=await h.post(path+'/advance',{maxParts:1});
  assert.equal(status.phase,'complete');
  const first=await h.send('/api/crank/'+path+'/download');
  assert.equal(first.status,200); assert.ok(first.text.includes('"kind":"closing"'));
  await h.restart();
  const second=await h.send('/api/crank/'+path+'/download');
  assert.equal(second.status,200); assert.equal(second.text,first.text,'resumed download has identical bytes');
  const audit=await h.get(`audit?kind=archive_transfer&id=${job.id}`);
  assert.equal(audit.filter(r=>r.action==='data.export').length,1);
  assert.equal(audit.filter(r=>r.action==='data.transfer.download').length,2);
  const aborted=await h.post('data/transfers',{kind:'export'},201);
  await h.restart();
  assert.equal((await h.post(`data/transfers/${aborted.id}/abort`)).phase,'aborted');
  assert.equal((await h.get('data/transfers')).find(t=>t.id===aborted.id).retained_parts,0);
  const abortAudit=await h.get(`audit?kind=archive_transfer&id=${aborted.id}`);
  assert.equal(abortAudit.filter(r=>r.action==='data.transfer.abort').length,1);
  await h.post(`data/transfers/${aborted.id}/advance`,{maxParts:1},409);
  const report=await h.get('reports/operations');
  assert.ok(report.recovery.backup.last_generated_at);
  assert.equal(report.recovery.backup.verified_external_copy,false,'archive generation never establishes external custody');
}
