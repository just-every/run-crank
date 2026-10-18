import { selectStyle } from './select-style'

// The example pages' own style, shared by the default seed and the foundation
// template and copied to src/base by both exporters. It reads the seed's served
// --rer-* tokens; each falls back to a readable neutral (the same ones as
// theme-frame.ts) so a page that cannot load rer-theme.css keeps its colours
// and a visible 3px focus ring.
export const pageStyle = 'body{margin:0;padding:1rem;min-height:100vh;box-sizing:border-box;background:var(--rer-page,#f3f5f8);color:var(--rer-text,#172033);font-family:var(--rer-font-body,var(--font-body,inherit));line-height:1.5}'
  + 'a{color:var(--rer-link,var(--rer-text,#172033))}:focus-visible{outline:3px solid var(--rer-focus,#172033);outline-offset:3px}'
  + 'h1,h2{font-family:var(--rer-font-heading,var(--rer-font-body,inherit));text-wrap:balance}p{text-wrap:pretty}'
  + selectStyle
