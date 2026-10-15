import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { docsSite } from './src/site/docs/build/plugin'

// Static Node rendering: the app's Worker and Start plugins do not belong here.
export default defineConfig({ plugins: [docsSite(), react()] })
