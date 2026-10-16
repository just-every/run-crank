// Base's no-JavaScript documents (first-run /setup, the foundation sign-in)
// wear a seed's theme by linking its served rer-theme.css, whose --rer-* tokens
// this frame style maps onto the document; each token falls back to a readable
// neutral if the file cannot load. Without a theme nothing is added.
// This file is copied unchanged to src/base by both maintained exporters.
/** `accentColor` (#rrggbb) colours buttons when the theme declares no --rer-accent. */
export interface FrameTheme { href: string; productName?: string; accentColor?: string }
export interface Frame { htmlClass: string; head: string; brand: string; policy: string }

const FRAME_STYLE = '.rer-themed body{box-sizing:border-box;margin:0;min-height:100vh;padding:48px 20px;background:var(--rer-page,#f3f5f8);color:var(--rer-text,#172033);font-family:var(--rer-font-body,inherit);line-height:1.6}'
  + '.rer-themed main{box-sizing:border-box;max-width:480px;margin:0 auto;padding:36px;background:var(--rer-surface,#fff);border-radius:var(--rer-radius,20px);box-shadow:0 1px 2px #0000000d,0 14px 36px #00000014;overflow-wrap:anywhere}'
  + '.rer-themed h1{font-family:var(--rer-font-heading,var(--rer-font-body,inherit));font-size:30px;line-height:1.25;letter-spacing:-.01em;margin:0 0 16px;text-wrap:balance}'
  + '.rer-themed p,.rer-themed dt{color:var(--rer-muted,#475569)}.rer-themed p{margin:0 0 20px;text-wrap:pretty}'
  + '.rer-themed dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;margin:0 0 24px}.rer-themed dd{margin:0;color:var(--rer-text,#172033)}'
  + '.rer-themed form{display:grid;gap:16px;margin:0}.rer-themed form p{margin:0}'
  + '.rer-themed label{display:grid;gap:6px;color:var(--rer-text,#172033);font-weight:500}.rer-themed label:has(input[type=checkbox]){display:flex;gap:10px;align-items:flex-start;font-weight:400}'
  + '.rer-themed input:not([type=checkbox]):not([type=hidden]){box-sizing:border-box;width:100%;min-height:46px;padding:10px 14px;border:1px solid var(--rer-border,#64748b);border-radius:calc(var(--rer-radius,20px) / 2);background:var(--rer-surface,#fff);color:var(--rer-text,#172033);font:inherit}'
  + '.rer-themed input[type=checkbox]{flex:none;width:20px;height:20px;margin:3px 0 0;accent-color:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)))}'
  + '.rer-themed button{display:block;width:100%;min-height:48px;padding:12px 20px;border:0;border-radius:var(--rer-radius,12px);background:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)));color:var(--rer-accent-text,var(--rer-brand-accent-text,var(--rer-surface,#fff)));font:inherit;font-weight:600;cursor:pointer}'
  + '.rer-themed a{color:var(--rer-link,var(--rer-text,#172033))}.rer-themed :focus-visible{outline:3px solid var(--rer-focus,#172033);outline-offset:3px}'
  + '.rer-themed .rer-brand{display:flex;align-items:center;gap:12px;margin:0 0 28px;color:var(--rer-text,#172033);font-family:var(--rer-font-heading,var(--rer-font-body,inherit));font-size:18px;font-weight:600}'
  // content toggles the mark only when --rer-logo is declared; the background draws it at size.
  + '.rer-themed .rer-brand::before{content:var(--rer-logo,none);display:block;flex:none;width:32px;height:32px;overflow:hidden;text-indent:200%;white-space:nowrap;background:var(--rer-logo) center/contain no-repeat}'
  + '@media(max-width:480px){.rer-themed body{padding:24px 16px}.rer-themed main{padding:28px 20px}.rer-themed h1{font-size:26px}}'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
const hashes = new Map<string, Promise<string>>()
// WCAG relative luminance picks readable button text for the branding accent.
export const ink = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0) > 0.179 ? '#000000' : '#ffffff'
const digest = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))

/** `policy` is the document's style/font/image CSP: the hashed frame style plus same-origin theme files. */
export async function themeFrame(theme?: FrameTheme): Promise<Frame> {
  if (!theme) return { htmlClass: '', head: '', brand: '', policy: "style-src 'self'; font-src 'self'" }
  if (!/^\/(?!\/)[A-Za-z0-9._~/-]{1,200}\.css$/.test(theme.href) || theme.href.includes('/.')) throw new Error('Declare the seed theme as a same-origin path to its served .css file.')
  if (theme.accentColor !== undefined && !/^#[0-9a-f]{6}$/i.test(theme.accentColor)) throw new Error('A frame accent colour is #rrggbb.')
  const style = (theme.accentColor ? `.rer-themed{--rer-brand-accent:${theme.accentColor};--rer-brand-accent-text:${ink(theme.accentColor)}}` : '') + FRAME_STYLE
  if (!hashes.has(style)) hashes.set(style, digest(style))
  return {
    htmlClass: ' class="rer-themed"',
    head: `<link rel="stylesheet" href="${theme.href}"><style>${style}</style>`,
    brand: theme.productName ? `<p class="rer-brand"><span data-rer-name>${escape(theme.productName)}</span></p>` : '',
    policy: `style-src 'self' 'sha256-${await hashes.get(style)}'; font-src 'self'; img-src 'self'`,
  }
}
