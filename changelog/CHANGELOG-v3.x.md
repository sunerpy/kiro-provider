# Changelog

## [3.5.2](https://github.com/sunerpy/kiro-provider/compare/v3.5.1...v3.5.2) (2026-09-17)


### Bug Fixes

* **auth:** 修复 IDC profile 与 Claude reasoning 回放 ([b455cf6](https://github.com/sunerpy/kiro-provider/commit/b455cf6265a64cb6e1da8d64907dec6d3448c930))
* **auth:** 修复 IDC profile 与 Claude reasoning 回放 ([3946a0b](https://github.com/sunerpy/kiro-provider/commit/3946a0b3c5cddd6b15f312136ef80f541396b4b1))
* **auth:** 禁止 relogin 更换既有 profile ([65a4ad2](https://github.com/sunerpy/kiro-provider/commit/65a4ad2809762efb011c9f20b354512d2f29f68a))

## [3.5.1](https://github.com/sunerpy/kiro-provider/compare/v3.5.0...v3.5.1) (2026-09-16)


### Bug Fixes

* **models:** 为 Fable 开放 Codex Ultra ([6c0240a](https://github.com/sunerpy/kiro-provider/commit/6c0240aca681738080759ab02ec290380f0cbaf2))
* **models:** 为 Fable 开放 Codex Ultra ([8e97e80](https://github.com/sunerpy/kiro-provider/commit/8e97e80f2f7427c219ea8e0bafabf823c957d327))

## [3.5.0](https://github.com/sunerpy/kiro-provider/compare/v3.4.3...v3.5.0) (2026-09-16)


### Features

* **claude:** 支持 GPT 晚签名与 Fable 5.1 ([a23f0fd](https://github.com/sunerpy/kiro-provider/commit/a23f0fd797e46c85044593ec545ecd0ceadc4368))
* **claude:** 支持 GPT 晚签名与 Fable 5.1 ([f5185a3](https://github.com/sunerpy/kiro-provider/commit/f5185a33c571f2e3ac5febfbf07cf6663fcbf857))

## [3.4.3](https://github.com/sunerpy/kiro-provider/compare/v3.4.2...v3.4.3) (2026-09-16)


### Bug Fixes

* **pipeline:** 卡死会话连续停滞后允许重新选路 ([5b07440](https://github.com/sunerpy/kiro-provider/commit/5b07440dec5e31e5a8af72cc8720f1a4d9eb72a3))
* **pipeline:** 卡死会话连续停滞后允许重新选路 ([f681223](https://github.com/sunerpy/kiro-provider/commit/f6812231691766b3bf6fda933f4ad92bcc3b297c))

## [3.4.2](https://github.com/sunerpy/kiro-provider/compare/v3.4.1...v3.4.2) (2026-09-16)


### Bug Fixes

* **anthropic:** 保留仅含签名的空思考块 ([7a6aaa3](https://github.com/sunerpy/kiro-provider/commit/7a6aaa37936701c8ddfdec3f97bc7aeea33ea262))

## [3.4.1](https://github.com/sunerpy/kiro-provider/compare/v3.4.0...v3.4.1) (2026-09-16)


### Bug Fixes

* **cli:** 加固自更新替换与版本比较 ([91514cf](https://github.com/sunerpy/kiro-provider/commit/91514cf58f072ed4e67a106298d70bc0629b9e74))
* **cli:** 加固自更新替换与版本比较 ([081992c](https://github.com/sunerpy/kiro-provider/commit/081992c89d2ec91cb073846cc1dc5221e792f631))

## [3.4.0](https://github.com/sunerpy/kiro-provider/compare/v3.3.1...v3.4.0) (2026-09-15)


### Features

* **cli:** 增加账号列表排序与版本自更新 ([e7fa4ca](https://github.com/sunerpy/kiro-provider/commit/e7fa4ca62e0fc1a879b58ddf4d96c6459809432c))
* **cli:** 增加账号列表排序与版本自更新 ([a0ef8fd](https://github.com/sunerpy/kiro-provider/commit/a0ef8fdc1f68468fde509d0a1b0f08dcdad650cf))

## [3.3.1](https://github.com/sunerpy/kiro-provider/compare/v3.3.0...v3.3.1) (2026-09-15)


### Bug Fixes

* **replay:** 修复历史会话额度耗尽后的账号切换 ([#77](https://github.com/sunerpy/kiro-provider/issues/77)) ([50900f6](https://github.com/sunerpy/kiro-provider/commit/50900f6d21c74c1d91a8ed08f4eb4b7594dc0895))

## [3.3.0](https://github.com/sunerpy/kiro-provider/compare/v3.2.9...v3.3.0) (2026-09-15)


### Features

* **replay:** 增加可移植回放与缓存适配 ([4e82788](https://github.com/sunerpy/kiro-provider/commit/4e82788f6eadc6fe7c5ba45d6f5d42d010a28d88))

## [3.2.9](https://github.com/sunerpy/kiro-provider/compare/v3.2.8...v3.2.9) (2026-09-15)


### Bug Fixes

* **claude:** 共享原生状态并隔离提供器路由 ([4b62e51](https://github.com/sunerpy/kiro-provider/commit/4b62e51bdcf5001e5c4a476c3a6bdecfcc1c4662))

## [3.2.8](https://github.com/sunerpy/kiro-provider/compare/v3.2.7...v3.2.8) (2026-09-15)


### Bug Fixes

* **responses:** 支持图片型工具结果 ([7125810](https://github.com/sunerpy/kiro-provider/commit/7125810377c99c8b3508b246b586c34fbb6618d2))

## [3.2.7](https://github.com/sunerpy/kiro-provider/compare/v3.2.6...v3.2.7) (2026-09-15)


### Bug Fixes

* **ci:** 禁用不兼容的 Bun 依赖更新 ([7a172d9](https://github.com/sunerpy/kiro-provider/commit/7a172d94ac0768fe384fc4b31e7abb26b0085dab))
* **ci:** 稳定流式交付存活测试 ([45645a0](https://github.com/sunerpy/kiro-provider/commit/45645a0b093751a997c39d0120083e252ffa4be6))

## [3.2.6](https://github.com/sunerpy/kiro-provider/compare/v3.2.5...v3.2.6) (2026-09-15)


### Bug Fixes

* **ci:** 精简发布验证链路 ([f64bfdf](https://github.com/sunerpy/kiro-provider/commit/f64bfdfd21dfb17b22d0d423f941d2feb6c358da))

## [3.2.5](https://github.com/sunerpy/kiro-provider/compare/v3.2.4...v3.2.5) (2026-09-15)


### Bug Fixes

* **anthropic:** 保留连续文本簇投影 ([dad2e2d](https://github.com/sunerpy/kiro-provider/commit/dad2e2def6e5a64fa600f4dc89822eaedeeb6e32))

## [3.2.4](https://github.com/sunerpy/kiro-provider/compare/v3.2.3...v3.2.4) (2026-09-15)


### Bug Fixes

* **anthropic:** 支持图片型工具结果 ([9e64658](https://github.com/sunerpy/kiro-provider/commit/9e6465819c85b97a2369fc793ff3c73729a51c63))

## [3.2.3](https://github.com/sunerpy/kiro-provider/compare/v3.2.2...v3.2.3) (2026-09-15)


### Bug Fixes

* **release:** 排除自动版本元数据格式化 ([7ad7f91](https://github.com/sunerpy/kiro-provider/commit/7ad7f910d8c0399d4f47b1d48ad7cc35f3439b9e))
* **release:** 避免 npm 索引传播假失败 ([0f52aa6](https://github.com/sunerpy/kiro-provider/commit/0f52aa61f0a73f5d01176b85ace674054ab21766))

## [3.2.2](https://github.com/sunerpy/kiro-provider/compare/v3.2.1...v3.2.2) (2026-09-14)


### Bug Fixes

* **release:** 统一 CI 与发布状态机 ([49c58dc](https://github.com/sunerpy/kiro-provider/commit/49c58dcf703172d51db14182f29d325e6f26eb25))

## [3.2.1](https://github.com/sunerpy/kiro-provider/compare/v3.2.0...v3.2.1) (2026-09-14)


### Bug Fixes

* **anthropic:** 修复流式背压与增量交付 ([61513ea](https://github.com/sunerpy/kiro-provider/commit/61513ea7314e808ccc220470b1f5d0ed139412f5))

## [3.2.0](https://github.com/sunerpy/kiro-provider/compare/v3.1.4...v3.2.0) (2026-09-14)


### Features

* **claude:** 增加 Claude Code 独立兼容支持 ([17a33c0](https://github.com/sunerpy/kiro-provider/commit/17a33c00afc59e192ea8b99c00cbf00f7ea2e45d))
* **claude:** 增加 Claude Code 独立兼容支持 ([65da471](https://github.com/sunerpy/kiro-provider/commit/65da471cf1c359e958cfc521d44e5c08ae05a516))

## [3.1.4](https://github.com/sunerpy/kiro-provider/compare/v3.1.3...v3.1.4) (2026-09-14)


### Bug Fixes

* **responses:** 统一用量语义并修复上下文压缩统计 ([#45](https://github.com/sunerpy/kiro-provider/issues/45)) ([70d983e](https://github.com/sunerpy/kiro-provider/commit/70d983efaef09371ede25bd781f85c1259a07ea5))

## [3.1.3](https://github.com/sunerpy/kiro-provider/compare/v3.1.2...v3.1.3) (2026-09-14)


### Bug Fixes

* **responses:** 修复工具回放与中断续接并恢复 Ultra ([112a4ec](https://github.com/sunerpy/kiro-provider/commit/112a4ec78f08ea90be2b8edf5116b9893998b5ac))

## [3.1.2](https://github.com/sunerpy/kiro-provider/compare/v3.1.1...v3.1.2) (2026-09-13)


### Bug Fixes

* **responses:** 分离历史工具回放与当前调用授权 ([#41](https://github.com/sunerpy/kiro-provider/issues/41)) ([880ade6](https://github.com/sunerpy/kiro-provider/commit/880ade68660e04365f5549ad4c59119c66710d3b))

## [3.1.1](https://github.com/sunerpy/kiro-provider/compare/v3.1.0...v3.1.1) (2026-09-13)


### Bug Fixes

* **stream:** 修复响应头与工具增量交付及 KiroRuntime 解码 ([#39](https://github.com/sunerpy/kiro-provider/issues/39)) ([da1b0e4](https://github.com/sunerpy/kiro-provider/commit/da1b0e46c229b2274ac1b39d21a6f046207abb6a))

## [3.1.0](https://github.com/sunerpy/kiro-provider/compare/v3.0.1...v3.1.0) (2026-09-11)


### Features

* **responses:** 提高 V3 原生调用保真并加固续接 ([#37](https://github.com/sunerpy/kiro-provider/issues/37)) ([ee71f26](https://github.com/sunerpy/kiro-provider/commit/ee71f26e596ad485ea6107d251c2b7c18dd97699))

## [3.0.1](https://github.com/sunerpy/kiro-provider/compare/v3.0.0...v3.0.1) (2026-09-06)


### Bug Fixes

* **models:** 修正 GPT-5.6 一百万上下文元数据 ([f611b6a](https://github.com/sunerpy/kiro-provider/commit/f611b6a9d8247fcc1cd02f6033d25e8a7d455c4c))

## [3.0.0](https://github.com/sunerpy/kiro-provider/compare/v0.8.1...v3.0.0) (2026-09-06)

### ⚠ BREAKING CHANGES

* 默认 `protocol_projection_mode` 改为 `v3-auto`
* `/v1/responses/compact` 与 `/v1/responses/input_tokens` 明确返回 HTTP 501

### Features

* **api:** 增加 KiroRuntime V3 Responses 提供器 ([459d010](https://github.com/sunerpy/kiro-provider/commit/459d0106e2235f70a4df1b2830fafb8a46a21e25))
* **responses:** 增加 native/stateless 自动路由与租户隔离的 Response 生命周期
* **telemetry:** 增加 payload-free 路由、attempt、effective effort 与 terminal 事件
* **research:** 增加 Kiro CLI 脱敏差分探针与 effort 对照研究工具

### Bug Fixes

* **responses:** Claude input 含 `system`/`developer` role 时自动回退 stateless
