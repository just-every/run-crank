import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseContract } from './seed-contract.mjs'

// CONTRACT.md owns all acceptance text, evidence, gaps and status counts.
const source=readFileSync('CONTRACT.md','utf8'), contract=parseContract(source)
const lines=source.split('\n')
const cell=(clause,index)=>lines[clause.row-1].split('|').slice(1,-1)[index].trim()
const counts=clauses=>['done','partial','missing'].map(status=>clauses.filter(clause=>clause.status===status).length)
const summary=(name,clauses)=>`| ${name} | ${counts(clauses).join(' | ')} | ${clauses.length} |`
const table=['| Clauses | Done | Partial | Missing | Total |','| --- | ---: | ---: | ---: | ---: |',summary('Published',contract.clauses.filter(clause=>clause.kind==='published')),summary('Target and push further',contract.clauses.filter(clause=>clause.kind!=='published')),summary('All',contract.clauses)].join('\n')
const normalized=source.replace(/\| Clauses \| Done \| Partial \| Missing \| Total \|\n(?:\|[^\n]*\|\n?)+/,table+'\n')
const acceptance='# Acceptance\n\nGenerated from [CONTRACT.md](CONTRACT.md). Edit the contract, then run `node src/base/contract-docs.mjs write`.\n\n'+contract.clauses.map(clause=>`## ${clause.id} — ${clause.title}\n\nStatus: ${clause.status}.\n\n${clause.text}\n\nCurrent evidence: ${cell(clause,4)||'None recorded.'}\n\nRemaining gap: ${cell(clause,5)||'None.'}\n`).join('\n')
const claims='# Contract claims\n\nGenerated from [CONTRACT.md](../CONTRACT.md). Status reports implementation and proof; a partial clause retains every stated obligation.\n\n'+table+'\n\n| Clause | Status | Evidence | Gap |\n| --- | --- | --- | --- |\n'+contract.clauses.map(clause=>`| ${clause.id} | ${clause.status} | ${cell(clause,4)} | ${cell(clause,5)} |`).join('\n')+'\n'
const outputs={'CONTRACT.md':normalized,'ACCEPTANCE.md':acceptance,'docs/CLAIMS.md':claims}
const verb=process.argv[2]
if(!['write','check'].includes(verb))throw Error('Use write or check')
for(const [path,expected] of Object.entries(outputs)) {
  if(verb==='write')writeFileSync(path,expected)
  else if(!existsSync(path)||readFileSync(path,'utf8')!==expected)throw Error(`${path} is stale; run node src/base/contract-docs.mjs write`)
}
console.log(`Contract documents ${verb==='check'?'are current':'regenerated'}; ${contract.clauses.length} clauses`)
