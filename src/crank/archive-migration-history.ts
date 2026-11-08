// The Worker bundler supplies destination-owned replay evidence here. Keeping
// an inert source value also lets registry/documentation tools bundle source
// without installing a Worker build plugin. Restore fails closed without it.
const history: null | {
  files: { name: string; sha256: string; statements: string[] }[]
  seeds: { name: string; columns: string[]; images: string[] }[]
} = null
export default history
