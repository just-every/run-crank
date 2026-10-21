import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {harness} from './harness.mjs';

/** Real emitted app and SQLite. Only the mail provider edge is captured, so the
 * installed browser follows a genuine native email link and email step-up. */
export async function customBrowserRuntime() {
  const h=await harness('http://127.0.0.1:9',{emitted:true});
  const client=resolve('dist/client'),publicRoot=resolve('public');
  const types={'.css':'text/css','.js':'text/javascript','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  const server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,h.origin).pathname;
      if(req.method==='GET' && !/^(\/api\/|\/auth\/|\/app(?:\/|$)|\/signin|\/setup)/.test(pathname)) {
        for(const root of [client,publicRoot]) {
          const file=resolve(root,'.'+decodeURIComponent(pathname));if(!file.startsWith(root+sep))continue;
          const bytes=await readFile(file).catch(()=>null);
          if(bytes){res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream'});res.end(bytes);return}
        }
      }
      let raw=Buffer.alloc(0);for await(const chunk of req){raw=Buffer.concat([raw,chunk]);if(raw.length>1024*1024)throw Error('bounded request')}
      const headers={...req.headers};delete headers['content-length'];
      const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:raw}:{}),redirect:'manual'});
      const output=Object.fromEntries(response.headers);const cookies=response.headers.getSetCookie();if(cookies.length)output['set-cookie']=cookies;
      res.writeHead(response.status,output);res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(503);res.end('Browser journey transport failed')}
  });
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(Number(new URL(h.origin).port),'127.0.0.1',done)});
  return {h,origin:h.origin,mailLink(){const link=h.mail.at(-1)?.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)?.[1];assert.ok(link,'Native sign-in or step-up mail must be delivered');return link.replaceAll('&amp;','&')},async close(){server.closeAllConnections();await new Promise(done=>server.close(done));await h.close()}};
}
