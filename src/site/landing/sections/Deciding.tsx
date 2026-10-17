import { AppTile, ArrowRight, Check, Feature } from '../parts'

const RULES = [
  { rule: 'Refunds under $100', count: '14 this week' },
  { rule: 'Shopify orders under $500', count: '212 this week' },
]

/** Desk page 5, top: approvals only where they matter, standing rules for the rest. */
export function Approvals() {
  return <Feature id="approvals" eyebrow="Approvals" title={<>A person only where it matters.</>} label="Dana Reyes approved a $1,250 refund for order 4729 two minutes ago. Standing rules: refunds under $100 run on their own, 14 this week; Shopify orders under $500 run on their own, 212 this week." art={
    <div className="card approval-card">
      <div className="approval-head">
        <span className="avatar">DR</span>
        <p><strong>Dana Reyes</strong><span>Refund $1,250 · Order #4729</span></p>
        <div className="approval-state"><span className="chip chip-green chip-lg"><Check />Approved</span><span>2 min</span></div>
      </div>
      <h3 className="card-subtitle">Standing rules</h3>
      <ul className="rule-list">{RULES.map(r => <li key={r.rule}><span className="toggle" /><p><strong>{r.rule}</strong><span>runs on its own</span></p><span className="rule-count">{r.count}</span></li>)}</ul>
    </div>
  }>Add an approval step for refunds or large orders, and let routine actions run on standing rules. Roles decide who approves what.</Feature>
}

/** Desk page 5, bottom: AI steps, and a workflow built from a sentence. */
export function AiSteps() {
  return <Feature id="ai-steps" flip eyebrow="AI steps" title={<>AI where it helps.</>} label="Asked in plain words to score Typeform leads and post hot ones to #sales in Slack, Crank built Typeform new response, then an AI step scoring the lead 1 to 10, then Slack posting to #sales if 8 or more. Priya Shah of Fieldstone Dental scored 9 and was posted." art={
    <div className="card ai-card">
      <div className="ai-prompt"><p>When a Typeform lead comes in, score it and post hot ones to #sales in Slack.</p><span className="build-button">Build</span></div>
      <div className="ai-steps">
        <div className="ai-step"><AppTile app="typeform" /><p><strong>Typeform</strong><span>New response</span></p></div>
        <ArrowRight />
        <div className="ai-step"><AppTile app="ai" /><p><strong>AI</strong><span>Score lead 1–10</span></p></div>
        <ArrowRight />
        <div className="ai-step"><AppTile app="slack" /><p><strong>Slack</strong><span>Post to #sales if 8+</span></p></div>
      </div>
      <p className="ai-result"><Check /><strong>Priya Shah</strong><span>Fieldstone Dental</span><span>score 9</span><span>posted</span></p>
    </div>
  }>Add a model step to read, sort or draft, or an agent that uses your tools over MCP. Describe a workflow in plain words and Crank builds it.</Feature>
}
