#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { launch } from '@runeditrun/rer/launcher';
import { createSeed } from './installer/seed.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
await launch(root, createSeed(root));
