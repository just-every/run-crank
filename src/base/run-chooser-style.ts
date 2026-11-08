// /run only. Shared document/header styles remain in run-site.ts.
export const RUN_CHOOSER = `
body{--art:max(20vh,150px);overflow-x:visible;--code-bg:var(--rer-code-background,var(--site-ink));--code-ink:var(--rer-code-text,var(--rer-page,#f3f5f8));--surface:var(--rer-surface,#fff);--done:var(--rer-done,var(--site-ink));--done-ink:color-mix(in srgb,var(--rer-done-ink,var(--site-ink)) 80%,var(--site-ink))}
main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px)}
.intro{text-align:center;padding-top:28px}.intro h1{font-size:64px;line-height:1.06;font-weight:700;overflow-wrap:anywhere}
.chooser{container:chooser / inline-size;max-width:980px;margin:28px auto 0;min-width:0}
.self{container:self / inline-size;position:relative;min-width:0;padding:28px 32px;border-radius:var(--rer-radius,18px);background:var(--surface);border:1px solid var(--site-line);box-shadow:0 24px 48px -36px color-mix(in srgb,var(--site-ink) 45%,transparent)}
.badge,.chip{display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:999px;font-size:13px;line-height:1;font-weight:600}
.badge{background:color-mix(in srgb,var(--done) 14%,var(--surface));color:var(--done-ink)}
h2{font-family:var(--rer-font-heading,var(--rer-font-body,inherit));font-weight:700;color:var(--site-ink)}
.self h2{margin-top:10px;font-size:28px;line-height:1.15;letter-spacing:-.02em}
.self-body{overflow-wrap:anywhere;max-width:34em;margin-top:6px;color:var(--site-body);font-size:17px;line-height:1.5}
.chooser a{color:var(--rer-link,var(--site-ink));text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.chooser a svg{display:inline-block;width:16px;height:16px;margin-left:6px;vertical-align:-2px}
.guide{margin-top:18px;font-size:16px;font-weight:600}.guide a{display:inline-block;padding:6px 0}
.code{position:relative;container:code / inline-size;margin-top:20px;border-radius:12px;background:var(--code-bg);color:var(--code-ink)}
.code pre{margin:0;padding:16px 128px 16px 20px;font:500 15px/1.6 var(--site-mono)}.chooser .self .code pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:visible}.code pre code{font:inherit;color:inherit}
.code-word{white-space:nowrap}.code-repo{display:inline-block;max-width:100%;vertical-align:top;white-space:normal;overflow-wrap:anywhere}
.chooser .code .copy{position:absolute;top:50%;right:12px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 18px;border:0;border-radius:999px;background:var(--code-ink);color:var(--code-bg);font:600 15px/1 var(--rer-font-body,inherit);cursor:pointer}
.chooser .code .copy[hidden]{display:none}.chooser .code .copy::after{content:'';position:absolute;inset:-3px 0}
.chooser .code .copy:hover{background:color-mix(in srgb,var(--code-bg) 14%,var(--code-ink))}.chooser .code .copy:focus-visible{outline:2px solid var(--code-ink);outline-offset:3px;border-radius:999px}
.chooser .code .copy svg{display:none;width:15px;height:15px;fill:none;stroke:var(--done-ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.chooser .code .copy[data-copied] svg{display:block}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.paste-panel{display:none;margin-top:12px;padding:18px 20px;border-radius:12px;background:color-mix(in srgb,var(--site-ink) 4%,var(--surface))}
.paste-panel h3{margin:0;color:var(--site-ink);font-size:16px;line-height:1.3;font-weight:600}
.self[data-copied] .paste-panel{display:block;animation:reveal 150ms ease-out}.self[data-copied] .timeline{display:none}
@keyframes reveal{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.self[data-copied] .paste-panel{animation:none}}
.other-ways{margin-top:16px}.other-ways pre{margin:0;max-width:100%;overflow-x:auto}.chooser .self .other-ways pre code{white-space:pre}.other-ways summary{cursor:pointer;color:var(--site-body);font-size:15px;text-decoration:underline;text-underline-offset:3px}
.alt{display:grid;gap:2px;margin-top:16px;color:var(--site-body);font-size:15px;line-height:1.5}.alt code{font:400 15px/1.5 var(--site-mono);color:var(--site-ink)}
.chooser .self .alt code{width:auto;overflow:visible;white-space:normal}
.requirements,.email-note{margin-top:8px;color:var(--site-body);font-size:14px;line-height:1.5}
.timeline{margin-top:20px}.timeline-stops,.paste-stops{display:grid;gap:12px;list-style:none;margin:0;padding:0}
.timeline-stops li,.paste-stops li{position:relative;display:grid;grid-template-columns:16px minmax(0,1fr);gap:12px;align-items:start;min-width:0}
.stop{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;width:14px;height:14px;margin-top:3px;background:var(--surface);border:1.5px solid color-mix(in srgb,var(--rer-border,#64748b) 55%,transparent);border-radius:50%}
.timeline-stops li:not(:last-child)::after,.paste-stops li:not(:last-child)::after{content:'';position:absolute;top:10px;bottom:-22px;left:6.5px;width:1px;background:var(--site-line)}
.timeline-stops li:last-child .stop{width:16px;height:16px;margin-left:-1px;background:var(--done);border:0}
.stop svg{width:10px;height:10px;fill:none;stroke:var(--rer-on-done,var(--surface));stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.stop-label{color:var(--site-body);font-size:15px;line-height:1.4;overflow-wrap:anywhere}.timeline-stops li:last-child .stop-label{font-weight:600;color:var(--site-ink)}
.track-note{margin:12px 0 0 28px;color:var(--site-body);font-size:14px;line-height:1.4}.track-divider{display:none}
.paste-track{margin-top:14px}.paste-stops{gap:10px}.paste-stops li{grid-template-columns:22px minmax(0,1fr)}
.paste-stops .stop{width:22px;height:22px;margin:0;border:0;background:color-mix(in srgb,var(--site-ink) 9%,var(--surface));color:var(--site-ink);font-size:13px;font-weight:700}
.paste-stops .stop-label{color:var(--site-ink);font-size:15px}.paste-stops li:not(:last-child)::after{left:10.5px}.paste-track .track-note{margin-left:34px}
.doors{display:grid;gap:12px;margin-top:12px}.door{min-width:0;padding:24px 28px;border-radius:var(--rer-radius,18px);background:color-mix(in srgb,var(--surface) 40%,transparent);border:1px solid var(--site-line)}
.door-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}.door h2{font-size:22px;line-height:1.2;letter-spacing:-.015em}
.chip{color:var(--site-body);background:color-mix(in srgb,var(--site-ink) 8%,var(--surface))}
.door-body{margin-top:6px;color:var(--site-body);font-size:16px;line-height:1.5}.price{margin-top:10px;color:var(--site-body);font-size:15px;line-height:1.4}
.door-action{margin-top:12px;font-size:16px;font-weight:600}.door-action a{display:inline-block;padding:6px 0}
.quiet{display:grid;gap:6px;margin-top:26px;text-align:center;color:var(--site-body);font-size:14px;line-height:1.5}.quiet a{font-weight:600}
.facts{margin-top:18px;text-align:center;color:var(--site-body);font-size:13px;overflow-wrap:anywhere}
@container chooser (min-width:640px){.doors{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px}}
@container self (min-width:600px){.self-heading{padding-right:200px}.guide{position:absolute;top:53px;right:32px;margin:0}}
@container self (min-width:720px){
.timeline,.paste-track{display:grid;grid-template-columns:minmax(0,1fr) 1px 132px;gap:20px;align-items:start;margin-top:24px}
.timeline-stops{grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,1.6fr);gap:12px}
.timeline-stops li,.paste-stops li{display:flex;flex-direction:column;align-items:center;gap:0;text-align:center}
.timeline-stops li:not(:last-child)::after,.paste-stops li:not(:last-child)::after{top:8px;left:50%;right:calc(-50% - 12px);bottom:auto;width:auto;height:1px}
.timeline-stops .stop{width:16px;height:16px;margin:0}.timeline-stops li:last-child .stop{width:18px;height:18px;margin:-1px 0}
.stop-label{margin-top:10px;font-size:13px;line-height:1.35}.track-divider{display:block;width:1px;height:44px;background:var(--site-line)}
.track-note,.paste-track .track-note{margin:0;font-size:13px}
.paste-track{grid-template-columns:minmax(0,1fr) 132px;margin-top:14px}.paste-stops{grid-template-columns:repeat(3,minmax(0,1fr)) minmax(0,1.6fr);gap:12px}
.paste-stops .stop-label{font-size:14px}.paste-stops li:not(:last-child)::after{top:10.5px}
}
@container code (max-width:700px){.code pre{padding:58px 20px 16px}.chooser .code .copy{top:10px;right:10px;transform:none;min-height:40px;padding:0 16px}}
@container code (max-width:480px){.code pre{padding:58px 14px 14px;font-size:14px}}
@media(max-width:760px){
body{--art:180px}main{padding:0 16px calc(var(--art) + 40px)}.intro{text-align:left;padding-top:24px}.intro h1{font-size:40px;line-height:1.08}
.chooser{margin-top:20px}.self{padding:20px 18px 22px}.self h2{font-size:24px;line-height:1.2}.self-body{font-size:16px}
.code{margin-top:16px}.alt{margin-top:14px}.alt code{font-size:14px}.door{padding:20px 18px}.door h2{font-size:20px}
.quiet{margin-top:22px;text-align:left}.facts{text-align:left}
}
`
