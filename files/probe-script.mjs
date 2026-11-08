import {writeFile} from 'node:fs/promises';
import {contentionJourney} from '/workspace/run-crank/tests/agent-door/journey.mjs';
await contentionJourney({observe: result => writeFile(process.argv[2], JSON.stringify(result,null,2)+'\n')});
