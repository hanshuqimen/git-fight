async (page) => {
  // Isolated browser routes mock only GitHub API. Test the real production HTML/CSP.
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  let requests = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('https://api.github.com/**', async route => {
    requests += 1;
    const url = new URL(route.request().url());
    check(route.request().headers().accept==='application/vnd.github+json','Missing API Accept');
    const username = url.pathname.split('/')[2];
    let body;
    let status = 200;
    if (username==='git-fight-missing-user-test') { body={message:'Not Found'}; status=404; }
    else if (url.pathname==='/search/commits') body={total_count:4000,incomplete_results:false};
    else if (url.pathname.endsWith('/repos')) body=[{id:username==='octocat'?1:2,name:'fixture',owner:{login:username},stargazers_count:400,language:username==='octocat'?'TypeScript':'C',private:false}];
    else body={login:username,name:username+'（生产构建模拟测试）',avatar_url:'https://avatars.githubusercontent.com/u/'+(username==='octocat'?'583231':'1024025')+'?s=160',public_repos:1,followers:10};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('http://127.0.0.1:4176/');
  await page.getByLabel('对战方式').selectOption('auto');
  await page.locator('.advanced summary').click();
  await page.getByLabel('随机 Seed',{exact:true}).fill('0');
  await page.getByRole('button',{name:'开始对决',exact:true}).click();
  await page.getByRole('button',{name:'查看结果',exact:true}).click();
  await page.getByRole('button',{name:'↻ 重播本局',exact:true}).waitFor({state:'visible',timeout:20000});
  await page.waitForFunction(() => !document.querySelector('#download-card')?.disabled);
  check(await page.locator('canvas').getAttribute('data-missing-avatars')==='false','Production CSP blocked avatars');
  const log = await page.locator('#battle-log').textContent();
  const before = requests;
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button',{name:'下载结果图',exact:true}).click();
  await (await downloadPromise).saveAs('output/playwright/production-mocked-result.png');
  await page.getByRole('button',{name:'↻ 重播本局',exact:true}).click();
  await page.getByLabel('速度',{exact:true}).selectOption('1800');
  await page.getByRole('button',{name:'↻ 重播本局',exact:true}).waitFor({state:'visible',timeout:30000});
  check(await page.locator('#battle-log').textContent()===log && requests===before,'Production replay changed');
  await page.getByRole('button',{name:'返回配置',exact:true}).click();
  await page.getByLabel('01 挑战者').fill('git-fight-missing-user-test');
  await page.getByRole('button',{name:'开始对决',exact:true}).click();
  await page.getByRole('button',{name:'重试对决 →',exact:true}).waitFor({state:'visible'});
  check((await page.getByRole('alert').textContent()).includes('用户不存在'),'Production 404 missing');
  check(errors.length===0,'Production page errors: '+errors.join('; '));
  await page.unroute('https://api.github.com/**');
  await page.goto('http://127.0.0.1:4176/');
  await page.screenshot({path:'output/playwright/production-config.png',fullPage:true});
  await page.evaluate(report => console.log('PRODUCTION_ACCEPTANCE ' + JSON.stringify(report)), {passed:true,production:true,mockedApi:true,seed:0,download:true,requests:before});
}
