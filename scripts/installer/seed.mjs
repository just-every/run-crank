import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as presentation from './ui/seed.mjs';
import { adapter } from './local.mjs';
export function createSeed(root) {
 // The installer's buttons use the colour chosen at setup; public/rer-theme.css supplies the rest.
 const { primaryColor } = JSON.parse(readFileSync(join(root, 'src/branding.json'), 'utf8'));
 return { ...adapter, features: presentation.features, branding: { ...presentation.branding, accent: primaryColor }, theme: 'public/rer-theme.css', product: presentation.product.name, setup: { manifestFile: 'rer-setup.json' }, browserModule: 'scripts/installer/ui/seed.mjs', background: 'scripts/installer/ui/background.svg',
  defaults: async () => { const branding=JSON.parse(await readFile(join(root, 'src/branding.json'), 'utf8')); return {APP_NAME:branding.name,PRIMARY_COLOR:branding.primaryColor}; },
 };
}
