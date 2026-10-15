export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export function headingText(value: string): string {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|#39);/gi, (entity, number: string | undefined) => {
    if (number) {
      const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity
  }).replace(/\s+/g, ' ').trim()
}

/** GitHub-style heading IDs, including distinct IDs for repeated headings. */
export function slugger() {
  const seen = new Set<string>()
  return (text: string) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '').replace(/\s/g, '-')
    let id = base, count = 0
    while (seen.has(id)) id = `${base}-${++count}`
    seen.add(id)
    return id
  }
}
