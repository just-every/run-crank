import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {createServer,isFileServingAllowed}=await import(pathToFileURL(resolve('node_modules/vite/dist/node/index.js')));
const manifestPath=resolve('agent-surface.json');
let config, observed=0, server;
const trace={name:'report-only-manifest-load-observer',enforce:'pre',configResolved(value){config=value},load(id){
 if(id.split('?')[0]!==manifestPath)return;
 observed++;
 const allowed=path=>isFileServingAllowed(config,'/@fs'+path);
 console.log('MANIFEST_LOAD_OBSERVATION '+JSON.stringify({environment:this.environment.name,id,exists:existsSync(id),sha256:createHash('sha256').update(readFileSync(id)).digest('hex'),strict:config.server.fs.strict,safeAbsolute:config.safeModulePaths.has(id),safeManifestEntries:[...config.safeModulePaths].filter(path=>path.endsWith('/agent-surface.json')),fsAllow:config.server.fs.allow,absoluteAllowed:allowed(id),seedPrivateDenied:!allowed(resolve('.seed/installer/install.log')),rerPrivateDenied:!allowed(resolve('.rer/local/private.json')),exportsDenied:!allowed(resolve('exports/private.rer'))}));
 // Return no load result: the installed Vite/Cloudflare loader reads the real source.
}};
try {
 server=await createServer({configFile:resolve('vite.config.ts'),server:{host:'127.0.0.1',port:0},plugins:[trace]});
 await server.listen();
 assert.ok(observed>0,'observed real manifest load');
 const address=server.httpServer.address(),origin='http://127.0.0.1:'+address.port;
 const response=await fetch(origin+'/docs/agents',{headers:{accept:'application/json'}});
 assert.equal(response.status,200);
 const doc=await response.json(),surface=JSON.parse(readFileSync(manifestPath,'utf8'));
 assert.equal(doc.specialist,surface.specialist);
 assert.deepEqual(doc.limits,surface.documentation.limits);
 assert.deepEqual(doc.tools.map(item=>item.name),surface.tools.map(item=>item.name).sort());
 console.log('MANIFEST_DEV_HTTP_PASS '+JSON.stringify({observed,specialist:doc.specialist,tools:doc.tools.length,limits:doc.limits}));
} finally {await server?.close();}
