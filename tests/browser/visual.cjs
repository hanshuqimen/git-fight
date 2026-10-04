async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('http://127.0.0.1:5176/tests/browser/');
  await page.locator('.advanced summary').click();
  await page.getByLabel('随机 Seed', { exact: true }).fill('42');
  await page.getByRole('button', { name: '开始对决', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#action-prompt')?.textContent.includes('轮到你'));
  await page.screenshot({ path: 'output/playwright/interactive-arena.png', fullPage: true });
  await page.getByLabel('速度', { exact: true }).selectOption('4000');
  await page.locator('[data-action="1"]').click();
  await page.waitForFunction(() => document.querySelector('.arena-board')?.dataset.phase === 'travel');
  await page.getByRole('button', { name: '暂停 · P', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/skill-travel.png', fullPage: true });
  console.log(JSON.stringify({ status: await page.locator('#battle-status').textContent(), paused: await page.locator('#pause-battle').getAttribute('aria-pressed') }));
}
