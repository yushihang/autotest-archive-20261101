# 契约验证指南

三个契约是模块之间唯一的接口：探测产出 `Inventory`，规划产出 `TestCase[]`，执行产出 `RunResult`。它们只用 JSDoc `@typedef` 写在 [`src/types.mjs`](../src/types.mjs) 里，没有 JSON Schema，也没有编译步骤，所以改完到底有没有破坏契约，得有一组能照着敲的命令。

本文只讲怎么验证。字段语义、为什么只增不改，看 [`src/types.mjs`](../src/types.mjs) 的文件头注释（以及各 `@typedef` 里每个 `@property` 的说明）。

## 先看结论

| 场景 | 至少跑什么 |
|---|---|
| 手上没有 Node（只 review diff、改文档） | 下面「无 Node 的静态检查」，或直接跑其中第 5 节那一段脚本 |
| 有 Node，改了任意 `.mjs` | `npm run lint` + `npm test` |
| 改了 `src/types.mjs` 里任一个契约 | 静态检查 + `npm test -- tests/types.test.mjs tests/plan.test.mjs` |
| 改了 `Inventory` 的形状 | 再加「有 Node 时」里的手工冒烟，确认规划器还能吃下 fixture |
| 只改 Markdown / JSON | 静态检查；有 Node 的话仍然建议跑一遍 lint 和 test |

## 契约清单

| 契约 | 定义（都在 `src/types.mjs`） | 谁产出 | 谁消费 | 现在谁在验 |
|---|---|---|---|---|
| `Inventory` | `Inventory` / `InventoryElement` / `InventoryRoute` | 探测（未实现） | 规划 `src/plan/index.mjs` | 静态检查；`tests/plan.test.mjs` 把 `fixtures/inventory.sample.json` 当合法输入 |
| `TestCase[]` | `TestCase` / `TestStep` / `Priority` / `StepAction` / `WaitState` | 规划 | 执行（未实现） | `tests/plan.test.mjs` 校验形状与排序，`tests/types.test.mjs` 校验常量 |
| `RunResult` | `RunResult` / `Attempt` / `Evidence` / `RunStatus` / `AttemptStatus` | 执行（未实现） | 报告（未实现） | 只有静态检查 + 常量取值 |

「未实现」不是偷懒的措辞：仓库里现在只有 `src/config.mjs`、`src/types.mjs`、`src/plan/`，没有探测端和执行端。所以 `Inventory` / `RunResult` 目前**没有真实产出可测**，这一点在「现在还没有自动化覆盖的部分」展开。

## 无 Node 的静态检查

静态检查只能回答一个问题：**契约定义里的字段、运行时常量和消费方的接线还在不在**。它查不出类型写错、调用方漏改、fixture 与契约不一致——那些要靠后面的 `npm test`。但在没有 Node、或者只想快速看一眼 diff 的环境里，它能挡住「顺手删了个字段」这类最常见的破坏。

以下命令都在**仓库根目录**执行。

### 1. 三个契约块还在

```bash
rg -n '@typedef \{object\} (Inventory|TestCase|RunResult)$' src/types.mjs
```

期望 3 行，分别指向 `Inventory`、`TestCase`、`RunResult`。行号会随文件增长变化，只对数量：

```bash
rg -c '@typedef \{object\} (Inventory|TestCase|RunResult)$' src/types.mjs   # 期望输出 3
```

没装 ripgrep 的机器用 grep，模式等价：

```bash
grep -cE '@typedef \{object\} (Inventory|TestCase|RunResult)$' src/types.mjs
```

### 2. 必填字段逐个点名

JSDoc 里的 `@property` 是契约的正文。少一个必填字段，消费方就会拿到 `undefined`，而语法检查完全发现不了。

```bash
# Inventory：四个必填字段
for field in baseUrl generatedAt routes elements; do
  rg -q "@property \{[^}]+\} ${field}\b" src/types.mjs || echo "Inventory 缺字段：${field}"
done

# TestCase：六个必填字段
for field in id title priority steps expect sourceElement; do
  rg -q "@property \{[^}]+\} ${field}\b" src/types.mjs || echo "TestCase 缺字段：${field}"
done

# RunResult：四个必填字段
for field in caseId status attempts evidence; do
  rg -q "@property \{[^}]+\} ${field}\b" src/types.mjs || echo "RunResult 缺字段：${field}"
done
```

没有任何输出就是通过。有输出时，把字段名和 `src/types.mjs` 里对应的 typedef 对一遍：是改名了、挪到别的块里了，还是被删了。

这个检查的边界要说清楚：它只确认「这个名字在文件里出现过」。`status` 同时出现在 `InventoryRoute`、`Attempt`、`RunResult` 上，所以单独看它证明不了 `RunResult.status` 还在原位。严格的块内检查交给第 5 节的脚本（逐条固定字符串匹配），完整的形状校验交给 `npm test`。

### 3. 运行时常量仍导出且冻结

```bash
rg -n 'export const (PRIORITIES|RUN_STATUSES|ATTEMPT_STATUSES|ELEMENT_KINDS|STEP_ACTIONS|WAIT_STATES) = Object\.freeze' src/types.mjs
```

期望 6 行。规划器用 `ELEMENT_KINDS`、`STEP_ACTIONS` 做校验，未来的执行端也会用 `RUN_STATUSES`、`ATTEMPT_STATUSES` 汇总结论；这些常量一旦被改名、解冻或去掉 `export`，消费方会在运行时才炸。没有 Node 时，上面这条命令是唯一的早期信号。

### 4. 规划器没有绕开契约

```bash
# 规划器的相对导入只应该有两种：契约模块与同层规则表
rg -n "from '\.\.?/" src/plan/index.mjs

# 规划的对外入口仍然只有这两个
rg -n 'export function (planCases|planCasesReport)' src/plan/index.mjs
```

期望前者 2 行：`../types.mjs`（契约）和 `./rules.mjs`（同层规则表）；后者 2 行。多出别的相对导入，说明有人开始跨层直接调用了，契约就不再是唯一接口。

### 5. 一条命令跑完（grep 版，不需要 Node，也不需要 rg）

把下面这段贴进 shell，或者存成临时脚本执行。用的是 `grep -F` 固定字符串，GNU grep 和 BusyBox 都支持：

```bash
set -u
TYPES=src/types.mjs
fail=0
has() { grep -qF -- "$1" "$TYPES" || { echo "✗ 缺少：$2"; fail=1; }; }

# 契约块
has '@typedef {object} Inventory' 'Inventory 契约'
has '@typedef {object} TestCase' 'TestCase 契约'
has '@typedef {object} RunResult' 'RunResult 契约'

# Inventory 必填字段
has '@property {string} baseUrl' 'Inventory.baseUrl'
has '@property {string} generatedAt' 'Inventory.generatedAt'
has '@property {InventoryRoute[]} routes' 'Inventory.routes'
has '@property {InventoryElement[]} elements' 'Inventory.elements'

# TestCase 必填字段
has '@property {string} id ' 'TestCase.id'
has '@property {string} title ' 'TestCase.title'
has '@property {Priority} priority' 'TestCase.priority'
has '@property {TestStep[]} steps' 'TestCase.steps'
has '@property {string[]} expect ' 'TestCase.expect'
has '@property {string} sourceElement ' 'TestCase.sourceElement'

# RunResult 必填字段
has '@property {string} caseId ' 'RunResult.caseId'
has '@property {RunStatus} status ' 'RunResult.status'
has '@property {Attempt[]} attempts' 'RunResult.attempts'
has '@property {Evidence} evidence' 'RunResult.evidence'

# 运行时常量：导出 + 冻结
for name in PRIORITIES RUN_STATUSES ATTEMPT_STATUSES ELEMENT_KINDS STEP_ACTIONS WAIT_STATES; do
  grep -qE "^export const ${name} = Object\.freeze" "$TYPES" \
    || { echo "✗ 常量 ${name} 未导出或未冻结"; fail=1; }
done

# 规划器仍然只依赖契约模块
grep -qF "from '../types.mjs'" src/plan/index.mjs \
  || { echo '✗ 规划器没有从契约模块导入'; fail=1; }

if [ "$fail" -ne 0 ]; then echo '契约静态检查失败'; exit 1; fi
echo '✓ 三个契约的定义、必填字段与运行时常量都在。'
```

通过时最后一行是 `✓ 三个契约的定义、必填字段与运行时常量都在。`，退出码 0；任何一条缺失都会打印 `✗`，最后 `exit 1`，可以直接接进任何 shell 脚本或 CI。注意 `has` 里几个带尾随空格的模式（如 `'@property {string} id '`）是有意的——用来避开同名前缀，别顺手删掉。

## 有 Node 时

前置条件：Node.js >= 20（`package.json` 的 `engines`）。首次跑测试前先 `npm install`，装的是 `@playwright/test`；之后改代码直接跑即可。

### `npm run lint`

实际执行 `node --check scripts/check.mjs && node scripts/check.mjs`，递归给仓库里所有 `.mjs` 跑一遍语法解析，**只解析不执行**。

| 覆盖 | 不覆盖 |
|---|---|
| 任意 `.mjs` 的语法错误 | 类型错误、未使用变量、代码风格 |
| `package.json` 里 script 指向的脚本本身 | JSON / Markdown 的格式 |
| 新增模块（目录遍历自动纳入） | 契约是否被破坏——那是 `npm test` 的事 |

这个命令不需要 `npm install`，只用 Node 标准库。它绿了只说明「文件能被解析」，别当成契约通过。

### `npm test`

实际执行 `playwright test`，跑的是 `tests/` 下的**单元测试，不启动浏览器**，所以装完依赖就能跑，不需要 `npx playwright install`。

```bash
npm test                                  # 全部
npm test -- tests/types.test.mjs          # 只验契约常量
npm test -- tests/plan.test.mjs           # 只验规划器与 TestCase 形状
```

各文件对契约的意义：

| 文件 | 钉住什么 | 对应契约 |
|---|---|---|
| `tests/types.test.mjs` | `ATTEMPT_STATUSES` 里没有 `flaky`；`ATTEMPT_STATUSES` 恰好是 `RUN_STATUSES` 去掉 `flaky`；`WAIT_STATES` 取值；六组常量都被 `Object.freeze` | `TestCase` / `RunResult` 的枚举 |
| `tests/plan.test.mjs` | 同一份 `Inventory` 规划两次结果深相等；每条用例满足 `TestCase` 形状（非空 `steps`、`goto` 在首位、非空 `expect`、`id` 唯一）；`maxCases` 截断报告；`unstable` 元素原样进报告；`select` 不静默 0 条 | `Inventory` 输入、`TestCase[]` 输出 |
| `tests/generate-specs.test.mjs` | 只有 `passed` 生成 spec；同输入字节级一致；断言非空且不是标题断言；引号 / 换行转义；按路由分文件 | `TestCase[]` / `RunResult[]` 的输出消费方 |
| `tests/report-markdown.test.mjs` | 覆盖清单按优先级；未覆盖原因（unstable / `maxCases` / 执行跳过）；失败证据五项；flaky 单列；时间与步数用量 | `TestCase[]` / `RunResult[]` 的输出消费方 |
| `tests/package.test.mjs` | npm script 指向的本地文件存在、依赖是精确版本、`playwright` 与 `@playwright/test` 版本一致 | 仓库本身的可用性 |
| `tests/config.test.mjs` | `loadConfig()` 的校验与规范化，每条错误分支 | 配置，不是三个契约 |

断言失败时退出码非 0，并打印失败用例与差异。

### 手工喂一份 `Inventory`（不跑浏览器）

想直接看规划器吐出来的 `TestCase[]` 长什么样，用仓库里的 fixture 跑一次：

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { planCasesReport } from './src/plan/index.mjs';

const inventory = JSON.parse(readFileSync('fixtures/inventory.sample.json', 'utf8'));
const report = planCasesReport(inventory, { maxCases: 5 });

console.log(JSON.stringify({ total: report.total, kept: report.cases.length, dropped: report.dropped }, null, 2));
console.log(JSON.stringify(report.cases[0], null, 2));
"
```

规划器本身只依赖标准库和 `src/types.mjs`，没 `npm install` 也能跑；只有跑 `npm test` 才需要装依赖。输出里第一条用例应当同时含 `id`、`title`、`priority`、`steps`、`expect`、`sourceElement` 六个字段——这就是 `TestCase` 契约的必填项。临时改 fixture 里的字段观察规划器反应，比读规则表快。

## 按改动类型选检查

| 改动 | 至少跑 | 备注 |
|---|---|---|
| 只改 Markdown / `.gitignore` | 静态检查 | `npm run lint` 不覆盖这些文件，但改完仍建议有 Node 就跑一遍全量 |
| 改 `src/types.mjs` 的字段或常量 | 静态检查 + `npm test -- tests/types.test.mjs tests/plan.test.mjs` + 手工冒烟 | 字段只增不改；要换语义就新开字段 |
| 改 `src/plan/**` | `npm run lint` + `npm test` | 规划是纯函数，测试不碰浏览器 |
| 改 `fixtures/inventory.sample.json` | `npm test -- tests/plan.test.mjs` | fixture 是 `Inventory` 的样例输入，字段缺了规划器会降级而不是报错 |
| 新增探测 / 执行模块 | 静态检查 + 新增对应用例，并回来更新本文「契约清单」的「谁产出 / 谁消费 / 现在谁在验」 | 这三列现在还标着「未实现」，补上才算接进验证路径 |

## 现在还没有自动化覆盖的部分

把没测的说清楚，比假装都测了有用：

- **`Inventory` 的真实产出**：探测未实现。`fixtures/inventory.sample.json` 是手写的，字段齐全不代表探测端能产出这些字段。
- **`RunResult` 的产出与 `flaky` 汇总**：执行端未实现。目前只钉住 `RUN_STATUSES` / `ATTEMPT_STATUSES` 的取值和关系，没有任何一条真实结果被断言。
- **字段类型**：JSDoc 不参与运行，静态检查只看名字，`npm test` 也只断言常量和规划输出，不校验任意 JSON 是否满足 typedef。传进来的脏数据由各模块自己规范化（例如规划器把未知 `kind` 归为 `other`）。
- **向后兼容**：没有 schema diff 工具，也没有版本号字段。契约变更是否破坏下游，只能靠 review；这也是「字段只增不改」写成硬规则的原因。

所以契约改动的 review 重点仍然是人。本文的命令只是把「忘了改」从口头提醒变成会红的信号。

## 常见误判

- **`rg` 有命中 ≠ 字段被消费。** 名字还在，消费方可能已经不用它了；只有 `npm test` 能证明行为没变。
- **`npm run lint` 绿 ≠ 契约没坏。** 它只做 `.mjs` 语法解析，字段删了照样绿。
- **`npm test` 绿 ≠ `RunResult` 没坏。** 执行端还没实现，没有产出可测，见上一节。
- **静态检查脚本不是测试。** 它是 grep，不是类型系统；改字段名时它只能告诉你「旧名字没了」，不会告诉你「该改的地方都改了」。

相关阅读：[`docs/dev.md`](dev.md)（lint 与 test 的完整行为）、[`README.md`](../README.md)（契约为什么这么定）。
