# Changelog

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
