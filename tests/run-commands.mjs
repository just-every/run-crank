import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

// Base #266 checks rendered text, character ranges and real clipboard bytes.
export async function verifyRunCommands(origin) {
  const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto(origin + '/run')
    await page.evaluate(() => document.fonts.ready)
    await page.getByText('Other ways to run locally', { exact: true }).click()
    const inline = page.locator('p code').filter({ hasText: '@runeditrun/rer' })
    const command = 'npx -y @runeditrun/rer dev just-every/run-crank'
    assert.equal(await inline.textContent(), command, 'the complete start command is shown')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const problems = await page.evaluate(() => {
        const problems = []
        for (const code of document.querySelectorAll('p code')) {
          const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
          let previous = ' ', top = null
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (let i = 0; i < node.textContent.length; i++) {
              const character = node.textContent[i], range = document.createRange()
              range.setStart(node, i); range.setEnd(node, i + 1)
              const rect = range.getClientRects()[0]
              if (!rect || !rect.width || /\s/.test(character)) { previous = character; continue }
              if (top !== null && rect.top > top + 2 && !/\s/.test(previous)) problems.push(code.textContent)
              previous = character; top = rect.top
            }
          }
        }
        for (const block of document.querySelectorAll('.code')) {
          const button = block.querySelector('.copy').getBoundingClientRect(), pre = block.querySelector('pre').getBoundingClientRect()
          const range = document.createRange(); range.selectNodeContents(block.querySelector('pre code'))
          for (const rect of range.getClientRects()) {
            if (rect.width && rect.height && (rect.left < pre.left - .5 || rect.right > pre.right + .5 ||
              rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top)) problems.push(block.textContent)
          }
        }
        return problems
      })
      assert.deepEqual(problems, [], `commands stay whole and clear of Copy at ${width}px`)
      await inline.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
        document.execCommand('copy')
      })
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command, 'selecting the inline command copies exact bytes')
      assert.ok(await page.locator('.copy').count(), 'command blocks offer Copy')
      for (const button of await page.locator('.copy').all()) {
        const text = await button.locator('..').locator('pre code').textContent()
        assert.equal(await button.getAttribute('data-copy'), text)
        await button.click()
        await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, text)
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, 'Copy preserves command bytes')
      }
    }
    await context.close()
  } finally { await browser.close() }
}
