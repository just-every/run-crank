import { accentInk } from '../../branding.mjs';
import { escapeHtml } from '../../http.mjs';

export function linkMessage(config, token, url) {
  const { productName, accentColor } = config.branding;
  const invitation = token.kind === 'invite', stepUp = token.kind === 'step_up';
  const action = invitation ? 'accept your invitation to' : stepUp ? 'confirm a sensitive change in' : 'sign in to';
  const minutes = config.linkSeconds / 60;
  const expiry = `This link works once and expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const heading = invitation ? `Accept your invitation to ${productName}` : stepUp ? `Confirm it's you in ${productName}` : `Confirm sign-in to ${productName}`;
  return {
    subject: invitation ? `You're invited to ${productName}` : stepUp ? `Confirm it's you in ${productName}` : `Your sign-in link for ${productName}`,
    text: `Open this link to review and confirm. On the confirmation page, press Confirm to ${action} ${productName}. ${expiry}\n\n${url}`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head><body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#172033"><main style="max-width:480px;margin:0 auto;padding:32px 24px"><h1>${escapeHtml(heading)}</h1><p>Open this link to review and confirm. On the confirmation page, press Confirm to ${action} ${escapeHtml(productName)}.</p><p>${expiry}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 24px;border:1px solid #64748b;border-radius:8px;background:${accentColor};color:${accentInk(accentColor)};font-family:Arial,sans-serif;font-weight:bold;text-decoration:none">Confirm</a></p></main></body></html>`,
  };
}
