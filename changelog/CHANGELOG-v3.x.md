# Changelog

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
