// Edition identity: what the installed Lobby and the run site say about a seed.
// Each seed keeps one value of this shape in its own config (default-seed:
// src/core/app/identity.ts; a foundation edition: src/identity.ts reading
// src/branding.json). Nothing in Base's renderers is written per seed.
// This file is copied unchanged to src/base by both maintained exporters.
export interface EditionIdentity {
  /** The seed's name, as its wordmark: "Cradle". */
  product: string
  /** This installation's own name, set by its owner: "Northwind". */
  deployment: string
  /** One line about this installation; `{deployment}` is replaced by its name. */
  purpose: string
  /** One line about the seed itself, for the run site's homepage. */
  tagline: string
  /** The seed's sign-in route on an installed instance. */
  signInPath: string
  /** Show setup-token guidance while unclaimed only when the owner must claim manually; RER claims it automatically. */
  manualSetupTokenClaim?: boolean
  /** The run site's https origin, the domain its site deploy declaration names. */
  runSite: string
  /**
   * What an installed instance serves at /: `lobby` (the Lobby, with Sign in
   * or Finish setup), or `page` for a seed that keeps its own public page there
   * (a status page, a public form) and links Sign in from its header.
   */
  installedHome: 'lobby' | 'page'
  /** Served files: the theme stylesheet, the mark and the optional floor art. */
  theme: string
  mark: string
  band?: string
  /** The served stylesheet with the seed's @font-face rules ("/fonts/fonts.css"), linked before the theme; omit when the theme declares them. */
  fonts?: string
  /** #rrggbb for buttons when the theme declares no --rer-accent (as the frames use it). */
  accentColor?: string
}

const servedPath = /^\/(?!\/)[A-Za-z0-9._~/-]{1,200}$/

export function checkIdentity(identity: EditionIdentity): EditionIdentity {
  for (const key of ['product', 'deployment', 'purpose', 'tagline'] as const) if (typeof identity[key] !== 'string' || !identity[key].trim()) throw new Error(`Edition identity needs ${key}.`)
  if (!identity.purpose.includes('{deployment}')) throw new Error('Edition identity purpose names the deployment as {deployment}.')
  if (!['lobby', 'page'].includes(identity.installedHome)) throw new Error('Edition identity installedHome is lobby or page.')
  if (identity.manualSetupTokenClaim !== undefined && typeof identity.manualSetupTokenClaim !== 'boolean') throw new Error('Edition identity manualSetupTokenClaim is a boolean.')
  for (const path of [identity.signInPath, identity.theme, identity.mark, ...(identity.band ? [identity.band] : []), ...(identity.fonts ? [identity.fonts] : [])]) if (!servedPath.test(path) || path.includes('/.')) throw new Error('Edition identity paths are same-origin paths.')
  if (!/^https:\/\/[a-z0-9.-]+$/.test(identity.runSite)) throw new Error('Edition identity runSite is an https origin.')
  if (identity.accentColor !== undefined && !/^#[0-9a-f]{6}$/i.test(identity.accentColor)) throw new Error('An accent colour is #rrggbb.')
  return identity
}

export const deploymentLine = (identity: EditionIdentity) => identity.purpose.replaceAll('{deployment}', identity.deployment)
