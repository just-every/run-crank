import { readFileSync } from 'node:fs';
import main from '/task/code.mjs';
const input = JSON.parse(readFileSync('/task/input.json', 'utf8'));
process.stdout.write(JSON.stringify(await main(input)));
