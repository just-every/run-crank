import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),packet=process.env.F94_PACKET,mode=process.env.F94_MODE;
const {contentionJourney}=await import(pathToFileURL(root+'/tests/agent-door/journey.mjs'));
try {
 const result=await contentionJourney({observe:async receipt=>writeFile(packet+'/'+mode+'-contention.json',JSON.stringify({mode,head:process.env.F94_HEAD,...receipt},null,2)+'\n')});
 console.log(JSON.stringify({mode,status:'pass',...result}));
} catch(error) {
 console.error(JSON.stringify({mode,status:'failed',message:error.message,actual:error.actual,expected:error.expected}));
 process.exitCode=1;
}
