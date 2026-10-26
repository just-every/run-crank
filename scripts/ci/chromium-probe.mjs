import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? { args: ['--use-mock-keychain', '--password-store=basic'] } : {}),
});
await browser.close();
