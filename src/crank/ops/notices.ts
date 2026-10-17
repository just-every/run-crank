import { operatorMail } from '../../mail.server.mjs'
import { digest, now, stmt, type CrankEnv } from '../model'

/** EXEC-003 owner notices: deduplicated by key, delivered by email through the
 * installation's mail transport, and kept with their delivery outcome. */
export async function notify(env: CrankEnv, notice: { key: string; workflowId?: string | null; kind: string; subject: string; text: string; link?: string }) {
  const recipient = await stmt(env, `SELECT o.email FROM oa_operators o WHERE o.status='active' AND o.id=COALESCE((SELECT owner_id FROM crank_workflows WHERE id=?),
    (SELECT id FROM oa_operators WHERE role='owner' AND status='active' ORDER BY created_at LIMIT 1))`, notice.workflowId ?? null).first<{ email: string }>()
  if (!recipient) return false
  const inserted = await stmt(env, 'INSERT INTO crank_notices(dedupe_key,workflow_id,kind,subject,recipient,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    notice.key, notice.workflowId ?? null, notice.kind, notice.subject, recipient.email, now()).run()
  if (inserted.meta.changes !== 1) return false
  const link = notice.link ? new URL(notice.link, env.AUTH_ORIGIN).href : null
  const body = link ? `${notice.text}\n\nOpen: ${link}` : notice.text
  let failure: string | null = null
  try {
    const sender = operatorMail(env)
    if (!sender) failure = 'mail_not_configured'
    else {
      const result = await sender.send({ deliveryId: 'crank-notice-' + (await digest(notice.key)).slice(0, 40), from: env.MAIL_FROM ?? 'Crank <crank@localhost.invalid>', to: [recipient.email], subject: notice.subject, text: body, html: `<p>${body.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)).replace(/\n/g, '<br>')}</p>`, headers: { 'Auto-Submitted': 'auto-generated' } })
      if (result?.status !== 'accepted' && result?.status !== 'development') failure = 'mail_' + (result?.status ?? 'unconfirmed')
    }
  } catch { failure = 'mail_unavailable' }
  await stmt(env, 'UPDATE crank_notices SET delivered=?,failure=? WHERE dedupe_key=?', failure ? 0 : 1, failure, notice.key).run()
  return !failure
}
