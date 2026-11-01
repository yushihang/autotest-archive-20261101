# MVP 人工验收清单

> 这份清单回答一个问题：**怎么算「MVP 能用了」**。不看谁的口头保证，只看能不能照着敲出证据。
>
> 版本：2026-11-01（对应 issue #118：CLI 编排 + PR diff 护栏 + 本地验收脚本）

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| Node.js | >= 20 | `node --version` |
| 依赖 | 已 `npm install` | `node -e "import('playwright')"` 不报错 |
| 网络 | 能跑本地 demo-app（`127.0.0.1:4173`），不访问外网 | — |
| git | 干净的工作区（`--pr` 模式才会用到） | `git status --porcelain` 无输出 |
| gh | 已安装并 `gh auth login`（只有 `--pr` 需要） | `gh auth status` |

## 1. 一键验收：`npm install` 后 `./scripts/verify-mvp.sh` 跑通

```bash
npm install
./scripts/verify-mvp.sh
echo $?   # 期望 0
```

脚本固定做四件事：

1. 检查 Node 版本 >= 20、playwright 可加载；
2. 起 `demo-app/server.mjs`（默认 4173，可用 `PORT=5000` 覆盖），轮询 `/health` 直到就绪；
3. 用生成的临时配置跑 `node src/cli.mjs run --config ... --dry-run`；
4. 打印报告路径与通过 / 失败 / flaky / 错误计数，退出时清理 demo-app 进程。

**通过标准：**

- [ ] 退出码为 0；
- [ ] 终端出现了 `✓ MVP 验收通过`；
- [ ] 打印出的报告路径确实存在，`autotest-output/verify-mvp/report.md` 非空；
- [ ] `autotest-output/verify-mvp/specs/` 下生成了 `*.spec.mjs`（本次至少一条用例通过时）；
- [ ] 跑完 `git status --porcelain` 没有新增未忽略文件——dry-run 不碰工作区。

**失败时怎么读：**脚本任何一步失败都返回非 0。CLI 退出码为 1 表示「有用例失败 / 运行被中止」，
此时报告里逐条写了输入、期望、实际和截图，先判断是业务 bug、用例写错还是环境问题；
退出码为 2 是参数 / 配置 / PR 阶段错误，看终端最后一行的 `✗` 信息。

## 2. `--pr` 模式下 `git diff --name-only` 只含测试文件

在**干净的工作区**里（先 commit 或 stash 自己的改动）：

```bash
node src/cli.mjs run --config autotest.config.json --pr
git diff --name-only "$(git merge-base HEAD origin/main)"..HEAD
```

**通过标准：**

- [ ] CLI 打印了分支名 `autotest/<runId>`、commit 和 PR 地址；
- [ ] `git diff --name-only` 输出的每一行都以 `test/`（即配置里的 `testsDir`）开头，没有一行业务代码；
- [ ] 新建 PR 的标题形如 `test: 给 <模块> 补 <N> 条用例`；
- [ ] PR 正文包含：覆盖清单、未覆盖及原因、失败用例证据（没有失败时写「无失败或 flaky 用例」）。

**护栏怎么起作用：**`src/pr/guard.mjs` 的 `assertOnlyTests(changedFiles, testsDir)` 会在
push 之前检查提交实际改动的文件。任何 `<testsDir>` 之外的文件（新增、修改、删除都算）都会
让它抛错，CLI 随即中止，**不会 push**。这个护栏没有 `--force`、环境变量或参数可以跳过——
想绕过只能改代码，那就要走 review。

手动验证护栏本身（不需要真的开 PR）：

```bash
node -e "
import('./src/pr/guard.mjs').then(({ assertOnlyTests }) => {
  // 应该抛错：业务文件不在白名单里
  try { assertOnlyTests(['test/a.spec.mjs', 'src/config.mjs'], 'test/'); console.log('✗ 没拦住'); }
  catch (error) { console.log('✓ 拦住了：', error.offending); }
});
"
```

## 3. 报告里能读到覆盖清单与失败证据

打开 `<output.dir>/report.md`（默认 `autotest-output/report.md`）：

- [ ] 「覆盖清单」按 P0 / P1 / P2 分组，每条用例能对上 `TestCase.id` 和标题；
- [ ] 「未覆盖」写明原因：不稳定的选择器、超出 `limits.maxCases` 被截断、执行阶段跳过、没有结果；
- [ ] 失败用例有证据块：输入、期望、实际、最小复现步骤，以及截图 / console 错误（有的话）；
- [ ] flaky 单独归类，没有混进失败结论；
- [ ] 「本次运行的时间与步数用量」有总耗时、执行步数、跳过数；预算中止时明确写出中止原因。

生成 spec 只覆盖 `passed` 的用例；`failed` / `flaky` / `error` 的用例不会写进测试代码，
但必须在报告的未覆盖 / 失败证据里找到——不能凭空消失。

## 4. 已知不支持项（不接受、不假装支持）

以下场景**不在 MVP 范围内**。遇到时应明确报「不支持」，而不是生成一个看起来能跑、
实际什么都没验证的用例：

| 场景 | 现状 | 影响 |
|---|---|---|
| 跨域（CORS / 多 origin） | 只探测 `target.baseUrl` 同源页面，外链直接跳过 | 第三方登录、跨域 iframe 流程测不了 |
| OAuth / 第三方登录 | 不支持；登录页只按同源表单处理 | 需要跳转外部授权页的流程无法覆盖 |
| iframe | 只采集主文档的可交互元素，不进入 iframe | 嵌在 iframe 里的表单 / 列表没有用例 |
| canvas / WebGL | 只认 DOM 元素，canvas 内部无法探测 | 图表、画板、游戏类界面没有用例 |
| 视觉回归 | 不做像素比对；截图只作为失败证据 | 样式错位、布局回归查不出来 |

另外两条边界（与 README 的「边界」一节一致）：

- **不修改业务代码，也不自动修 bug**：失败只报告，判断责任在人。
- **不自动跳过失败用例**：`skip` / `only` 不会由工具写进 PR。

## 5. 一次完整的人工验收记录（建议照抄）

```text
日期：
执行人：
Node 版本：
命令：./scripts/verify-mvp.sh
退出码：
报告路径：
通过 / 失败 / flaky / 错误：
--pr 验证（如执行）：分支、PR 地址、git diff --name-only 是否只含 test/
结论（通过 / 阻塞项）：
```

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| [`src/cli.mjs`](../src/cli.mjs) | 编排入口，默认 dry-run，`--pr` 才动 git |
| [`src/pr/guard.mjs`](../src/pr/guard.mjs) | `assertOnlyTests`：PR 里只有测试的硬护栏 |
| [`src/pr/create.mjs`](../src/pr/create.mjs) | 建分支、提交、guard、push、`gh pr create` |
| [`scripts/verify-mvp.sh`](../scripts/verify-mvp.sh) | 本节第 1 条的一键验收脚本 |
| [`docs/config.md`](config.md) | 配置字段与 `testsDir` 的约束 |
