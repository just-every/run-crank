// The run site `rer build --site` writes: the homepage with its Run action,
// /run, the not-found page and the public files they use. Every Run page
// string and command is in run.json; nothing here reads installation data.
import { runPageHtml, siteHomeHtml, siteNotFoundHtml, type RunData, type SiteBuild } from '../base/run-site'
import { identity } from '../identity'
import run from './run.json'

export function sitePages(): SiteBuild {
  const data: RunData = run
  return {
    pages: [
      { path: '/', html: siteHomeHtml(identity, data) },
      { path: '/run', html: runPageHtml(identity, data) },
      { path: '/404', html: siteNotFoundHtml(identity, data) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand'],
  }
}
