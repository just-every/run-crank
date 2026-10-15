export type DocsTocEntry = { id: string; text: string; level: number }
export type DocsPageData = {
  slug: string
  title: string
  description: string
  html: string
  toc: DocsTocEntry[]
  section: string
}
export type DocsPageMeta = Pick<DocsPageData, 'slug' | 'title' | 'description' | 'section'> & { source: string }
