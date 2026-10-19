import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { verifyRunCommands } from './run-commands.mjs'

// Exercise the emitted static site through HTTP, as a visitor without JavaScript.
test('BASE-004: the MIT-licensed run site leads to runnable commands and repository guides with working local links', async () => {
  const license = await readFile('LICENSE', 'utf8');
  assert.match(license, /^MIT License\s+Copyright/);
  const mit = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  assert.equal(normalize(license.slice(license.indexOf('Permission is hereby granted'))), normalize(mit));
  assert.equal(JSON.parse(await readFile('package.json', 'utf8')).license, 'MIT');
  assert.match(await readFile('README.md', 'utf8'), /\[MIT licensed\]\(LICENSE\)/);
  const root=resolve('dist/site')
  const server=createServer(async(req,res)=>{
    try {
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)
      let path=resolve(root,'.'+pathname)
      assert.ok(path.startsWith(root+'/')||path===root)
      if(path===root) path+='/index.html'
      else if(!extname(path)) {
        try { await stat(path+'.html'); path+='.html' }
        catch { if((await stat(path)).isDirectory()) path+='/index.html' }
      }
      const bytes=await readFile(path)
      res.writeHead(200,{'content-type':extname(path)==='.html'?'text/html':extname(path)==='.css'?'text/css':'application/octet-stream'});res.end(bytes)
    } catch {res.writeHead(404);res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  const queue=['/'],seen=new Set(),documents=new Map()
  try {
    while(queue.length) {
      const path=queue.shift();if(seen.has(path))continue;seen.add(path)
      const response=await fetch(origin+path);assert.equal(response.status,200,path)
      if(response.headers.get('content-type').startsWith('text/css')) {
        const css=await response.text()
        for(const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
          const url=new URL(match[1],origin+path)
          if(url.origin===origin&&!seen.has(url.pathname)) queue.push(url.pathname)
        }
        continue
      }
      if(!response.headers.get('content-type').startsWith('text/html'))continue
      const html=await response.text();documents.set(path,html)
      const refs=[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1])
      for(const match of html.matchAll(/srcSet="([^"]+)"|srcset="([^"]+)"/gi)) refs.push(...(match[1]??match[2]).split(',').map(entry=>entry.trim().split(/\s+/)[0]))
      for(const ref of refs) {
        const url=new URL(ref.replaceAll('&amp;','&'),origin+path)
        if(url.origin===origin&&!seen.has(url.pathname)) queue.push(url.pathname)
      }
    }
    assert.ok(documents.has('/run'),'the homepage has a path to running the app')
    assert.ok(documents.has('/docs'),'the homepage has a path to documentation')
    const home=documents.get('/'),homeText=home.replace(/<[^>]+>/g,'').replaceAll('&amp;','&')
    assert.match(home, /<a\s+href="https:\/\/github\.com\/just-every\/run-crank\/blob\/main\/LICENSE"[^>]*>MIT licensed<\/a>/);
    assert.match(homeText,/git clone https:\/\/github\.com\/just-every\/run-crank\.git crank\s*\$?\s*cd crank && rer dev/,'the homepage shows the commands that start Crank')
    assert.doesNotMatch(home,/localhost|127\.0\.0\.1|\bRER_[A-Z]/,'the homepage shows no local addresses or rer output')
    const run=documents.get('/run'),runText=run.replace(/<[^>]+>/g,'').replaceAll('&amp;','&')
    assert.match(runText,/@runeditrun\/rer dev just-every\/run-crank/);assert.match(runText,/rer dev/)
    await verifyRunCommands(origin)
    assert.ok([...documents.keys()].filter(path=>path.startsWith('/docs/')).length>1,'readable guides are emitted')
    for(const [path,html] of documents) {
      for(const match of html.matchAll(/href="([^"]+)"/g)) {
        const url=new URL(match[1].replaceAll('&amp;','&'),origin+path)
        if(url.origin!==origin||!url.hash)continue
        const target=documents.get(url.pathname);assert.ok(target,`anchor page ${url.pathname}`)
        assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),`broken anchor ${path} → ${url.pathname}${url.hash}`)
      }
    }
  } finally {await new Promise(resolve=>server.close(resolve))}
})
