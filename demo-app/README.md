# demo-app

零依赖的本地 demo web 应用，用作 probe / runner / 生成测试代码的共同「靶子」。
不联网、无第三方依赖、无构建步骤；所有状态只存在页面内存里，刷新即重置，用例之间互不污染。

## 启动

```bash
node demo-app/server.mjs                        # 默认 http://127.0.0.1:4173
node demo-app/server.mjs --port 5000            # 指定端口
node demo-app/server.mjs --port=5000            # 等价写法
node demo-app/server.mjs --host 0.0.0.0         # 放开监听地址（默认只监听回环）
node demo-app/server.mjs --host=0.0.0.0 --port=5000
```

启动成功后 stdout 只打印一行（回显实际生效的 host 与 port）：

```
listening on http://127.0.0.1:4173
```

也可以直接用浏览器打开 `demo-app/index.html`（`file://` 下行为一致）。

服务默认只监听 `127.0.0.1`；runner 与浏览器分容器 / 分 network namespace 时用 `--host 0.0.0.0`。
`GET /health`（忽略查询串）固定返回 `200` + `{"ok":true}`，供编排与测试判断靶子是否就绪；
该端点优先于静态文件解析，即使目录内存在同名文件也不会被遮蔽。

只提供 `demo-app/` 目录内的静态文件；`GET` / `HEAD` 之外的方法返回 405，路径越界返回 403，
请求路径无法解码返回 400，找不到文件返回 404，其他文件系统错误（如权限不足）返回 500 并在 stderr 留一行日志。
收到 `SIGINT` / `SIGTERM` 时先停止接受新连接、断开空闲的 keep-alive 连接，最多 1s 后强制退出。

## 页面行为

### 登录

| 输入 | 结果 |
| --- | --- |
| 邮箱为空 | 显示错误，阻止提交 |
| 密码为空 | 显示错误，阻止提交 |
| 邮箱不包含 `@` | 显示错误，阻止提交 |
| 邮箱 + 密码合法 | 隐藏 `#login-section`（连同 `#login-form`），显示 `#welcome`，文本为 `欢迎，<email>` |

- 错误提示显示在 `#login-error`（`role="alert"`），提交失败时表单保持可见。
- 错误信息依次为：`请输入邮箱地址`、`请输入密码`、`邮箱格式不正确`。
- 邮箱会去掉首尾空白后参与校验，密码只判空、不做其他规则。
- 用户改正输入后（`#email` / `#password` 的 `input` 事件）旧错误立即清除，不必等到再次提交。
- 登录成功时同时写入常驻的 `#login-status`（`role="status"`、视觉隐藏但保留在无障碍树里），
  由它负责读屏播报；`#welcome` 只承担视觉呈现。

### 待办

- 输入为空或只有空白：不添加任何条目。
- 点击「添加」或在输入框按 Enter：追加一条未完成待办，并清空输入框。
- 输入法正在组字时按 Enter（`event.isComposing === true` 或 `keyCode === 229`）只是上屏候选词，
  不会添加待办、也不会清空输入框。
- 标题可以重复，每条待办独立（独立的勾选与删除）。
- 删除：该条目从列表中移除，列表项数量减少。
- 勾选：条目变为已完成；在「已完成」过滤下可见，在「未完成」过滤下不可见。
- 过滤器「全部 / 未完成 / 已完成」：列表只渲染符合当前过滤器的条目，切换后立即生效。
- 列表整表重建后焦点会落回原来的控件：勾选后仍停在该勾选框；若该条目因过滤而消失、
  或该条目被删除，则落到原位置的下一条（没有下一条就取上一条，列表空了就回到 `#todo-input`），
  纯键盘操作不会掉回 `body`。
- 所有状态均为页面内存状态，刷新后重置（没有 localStorage / cookie / 随机数 / 时间戳）。

## 稳定选择器

| 选择器 | 说明 |
| --- | --- |
| `#login-form` | 登录表单 |
| `#email` | 邮箱输入框 |
| `#password` | 密码输入框 |
| `#login-submit` / `[data-testid="login-submit"]` | 登录按钮 |
| `#login-error` | 错误提示（`role="alert"`，无错误时带 `hidden`） |
| `#login-status` | 登录成功的读屏播报区（`role="status"`，视觉隐藏） |
| `#welcome` | 登录成功后的欢迎区（初始带 `hidden`） |
| `#welcome-text` | 欢迎文案 |
| `#todo-input` | 待办输入框 |
| `#todo-add` / `[data-testid="todo-add"]` | 添加按钮 |
| `#todo-list` / `[data-testid="todo-list"]` | 待办列表 `<ul>` |
| `#login-section` / `#todo-section` | 登录区 / 待办区容器（登录成功后 `#login-section` 带 `hidden`） |

待办项为 `<li id="todo-<n>" data-testid="todo-item" data-completed="true|false">`（`n` 从 1 递增）：

| 选择器 | 说明 |
| --- | --- |
| `[data-testid="todo-item"]` | 待办项 |
| `[data-testid="todo-toggle"]` | 完成勾选框（`#todo-<n>-toggle`） |
| `[data-testid="todo-title"]` | 待办标题文本 |
| `[data-testid="todo-delete"]` | 删除按钮（`#todo-<n>-delete`） |

过滤器按钮：`[data-filter="all"]`、`[data-filter="active"]`、`[data-filter="completed"]`，
当前选中的按钮 `aria-pressed="true"`。

## 文件

- `index.html` — 页面结构与最小样式
- `app.js` — 登录校验与待办逻辑（无框架、无构建）
- `server.mjs` — `node:http` + `node:fs` 静态文件服务
