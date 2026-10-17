// The /contract page's one script (SPEC.md section 7): it reveals the status
// chips, the search field and the live line, filters the clause rows (status
// AND a substring of id, title, area, evidence and gap), keeps the state in
// ?status=&q= and shows an area's group again before its link scrolls to it.
// Without it every row shows. Copied unchanged to src/base by both exporters.
export const CONTRACT_FILTER = "(()=>{const card=document.getElementById('clauses');if(!card)return;"
  + "const rows=[...card.querySelectorAll('tr.clause')],groups=[...card.querySelectorAll('tbody.area')],chips=[...card.querySelectorAll('.chips button')],search=card.querySelector('input[type=search]'),live=card.querySelector('.live'),empty=card.querySelector('tbody.empty'),text=empty.querySelector('.empty-text');"
  + "const params=new URLSearchParams(location.search);let status=chips.some(chip=>chip.dataset.status===params.get('status'))?params.get('status'):'all';search.value=params.get('q')||'';"
  + "function apply(write){const typed=search.value.trim(),q=typed.toLowerCase();let shown=0;"
  + "for(const row of rows){const on=(status==='all'||row.dataset.status===status)&&(!q||row.dataset.find.includes(q));row.hidden=!on;if(on)shown++}"
  + "for(const group of groups)group.hidden=!group.querySelector('tr.clause:not([hidden])');"
  + "for(const chip of chips)chip.setAttribute('aria-pressed',String(chip.dataset.status===status));"
  + "live.textContent='Showing '+shown+' of '+rows.length+' clauses';empty.hidden=shown>0;"
  + "if(!shown)text.textContent=q?'No '+(status==='all'?'':status+' ')+'clauses match \\u201c'+typed+'\\u201d.':'No clause is '+status+'.';"
  + "if(write){const url=new URL(location.href);if(status==='all')url.searchParams.delete('status');else url.searchParams.set('status',status);if(typed)url.searchParams.set('q',typed);else url.searchParams.delete('q');history.replaceState(history.state,'',url)}}"
  + "function reset(){status='all';search.value='';apply(true)}"
  + "for(const chip of chips)chip.addEventListener('click',()=>{status=chip.dataset.status;apply(true)});"
  + "search.addEventListener('input',()=>apply(true));empty.querySelector('.clear').addEventListener('click',reset);"
  + "const shows=hash=>{const target=hash&&hash.startsWith('#area-')&&document.getElementById(hash.slice(1));if(target&&target.closest('tbody').hidden)reset()};"
  + "document.addEventListener('click',event=>{const link=event.target.closest('a[href^=\"#area-\"]');if(link)shows(link.getAttribute('href'))});"
  + "for(const element of document.querySelectorAll('[data-enhance]'))element.hidden=false;apply(false);shows(location.hash)})()"
