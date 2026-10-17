// Where the run site's links go. The run site never links an instance-only route (/signin, /setup, /app).
import run from '../run.json'

export const links = { home: '/', run: '/run', docs: '/docs', source: run.repository, licence: `${run.repository}/blob/main/LICENSE`, demo: 'https://demo.run-crank.com/' }
export const docsPath = (slug: string) => `/docs/${slug}`
