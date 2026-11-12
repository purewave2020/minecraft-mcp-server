// POSTs are intercepted: these interaction checks never send Minecraft chat.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:18100';
const output = path.resolve(process.env.DASHBOARD_DATA ?? fileURLToPath(new URL('../../.npm/dashboard', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}), headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    ...(process.env.DASHBOARD_PASSWORD ? { httpCredentials: { username: 'dashboard', password: process.env.DASHBOARD_PASSWORD } } : {}) });
  const requests = [];
  let failure = true;
  let release;
  await context.route('**/api/chat', async route => {
    requests.push(route.request().postDataJSON());
    if (failure) { await route.fulfill({ status: 503, json: { error: '测试发送失败，草稿保留' } }); return; }
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 201, json: { username: 'qingyage' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/map/', { waitUntil: 'domcontentloaded' });
  const input = page.getByRole('textbox', { name: '聊天内容' });
  const button = page.getByRole('button', { name: '发送', exact: true });
  await input.waitFor();
  await page.waitForFunction(() => document.querySelector('.md-connection')?.textContent === '实时连接');
  assert.equal(await page.locator('.md-chat-identity strong').textContent(), 'qingyage');
  assert.equal(await input.getAttribute('maxlength'), '256');
  assert.equal(await button.isDisabled(), true);
  await input.fill('中文选字 😀');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.dispatchEvent('compositionend');
  assert.equal(requests.length, 0, 'IME confirmation must not submit chat');
  await input.press('Enter');
  await page.getByRole('status').filter({ hasText: '测试发送失败，草稿保留' }).waitFor();
  assert.equal(await input.inputValue(), '中文选字 😀');
  failure = false;
  const content = '/op @a 中文 😀 <img src=x> $(whoami)';
  await input.fill(content);
  await input.press('Enter');
  await page.getByRole('button', { name: '发送中…', exact: true }).waitFor();
  await input.press('Enter');
  assert.equal(requests.length, 2, 'A second Enter during a pending request must not send twice');
  assert.deepEqual(requests[1], { content });
  release();
  await page.getByRole('status').filter({ hasText: '已发送' }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: '世界动态', exact: true }).click();
  assert.equal(await input.count(), 0);
  await page.getByRole('button', { name: '公共聊天', exact: true }).click();
  await input.waitFor();
  await page.screenshot({ path: path.join(output, 'chat-input-desktop.png') });
  await page.close();

  const mobile = await context.newPage();
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await mobile.locator('.md-open-chat').click();
  const mobileInput = mobile.getByRole('textbox', { name: '聊天内容' });
  await mobileInput.waitFor();
  const form = await mobile.locator('.md-chat-composer').boundingBox();
  assert.ok(form && form.x >= 0 && form.x + form.width <= 390 && form.y + form.height < 844);
  const list = await mobile.locator('.md-feed-list').boundingBox();
  assert.ok(list && list.height > 60, 'The composer must leave room for chat history');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: path.join(output, 'chat-input-mobile.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['fixed-qingyage', 'IME', 'Enter', 'retain-failed-draft', 'prevent-double-send', 'literal-text', 'clear-on-success', 'mobile-layout'], screenshots: output }));
} finally { await browser.close(); }
