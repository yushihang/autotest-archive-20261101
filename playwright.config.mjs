/**
 * @file 本仓库自己的测试配置。
 *
 * 只跑 tests/ 下的单元测试。给 target 仓库生成的用例落在配置里的 testsDir（默认 test/），
 * 两者不是一回事，别混。
 *
 * 这里的用例都不开浏览器：配置校验和契约是纯逻辑，`playwright test` 只当测试框架用。
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // PR 里混进 .only 会让其余用例静默不跑，CI 上直接失败。
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : 'dot',
});
