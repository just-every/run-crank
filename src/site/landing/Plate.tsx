import type { ReactNode } from 'react'

type PlateProps = {
  children: ReactNode
  className?: string
  label?: string
  recessed?: boolean
}

/** A material frame shared by the landing's product illustrations. */
export function Plate({ children, className = '', label, recessed = true }: PlateProps) {
  return (
    <div className={`metal-plate landing-plate ${className}`} role={label ? 'img' : undefined} aria-label={label}>
      {recessed ? <div className="landing-plate-frame"><div className="metal-slot landing-plate-slot">{children}</div></div> : children}
    </div>
  )
}

export function Brand({ className = '' }: { className?: string }) {
  return <span className={`site-brand ${className}`}><img src="/brand/mark.svg" alt="" width="32" height="32" />Crank</span>
}

export type LineIconName = 'move' | 'export' | 'erase' | 'people' | 'computer' | 'key' | 'webhook'

export function LineIcon({ name }: { name: LineIconName }) {
  const paths: Record<LineIconName, ReactNode> = {
    move: <><circle cx="7" cy="16" r="3" /><circle cx="24" cy="7" r="3" /><circle cx="24" cy="25" r="3" /><path d="m10 14 11-6M10 18l11 6" /></>,
    export: <><path d="M18 3H7a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V12L18 3Z" /><path d="M18 3v9h9M16 24V14m-5 5 5-5 5 5" /></>,
    erase: <><path d="M5 8h22M12 8V4h8v4M8 8l2 21h12l2-21M14 13v11m5-11v11" /></>,
    people: <><circle cx="16" cy="8" r="4" /><circle cx="5" cy="12" r="3" /><circle cx="27" cy="12" r="3" /><path d="M9 29v-7a7 7 0 0 1 14 0v7M1 28v-6a5 5 0 0 1 6-5m24 11v-6a5 5 0 0 0-6-5" /></>,
    computer: <><rect x="3" y="4" width="26" height="20" rx="2" /><path d="M16 24v5M10 29h12" /></>,
    key: <><rect x="4" y="8" width="24" height="19" rx="4" /><path d="M9 22h14M9 13v3m5-3v3m5-3v3m5-3v3" /></>,
    webhook: <><path d="m13 12-5 9a4 4 0 1 0 4 4h9M21 12l5 9a4 4 0 1 1-6 3M12 11a5 5 0 1 1 9-2" /><path d="m16 8 6 11H10" /></>,
  }
  return <svg className="landing-line-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
