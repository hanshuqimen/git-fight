async (page) => {
  // No routes or fetch overrides: this run uses the real anonymous GitHub API.
  const responses = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith('https://api.github.com/')) responses.push({ url: response.url(), status: response.status() });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:5176/');
  await page.getByLabel('对战方式').selectOption('right');
  await page.locator('.advanced summary').click();
  await page.getByLabel('随机 Seed', { exact: true }).fill('0');
  await page.getByRole('button', { name: '开始对决', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.battle-screen') || !document.querySelector('#form-error')?.hidden, {}, { timeout: 60000 });
  if (await page.locator('.battle-screen').count()) {
    await page.screenshot({ path: 'output/playwright/live-github-arena.png', fullPage: true });
    await page.getByLabel('速度', { exact: true }).selectOption('1800');
    for (let step = 0; step < 600; step++) {
      if (await page.locator('.result-screen').count()) break;
      if (await page.locator('.your-turn').count()) await page.locator('[data-action]:not(:disabled)').last().click({ timeout: 250 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    if (!(await page.locator('.result-screen').count())) throw new Error('Live battle did not finish');
    await page.waitForFunction(() => !document.querySelector('#download-card')?.disabled, {}, { timeout: 15000 });
    const avatars = await page.locator('canvas').getAttribute('data-missing-avatars');
    if (avatars !== 'false') throw new Error('Real avatar loading failed');
    const log = await page.locator('#battle-log').textContent();
    const before = responses.length;
    const downloading = page.waitForEvent('download'); await page.locator('#download-card').click();
    await (await downloading).saveAs('output/playwright/live-github-result.png');
    await page.screenshot({ path: 'output/playwright/live-github-result-page.png', fullPage: true });
    await page.locator('#replay').click(); await page.locator('#skip-battle').click();
    if (await page.locator('#battle-log').textContent() !== log || responses.length !== before) throw new Error('Live replay changed events or requested GitHub');
    await page.evaluate(report => console.log('LIVE_ACCEPTANCE ' + JSON.stringify(report)), { passed: true, mocked: false, control: 'right', seed: 0, avatars, responses, errors, log });
    await page.locator('#result-config').click();
    await page.getByLabel('01 挑战者').fill('git-fight-missing-user-xyz-20261004');
    await page.getByRole('button', { name: '开始对决', exact: true }).click();
    await page.getByRole('button', { name: '重试对决 →', exact: true }).waitFor({ timeout: 30000 });
    const message = await page.getByRole('alert').textContent();
    await page.evaluate(report => console.log('LIVE_404 ' + JSON.stringify(report)), { message, responses: responses.slice(before) });
  } else {
    const message = await page.getByRole('alert').textContent();
    await page.screenshot({ path: 'output/playwright/live-github-blocked.png', fullPage: true });
    await page.evaluate(report => console.log('LIVE_ACCEPTANCE ' + JSON.stringify(report)), { passed: false, mocked: false, message, responses, errors });
  }
}
