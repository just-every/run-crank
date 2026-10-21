// This edition's identity: what its installed Lobby and its run site say.
// The name and colour are the ones setup saves in src/branding.json; replace
// the purpose and tagline with the product's own when it has one.
import type { EditionIdentity } from './base/identity'
import branding from './branding.json'
import site from '../deploy-site.json'

export const identity: EditionIdentity = {
  product: branding.name,
  deployment: branding.name,
  purpose: '{deployment} connects incoming events to approved actions, with every run visible.',
  tagline: 'The busywork runs itself. Crank connects your apps and runs every step on schedule: a 100% free, open source alternative to Zapier, Make and Workato.',
  signInPath: '/signin',
  // The run site `rer deploy --site` publishes (deploy-site.json).
  runSite: `https://${site.domain}`,
  // An installed instance serves the Lobby at /.
  installedHome: 'lobby',
  theme: '/rer-theme.css',
  mark: '/brand/mark.svg',
  // Linked before the theme on the Lobby and the Run pages: Crank's look (the faces are in the theme).
  fonts: '/look.css',
  accentColor: branding.primaryColor,
}
