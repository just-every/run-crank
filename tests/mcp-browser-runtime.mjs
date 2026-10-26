import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

/** Real emitted Worker and its assets on the fixture's stable public origin. */
export async function serveMcpFixture(h) {
 const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png','.webp':'image'+'/'+'webp'};
 const server=createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent(new URL(req.url,h.origin).pathname);
  if(types[extname(pathname)])for(const root of ['./dist/client','public']){
   const directory=resolve(root),file=resolve(directory,'.'+pathname);if(!file.startsWith(directory+'/'))continue;
   const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers={...req.headers};delete headers['content-length'];
  const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end('Fixture transport failed')}});
 await new Promise(resolve=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',resolve));
 return async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))};
}
