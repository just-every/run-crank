// Shared by the root renderer and the no-JavaScript first-run document.
// Edition owners can replace these self-hosted URLs with their brand assets.
// Crank: Figtree (its faces are in /rer-theme.css) and the look every document wears (/look.css).
export const fontLinks = [
  { rel: 'preload', href: '/fonts/figtree/figtree-latin-wght-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: '/look.css' },
] as const

export const fontHead = fontLinks.map(link => `<link ${Object.entries(link).map(([name, value]) => `${name.toLowerCase()}="${value}"`).join(' ')}>`).join('')
