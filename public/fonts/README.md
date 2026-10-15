# Fonts

Outfit is self-hosted under the SIL Open Font License 1.1 in
`outfit/LICENSE.txt`. The Latin and Latin Extended WOFF2 subsets come from
Fontsource's Outfit distribution; upstream: https://github.com/Outfitio/Outfit-Fonts.

The root document links `/fonts/fonts.css` once, outside the temporary dev SSR
stylesheet, and preloads only the primary Latin file. Do not import this CSS
from a component. Every body-font stack uses `--font-body`, including the local
`Outfit Fallback` before generic fallback fonts; controls inherit it.

Fallback scales use Outfit/Arial advance-width ratios over A-Z, a-z and 0-9
at weights 400, 500 and 700. Ascent, descent and line gap match Outfit's
1000, -260 and 0 per 1000 units, divided by each scale. Matching metrics reduces
layout movement; different glyph designs cannot have identical widths in every
piece of text. Recalculate the fallback and preload when changing the brand font.
