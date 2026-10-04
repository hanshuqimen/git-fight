# git-fight · 代码竞技场

Commit 化作攻击，Star 铸成血量，编程语言成为技能。输入两个 GitHub 用户名，用公开数据生成卡牌，亲自选招迎战程序对手，或自动观战，再下载一张 1200×630 的战果 PNG。

纯静态前端：Vite + TypeScript strict + 原生 DOM/CSS + Canvas。无登录、OAuth、后端、数据库、历史记录和运行时第三方依赖。

开源仓库：[hanshuqimen/git-fight](https://github.com/hanshuqimen/git-fight)，使用 [MIT 许可](LICENSE)。

## 本地运行

建议 Node.js 24 LTS。项目开发依赖已锁定为 Vite 7.3.6、TypeScript 5.9.3 和 Vitest 3.2.7。

```powershell
git clone https://github.com/hanshuqimen/git-fight.git
cd git-fight
npm install
npm run dev
```

访问终端显示的本地地址，默认是 `http://127.0.0.1:5173/`。初始用户名为 `octocat` 和 `torvalds`。

也可使用 pnpm；随项目提供的 `pnpm-lock.yaml` 用于固定完整依赖树。pnpm 的构建脚本策略只允许 esbuild。

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

```powershell
npm test          # Vitest，一次性运行
npm run build    # TypeScript 检查，然后构建到 dist/
npm run preview  # 预览生产构建
```

同名脚本可用 `pnpm run test/build/preview` 执行。`dist/` 可由任意静态 HTTP 服务托管；本项目没有服务端代理，也不要求单文件或断网运行。源码已公开到 GitHub，尚未部署在线站点或发布版本包。

## 使用流程

1. 输入双方用户名，选择操控左侧、操控右侧或自动观战；默认操控左侧。可展开高级设置，填写 PAT 或非负整数 seed；`0` 有效，留空使用开战瞬间的 `Date.now()`。
2. 开战后读取公开信息和仓库列表；页面显示每位玩家的加载阶段。读取期间可以取消。
3. 玩家回合不限时等待选招。使用攻击按钮或数字键 1–4；普通攻击始终可用，语言技能使用后冷却一个己方回合。AI 从可用语言技能中按仓库数加权选择，没有可用语言技能时使用普通攻击。
4. 结果页显示胜负、回合数、最高伤害和 MVP 技能，并生成分享图。
5. “重播本局”使用原 seed、数据快照和选招事件，不再要求操作，不发 API 请求；“再来一局”保留模式和操控方，复用本局数据并生成新 seed；返回配置后再次开战使用五分钟内存缓存或重新获取数据。

默认每次攻击约 3 秒，可选择慢速 4 秒、标准 3 秒、快速 1.8 秒；速度从下一次攻击生效，AI 出招前额外提示约 0.5 秒。P 键或暂停按钮冻结播放和视觉动画；手动模式只能跳过当前攻击动画，自动观战可以直接查看结果，回放可以直接跳至已记录的结果。切屏会取消播放。

页面支持键盘、可见焦点、Escape 关闭规则弹窗、基础响应式和 `prefers-reduced-motion`。减少动效会关闭闪光、震动、快速位移和粒子，保留招式与伤害阅读时间；不会快进整局。不提供移动端专属功能。

## 数值与确定性

```text
HP  = max(100, 所有公开仓库的 stargazers_count 总和)
ATK = max(10, round(commit 数 / 50))

语言按仓库数量降序排列，数量相同按语言名固定排序，取前最多 3 名。
技能倍率 = max(1, 该语言仓库数 / 入选语言仓库数均值)
技能抽取权重 = 该语言仓库数
无语言仓库时：普通攻击，权重 1，倍率 1×。

伤害 = ATK × 技能倍率 × random(0.8, 1.2)
15% 概率暴击：伤害再乘 1.5。
```

语言频次忽略 `language=null`，统计包含 fork 和归档仓库。倍率只执行最低 1× 的约束，不额外设置上限。

ATK 高者先手，相同则左侧先手。每次攻击计一个回合，交替行动，最多 30 次攻击。任一玩家 HP 归零立即结束；达到上限时比较剩余 HP 百分比，相等判平局。内部计算保留精度，显示时才格式化，HP 不会为负数。

最高单次伤害使用扣血前伤害，包含过量伤害；MVP 技能按实际扣除 HP 的累计值排名，平分时取最早出现者。

完整十进制 seed 先用 FNV-1a 哈希，再用 Mulberry32 生成随机数。每回合依次抽取技能、伤害浮动与暴击。纯函数 `simulateBattle(left, right, seed)` 不使用 DOM、时间或 `Math.random()`；自动模式下相同 seed + 相同双方数据产生相同 `BattleLog`。手动模式还需要相同的选招序列。每次攻击固定消耗三个抽样，手动选择替代技能抽样结果，不改变伤害浮动与暴击抽样位置。语言技能冷却恰好覆盖下一个己方回合，再下个己方回合恢复；普通攻击为 1×，无冷却。固定 HP、ATK 和伤害公式保持原样，数据悬殊时仍可能首击结束。GitHub 数据变化后，即便 seed 相同也不保证新开战的结果相同；本局重播保留原快照。

## 数据来源、限流与 PAT

浏览器直接访问 `https://api.github.com`：

- 用户信息：`GET /users/{username}`。
- 仓库列表：`GET /users/{username}/repos?per_page=100&sort=updated`，按 `Link` 取完所有页，以仓库 ID 去重，过滤 private 仓库。
- 提交方案 A：`GET /search/commits?q=author:{username}&per_page=1`，读取 `total_count`。
- 方案 A 请求失败或 `incomplete_results=true` 时，自动降级 B：对最近更新的前 50 个仓库逐个请求 `GET /repos/{owner}/{repo}/commits?per_page=1`，解析 `Link` 末页页码。单页按数组长度计数，明确的空仓库响应计零。

**A 与 B 的统计口径不同。** A 是 GitHub 索引中的作者提交搜索，不是精确的终身贡献总数。B 是用户仓库默认分支的提交数，包含其他作者和 fork 继承的提交；超过 50 个仓库时截断。卡牌、分享图和统计对象会标明降级来源；页面额外显示统计仓库数量和截断状态。不将失败请求静默记为零。

GitHub REST 匿名请求通常为每 IP 每小时 60 次；PAT 通常提高至每小时 5,000 次。搜索有独立额度，匿名通常每分钟 10 次、认证后通常每分钟 30 次；以响应头和 GitHub 最新规则为准。PAT 不能保证避开二级限流。[GitHub 限流文档](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [搜索与不完整结果](https://docs.github.com/en/rest/search/search) · [分页](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

两名玩家、多个分页与降级请求共享串行队列。成功数据缓存五分钟，相同请求共享进行中的任务，失败不缓存；一个调用者取消不会取消其他仍在等待的共享调用者。搜索额度耗尽仍尝试 B；核心额度耗尽时停止请求，显示可用的重置时间。时间使用当前浏览器本地时区。

PAT 为可选密码输入框，**仅存本页面内存**，刷新后清除；不写入 localStorage、sessionStorage、URL、日志、战报或分享图。修改 PAT 清空缓存。Authorization 只发给固定 GitHub API 源；分页地址须通过来源校验，头像限定 GitHub avatar CDN。无第三方脚本或远程字体；GitHub 返回的显示文本经过转义，入口具有 CSP。

401 显示 token 无效/过期；用户 404 显示“用户不存在”；403/429 显示访问受限和可用的重置时间；网络失败、15 秒超时均可重试。不要把含 PAT 的请求头复制到公开问题反馈中。

## 分享图

`renderResultCard(log)` 返回 1200×630 Canvas，包含双方头像、昵称、用户名、初始/最终 HP、ATK、stars、技能、胜负、摘要和 seed。长昵称通过像素宽度测量截断。分享图标注自动/手动模式、操控方及选招记录来源。

头像设置 `crossOrigin="anonymous"` 后再赋 `src`。头像加载超时/失败时使用占位并提示重新生成；正常联网验收必须包含双方真实头像。PNG 使用原生 `toDataURL('image/png')` 下载；CORS 或导出失败会显示恢复操作。

## 工程结构

```text
src/
  api.ts       GitHub 客户端、校验、队列、缓存、降级与错误
  battle.ts    技能生成、逐回合结算、冷却与纯战斗模拟
  types.ts     共享类型、AttackChoice、BattleState 与 BattleLog
  ui.ts        页面状态、选招、事件驱动播放和结果交互
  effects.ts   可取消/暂停播放时钟、确定性视觉特效
  card.ts      Canvas 分享图、头像与 PNG 下载
  main.ts      应用入口
  style.css    深色竞技场与基础响应式样式
tests/
  api.test.ts
  battle.test.ts
  effects.test.ts
  browser/    仅开发模式使用的明确标注模拟数据的验收页面
```

UI 向纯战斗核心提交带预期回合编号的 AttackChoice，并消费返回的 BattleEvent；不决定伤害或胜负。重播只消费已完成的 BattleLog。

纯接口：`createBattle(left, right, seed, options)` 创建不可变状态；`getAvailableActions(state, side?)` 返回可用攻击及冷却；`resolveTurn(state, command?)` 结算一次攻击，玩家 command 为 `{ round, choice }`（普通攻击 `{ kind: "basic" }`，语言技能 `{ kind: "skill", index }`）；`finishBattle(state)` 仅接受已结束状态。过期、重复、冷却中或不属于玩家回合的指令会被拒绝且不修改原状态。Canvas 特效采用独立的 seed/回合视觉随机流，与战斗 RNG 分离；语言对应棱镜、电弧、火花、涡旋或通用脉冲。一个攻击最多 96 个粒子，设备像素倍率限制为 2；ResizeObserver 更新画布与攻击位置，退出时断开。

每次切屏会取消旧网络或播放任务，分享图生成具有版本检查，迟到的异步结果不会覆盖当前屏幕。Vite 排除测试产物目录，避免 Windows 正在下载的 PNG 被文件监听器占用。

## 测试与验收记录

2026-10-04，Windows / Node 24：

- Vitest：40 项通过，覆盖战斗边界、确定性、先手、击倒、30 回合收敛、倍率、伤害、MVP，新增逐回合与自动模拟一致性、手动选招复现、双方冷却、AI 加权/普通攻击降级、过期指令拒绝、时钟暂停恢复/取消/跳过无残留；以及 API 分页、去重、缓存过期、PAT 切换、降级、50 仓库上限、限流、404、401、超时、网络错误、共享取消和串行队列。
- TypeScript strict 检查与生产构建通过，禁止 `any`。
- 模拟浏览器流程：真实 Canvas 包含两张 GitHub CDN 头像，PNG 能下载且尺寸为 1200×630；seed 42 的战报重播一致且没有新 API 请求；用户不存在、网络失败、取消加载、跳过、返回配置、头像占位重试均已检查。
- 独立 Chrome 冒烟脚本全部通过，375/768/1024/1440 宽度无横向溢出；长昵称和 HTML 样式文本安全显示。左右操控、数字键、连点保护、不限时等待、一个己方回合的冷却、暂停恢复、动画取消、自动 30 回合、暴击特写、击倒、减少动效与 Escape 关闭弹窗均通过，没有页面脚本异常。
- 生产构建在独立浏览器中使用模拟 API 路由检查通过：实际入口的 CSP 允许 GitHub 头像、Canvas 和 PNG 下载；seed=0 有效，重播不发新请求，404 恢复正常。这里仍属于模拟 API 验收。
- **真实 `octocat` 对 `torvalds` 完整联网流程尚未通过验收**：两次重试真实 `GET /users/octocat` 都返回 403；首次显示重置时间 2026-10-04 21:00:43，在该时间之后重试仍受限，最新显示 21:13:37（Asia/Shanghai）。没有页面脚本异常；此前直接 API 检查已确认匿名核心额度 remaining=0。本记录没有把模拟结果计作真实数据验收。

开发验收页：先启动开发服务器，再访问 `/tests/browser/`；顶栏明确标明模拟数据，支持切换异常模式、30 回合、一击击倒和无语言场景。`?motion=reduce` 用于模拟减少动效偏好。该入口不会进入 `dist/`。

若已有 Microsoft Playwright CLI，可执行可重复的浏览器冒烟检查：

```powershell
# 开发服务端口必须与验收脚本一致
pnpm run dev --port 5176 --strictPort

# 在另一终端运行
playwright-cli -s=git-fight-qa open http://127.0.0.1:5176/tests/browser/ --browser=chrome
playwright-cli -s=git-fight-qa run-code --filename tests/browser/smoke.cjs
playwright-cli -s=git-fight-qa close
```

脚本检查手动/自动对战、双方操控、冷却、快捷键、连点保护、暂停、跳过、暴击/击倒、回放、下载、异常恢复、长昵称、375/768/1024/1440 宽度、减少动效与弹窗键盘操作。截图和下载产物保存在 `output/playwright/`，不进入版本控制。

生产入口的模拟 API 验收可在 `npm run build` 后，用 `pnpm run preview --port 4176 --strictPort` 启动，再执行 `playwright-cli -s=git-fight-qa run-code --filename tests/browser/production.cjs`。它使用独立浏览器的临时路由，不修改生产代码或添加模拟数据开关。

真实联网验收脚本：开发服务启动后，执行 `playwright-cli -s=git-fight-qa run-code --filename tests/browser/live.cjs`。它不拦截请求、不填写 PAT；成功时检查实际头像与 PNG，受限时记录真实错误，不将限流提示计作流程通过。

## TODO


- 在匿名额度恢复后，或由使用者填写有效 PAT，再验收真实 octocat / torvalds 的完整流程与不存在用户的真实 404；不在项目中保存测试 token。
- 讨论统一 A/B 的提交统计口径；当前严格保留指定 API 和公式。
- 如未来扩展范围，再考虑显式导出/导入数据快照以支持跨刷新回放；当前不持久化历史。
- 如未来需要，再增加移动端专属交互与更完善的移动体验。
- 在独立娱乐模式中讨论数值平衡；当前保留原公式，不通过视觉升级改变 GitHub 数值。
- 如需更多策略，再讨论防御、状态效果或资源系统；当前只提供攻击与冷却。

## License

[MIT](LICENSE)。公开 GitHub 指标与对战结果仅供娱乐。
