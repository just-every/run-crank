// The one dropdown rule for Base's own screens, shared by the default seed and
// the foundation template and copied to src/base by both exporters (the same rule
// is in onboarding/ui/style.css for the installer, and "Select chevron" in
// onboarding/README.md says how a seed adopts or recolours it).
// Every single-line <select> draws its chevron 14px in from the border with
// 40px of end padding so text never runs under it; multi-selects and size>1 lists
// keep their native look. The chevron is two gradient strokes in --rer-select-ink,
// which follows the theme's --rer-muted (a gradient, unlike an SVG data URI, can
// read a CSS variable), so a theme recolours it by declaring tokens alone.
export const selectStyle = 'select:not([multiple],[size]:not([size="1"])){--rer-select-ink:var(--rer-muted,light-dark(#475569,#a8b3c4));appearance:none;-webkit-appearance:none;'
  + 'background-image:linear-gradient(to top right,transparent calc(50% - 1.1px),var(--rer-select-ink) calc(50% - .55px),var(--rer-select-ink) calc(50% + .55px),transparent calc(50% + 1.1px)),linear-gradient(to top left,transparent calc(50% - 1.1px),var(--rer-select-ink) calc(50% - .55px),var(--rer-select-ink) calc(50% + .55px),transparent calc(50% + 1.1px));'
  + 'background-repeat:no-repeat;background-position:right 20px center,right 14px center;background-size:6px 6px;padding-inline-end:40px;text-overflow:ellipsis}'
  + 'select:not([multiple],[size]:not([size="1"])):dir(rtl){background-position:left 14px center,left 20px center}'
  + 'select:not([multiple],[size]:not([size="1"])):focus-visible{--rer-select-ink:var(--rer-text,light-dark(#172033,#f1f5f9))}'
  + 'select:not([multiple],[size]:not([size="1"])):disabled{--rer-select-ink:color-mix(in srgb,var(--rer-muted,light-dark(#475569,#a8b3c4)) 55%,transparent);color:var(--rer-muted,light-dark(#475569,#a8b3c4));cursor:not-allowed}'
  + '@media(forced-colors:active){select:not([multiple],[size]:not([size="1"])){--rer-select-ink:ButtonText}}'
