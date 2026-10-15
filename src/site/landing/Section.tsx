import { Brand, LineIcon, Plate } from './Plate'

export type SectionKind = 'free' | 'runs' | 'replay' | 'agents' | 'flows' | 'try'

type SectionProps = {
  id: SectionKind
  eyebrow?: string
  heading: string
  body: string
  reverse?: boolean
}

export function Section({ id, eyebrow, heading, body, reverse = false }: SectionProps) {
  return (
    <section id={id} className={`landing-section${reverse ? ' landing-section-reverse' : ''}`} aria-labelledby={`${id}-heading`}>
      <div className="landing-section-copy">
        {eyebrow && <p className="landing-eyebrow">{eyebrow}</p>}
        <h2 id={`${id}-heading`}>{heading}</h2>
        <p className="landing-section-body">{body}</p>
      </div>
      <SectionDrawing kind={id} />
    </section>
  )
}

function Chip({ children, state }: { children: string; state: string }) {
  return <span className="status-chip" data-state={state}>{children}</span>
}

function SectionDrawing({ kind }: { kind: SectionKind }) {
  switch (kind) {
    case 'free':
      return <Plate className="landing-feature-plate landing-license" label="Crank, MIT License.">
        <p className="landing-mono">MIT License</p><Brand />
      </Plate>
    case 'runs':
      return <Plate className="landing-feature-plate landing-runs" label="A succeeded run records its approval history and first delivery attempt.">
        <Chip state="succeeded">succeeded</Chip>
        <p className="landing-ruled landing-mono">Approval history · approved</p>
        <p className="landing-ruled landing-mono">Delivery attempts · Attempt 1</p>
      </Plate>
    case 'replay':
      return <Plate className="landing-feature-plate landing-replay" label="ticket-1043 failed. One replay available, using Replay once.">
        <div className="landing-card-heading"><strong>ticket-1043</strong><Chip state="failed">failed</Chip></div>
        <p className="landing-ruled landing-mono">One replay available</p>
        <span className="crank-key landing-key">Replay once</span>
      </Plate>
    case 'agents':
      return <Plate className="landing-feature-plate landing-agents" label="Operations assistant. Active. Agent — prepare and read.">
        <div className="landing-card-heading"><strong>Operations assistant</strong><Chip state="active">Active</Chip></div>
        <p className="landing-ruled landing-mono">Agent — prepare and read</p>
      </Plate>
    case 'flows':
      return <Plate className="landing-feature-plate landing-flows" label="Support follow-up is active. Support desk to Human approval to Operations inbox. Pause flow.">
        <div className="landing-card-heading"><strong>Support follow-up</strong><Chip state="active">active</Chip></div>
        <p className="landing-ruled landing-mono">Support desk → Human approval → Operations inbox</p>
        <span className="outline-pill landing-pause">Pause flow</span>
      </Plate>
    case 'try':
      return <Plate className="landing-feature-plate landing-import" recessed={false} label="Review before importing. Support follow-up. Approve import, or Undo unused import.">
        <div className="landing-import-frame">
          <p className="landing-import-title landing-mono">Review before importing</p>
          <div className="metal-slot landing-import-slot">
            <p className="landing-import-row landing-mono"><LineIcon name="webhook" />Support follow-up</p>
            <div className="landing-import-actions"><span className="crank-key landing-key">Approve import</span><span className="outline-pill">Undo unused import</span></div>
          </div>
        </div>
      </Plate>
  }
}
