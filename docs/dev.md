# 开发命令

两个本地校验命令：`npm run lint` 查语法，`npm test` 跑单元测试。提交前两个都跑一遍。

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run lint` | 全仓库 `.mjs` 语法检查 | 无，只要 Node.js >=20 |
| `npm test` | 跑 `tests/` 下的单元测试 | 先 `npm install` |

## `npm run lint`

`package.json` 里是：

```bash
node --check scripts/check.mjs && node scripts/check.mjs
```

前半段先自检门禁脚本本身，后半段才是真正的检查：

- 从仓库根目录递归收集所有 `.mjs` 文件，逐个跑 `node --check`。**只做语法解析，不执行文件**，所以 `demo-app/server.mjs` 这类带副作用的模块也能安全过一遍。
- 扫哪些文件由目录遍历决定，不在 `package.json` 里点名——新增模块不用回来改命令，也不会因为漏改一行而悄悄漏检。
- 跳过 `.` 开头的目录，以及 `node_modules`、`coverage`、`test-results`、`playwright-report`、`autotest-output`（别人的文件或生成物）。
- 不在第一个错处停下：一次把所有失败文件都打出来，修一轮就够。

通过时输出 `✓ N 个 .mjs 文件语法检查通过。`，退出码 0；有文件解析失败时逐个打印 `✗ 路径` 和原始报错，最后一行给出 `失败数/总数`，退出码 1。一个文件都没扫到也按失败处理（退出码 1），避免遍历逻辑坏了却静默通过。

这个命令**不需要 `npm install`**：脚本只用 `node:child_process` / `node:fs` / `node:path` 等标准库。

范围说明：只检查 `.mjs` 的**语法**。类型错误、未使用的变量、代码风格、JSON 与 Markdown 的格式都不在范围内。`npm run lint` 绿了不等于逻辑正确，那要靠 `npm test`。

## `npm test`

实际执行 `playwright test`，用例在 `tests/`：

- `tests/config.test.mjs`——`loadConfig()` 的校验与规范化，覆盖每条错误分支。
- `tests/package.test.mjs`——仓库元数据自查：script 指向的本地文件存在、直接依赖写死精确版本、`playwright` 与 `@playwright/test` 版本一致、声明 MIT 就有 `LICENSE`。
- `tests/types.test.mjs`——三个共享契约的常量。

这些是**单元测试，不启动浏览器**。`@playwright/test` 在这里只当测试运行器用，所以装完依赖就能跑，不需要额外 `npx playwright install` 下载浏览器。

首次运行前需要 `npm install`（`@playwright/test` 是 devDependency）；之后改代码直接跑即可。断言失败时退出码非 0，并打印失败用例与差异。

## 该跑哪个

- 改了任意 `.mjs`：`npm run lint` 至少能挡住语法错误，再跑 `npm test` 看行为有没有变。
- 只改文档、JSON、`.gitignore`：两个命令都不覆盖这些文件，仍然建议跑一遍，确认没有顺带改坏脚本或 `package.json`。
