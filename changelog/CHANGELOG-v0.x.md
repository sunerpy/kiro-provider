# Changelog

## [0.6.0](https://github.com/sunerpy/kiro-provider/compare/v0.5.1...v0.6.0) (2026-09-02)


### Features

* **audit-log:** apply log_level as the audit threshold ([9f84466](https://github.com/sunerpy/kiro-provider/commit/9f8446669c9892620f17bb45b5bf7448717e7d86))
* **core:** audit non-stream collection with the streaming raw-event trail ([d85268c](https://github.com/sunerpy/kiro-provider/commit/d85268c18e09a2be1aede72bc549409f45f417ee))
* harden pipeline, protocol adapters, and operations per the 2026-09-02 review ([1138e78](https://github.com/sunerpy/kiro-provider/commit/1138e7860b4c543dc76df9edad781e24e85229ed))
* harden pipeline, protocol adapters, and operations per the 2026-09-02 review ([#18](https://github.com/sunerpy/kiro-provider/issues/18)) ([1138e78](https://github.com/sunerpy/kiro-provider/commit/1138e7860b4c543dc76df9edad781e24e85229ed))
* **quota:** schedule exhausted-account rechecks from the upstream reset time (B12) ([4cc4ef6](https://github.com/sunerpy/kiro-provider/commit/4cc4ef6feb9ae2467374f2c2627a0ac10b0e1896))
* **server:** harden Bun.serve options and add graceful shutdown ([e22b2a6](https://github.com/sunerpy/kiro-provider/commit/e22b2a60dd1e61f2be06b0e5e9ab899550ada04d))
* **server:** Retry-After on 429, retryable Anthropic quota errors, Responses output details ([10f626d](https://github.com/sunerpy/kiro-provider/commit/10f626d587e7f7754359db30257a5e1992fb7282))


### Bug Fixes

* **anthropic:** keep thinking blocks legal, fail unsigned reasoning, report real usage ([2bd2a66](https://github.com/sunerpy/kiro-provider/commit/2bd2a669b1173f98714244787a451f2d3c8b0e3c))
* **chat:** accept n=1, none/minimal reasoning effort, null content for tool-only turns ([9a41ee3](https://github.com/sunerpy/kiro-provider/commit/9a41ee3856ad77386ba3ecd2b2e4c4db31dc8c31))
* **classifier:** classify transport failures by code and bound 429 retries ([a28ca8d](https://github.com/sunerpy/kiro-provider/commit/a28ca8dd6e365dfa0a73b09f544bf97cdac66ad0))
* **cli:** verify login identity, protect newer imports, and tidy options ([6d901d1](https://github.com/sunerpy/kiro-provider/commit/6d901d1b0d1cc427f6f552dbe23ecfd4e043ee0b))
* **config:** bound numeric fields, narrow enums, and harden env/file parsing ([c138d08](https://github.com/sunerpy/kiro-provider/commit/c138d0842201643319764dc24cdba534979e6bda))
* **core:** classify with selectable alternatives and wait out short rate limits instead of 503 (B3) ([ddd09b4](https://github.com/sunerpy/kiro-provider/commit/ddd09b48d2d980c3217cc1672d241755305114f3))
* **core:** clear the abortableSleep timer on abort (C7) ([87d3968](https://github.com/sunerpy/kiro-provider/commit/87d39686a6bd66bb77b39988851e64025c8f8d94))
* **core:** count 502/503/504 toward the per-account server-error threshold ([2f523da](https://github.com/sunerpy/kiro-provider/commit/2f523da4b2dc6b0dc374cfdf022d441f00e57dd3))
* **core:** forward Anthropic signed thinking replay without affinity and map invalid signatures to 400 (B25) ([c5d0301](https://github.com/sunerpy/kiro-provider/commit/c5d03016789afb25692eb96f2555f6bf04ce0b63))
* **core:** give the OpenCode account manager selectable counts and SDK client eviction ([d1de1ad](https://github.com/sunerpy/kiro-provider/commit/d1de1ada6eb6c624bf208e7abb4b6a19b68e0ac0))
* **core:** make local token refresh failover-safe and dedupe by account id (A2+A3+A4) ([e519d34](https://github.com/sunerpy/kiro-provider/commit/e519d34207327566b35576329eed57db0593adf9))
* **core:** really abort the upstream Kiro request on idle timeout, cancel, and failed collection (A1) ([0ca147a](https://github.com/sunerpy/kiro-provider/commit/0ca147a28e0da0a059301a64559b1b3242eb0dd1))
* **core:** route non-stream stream failures by disposition and terminate fatal ones as 502 (B4) ([0600a9b](https://github.com/sunerpy/kiro-provider/commit/0600a9b66d52952479e6bb6cd4b174b1c2bee42b))
* **core:** stop echoing internal exception text from the pipeline; return a fixed message with a request id (B16) ([93e2d09](https://github.com/sunerpy/kiro-provider/commit/93e2d098c245c3caa7988f130206396145704f47))
* **health:** only structured OIDC/Kiro errors mark a refresh token dead ([701bd0c](https://github.com/sunerpy/kiro-provider/commit/701bd0c8a03f802794963e2119d7fdfd50282708))
* **keyring:** create the reasoning replay key file exclusively ([d37324b](https://github.com/sunerpy/kiro-provider/commit/d37324b8a7ca5d2ab652cd02cb5ca62a933ee89b))
* **model-catalog:** do not count caller-aborted fetches as failures ([39cee01](https://github.com/sunerpy/kiro-provider/commit/39cee019c02df709b000b401a0255334096aada2))
* **oauth-idc:** add per-request timeouts and survive transient poll failures ([10aa872](https://github.com/sunerpy/kiro-provider/commit/10aa8729ad39e5ef3cc5fdda8a75ebe1d4567c4a))
* **responses:** align non-stream tool restore failures with SSE error codes ([3772f9b](https://github.com/sunerpy/kiro-provider/commit/3772f9b2b43646ef67e02aa4d474129bc7f65787))
* **responses:** complete encrypted reasoning items with their replay token ([6ebdacb](https://github.com/sunerpy/kiro-provider/commit/6ebdacb87a1a1c4788124c1a8c1b878c656b4db8))
* **responses:** resolve reasoning replay per assistant turn group ([bd2a6f1](https://github.com/sunerpy/kiro-provider/commit/bd2a6f1c8d0454d1da0fcf4172f78367a9624421))
* **server:** 405/HEAD/OPTIONS dispatch, trailing slash, Bearer challenge, fixed 500 envelope ([a1ef1d2](https://github.com/sunerpy/kiro-provider/commit/a1ef1d2886fca43abd04d258d3003494e9bc1b3c))
* **server:** fail closed on lock compromise and retry stale locks ([d3398c5](https://github.com/sunerpy/kiro-provider/commit/d3398c5940ec6aad9b1efa74d6dafe030efcba41))
* **server:** label readiness dependency failures distinctly ([37740cc](https://github.com/sunerpy/kiro-provider/commit/37740cc25d819c87d1580f5c06a4ab3cbb711fcd))
* **server:** match untyped user items in legacy initial-input affinity ([20d42b0](https://github.com/sunerpy/kiro-provider/commit/20d42b0491affca7e9aefd7ee94eb10ffb16c3f6))
* **storage:** validate persisted regions before building upstream hosts ([c82eec5](https://github.com/sunerpy/kiro-provider/commit/c82eec5930d18140c28266df5b336c338018d2f4))
* **stream-error:** register unknown_upstream_tool and invalid_custom_tool_input as fatal ([f408af9](https://github.com/sunerpy/kiro-provider/commit/f408af93d86018cfc166b7068aaa71c28b58a335))
* **transform:** project zero-input Kiro tool calls as empty JSON arguments ([7bdb1c7](https://github.com/sunerpy/kiro-provider/commit/7bdb1c752912aa36e8d11383abdcb887c2e11ea7))
* **transform:** validate image media types and base64 before Kiro projection ([86342e9](https://github.com/sunerpy/kiro-provider/commit/86342e954a21ab1635023f7231d34d2359588308))


### Performance Improvements

* **core:** single SDK retry layer, effort in command input, and transport eviction (B7+B8+B9) ([dbb7405](https://github.com/sunerpy/kiro-provider/commit/dbb7405ef8ca4363508dad3e195b819c4ac79f49))
* **core:** take the quota recheck off the request hot path when an account is usable (B6) ([a3f1ffd](https://github.com/sunerpy/kiro-provider/commit/a3f1ffdb256709c60d812c2d3c12641fe02e82c0))
* **model-catalog:** add failure backoff and stale-while-revalidate ([4606e8d](https://github.com/sunerpy/kiro-provider/commit/4606e8d8df9b2820b825837e72545b41aab4cd8b))

## [0.5.1](https://github.com/sunerpy/kiro-provider/compare/v0.5.0...v0.5.1) (2026-08-30)


### Bug Fixes

* classify malformed tool arguments as retryable ([#16](https://github.com/sunerpy/kiro-provider/issues/16)) ([a6f28ea](https://github.com/sunerpy/kiro-provider/commit/a6f28eaaae70c04738c139c4f655debacffaa153))

## [0.5.0](https://github.com/sunerpy/kiro-provider/compare/v0.4.0...v0.5.0) (2026-08-29)


### Features

* add Claude Opus 5 support ([b223952](https://github.com/sunerpy/kiro-provider/commit/b22395200bc69b87d5af9442f34e6a86f68e7daa))
* add production account management commands ([#14](https://github.com/sunerpy/kiro-provider/issues/14)) ([71a5027](https://github.com/sunerpy/kiro-provider/commit/71a5027c417a04833c3ba1ebe305d28ce209bf74))
* harden protocol fidelity and local auth lifecycle ([#13](https://github.com/sunerpy/kiro-provider/issues/13)) ([5e84aa3](https://github.com/sunerpy/kiro-provider/commit/5e84aa34054d848809e5a4f1882405b21aef66aa))
* harden protocol projection for v0.5.0-rc.1 ([af5069a](https://github.com/sunerpy/kiro-provider/commit/af5069a482ba78ccb9895c489420b6ac919cce9f))


### Bug Fixes

* harden responses streaming and session affinity ([#10](https://github.com/sunerpy/kiro-provider/issues/10)) ([f48803f](https://github.com/sunerpy/kiro-provider/commit/f48803f3ed5d8d1aa336c1a226bdb639d0212fd3))
* preserve typed stream failures ([#15](https://github.com/sunerpy/kiro-provider/issues/15)) ([ce70491](https://github.com/sunerpy/kiro-provider/commit/ce704919749798ec9db6b83d7ca68ce57f8b9c91))

## [0.4.0](https://github.com/sunerpy/kiro-provider/compare/v0.3.1...v0.4.0) (2026-08-24)


### Features

* productionize multi-client Kiro provider ([2b5db59](https://github.com/sunerpy/kiro-provider/commit/2b5db59aa84ca96315f20af20f5eb3e43d2903fa))

## [0.3.1](https://github.com/sunerpy/kiro-provider/compare/v0.3.0...v0.3.1) (2026-07-22)


### Bug Fixes

* **responses:** 修复 Codex CLI 首轮/续轮请求被拒的入站契约 ([3ce5925](https://github.com/sunerpy/kiro-provider/commit/3ce59256e64f5b86a34c494b323350adf40a8758))

## [0.3.0](https://github.com/sunerpy/kiro-provider/compare/v0.2.0...v0.3.0) (2026-07-21)


### Features

* **responses:** 新增 /v1/responses 支持 Codex CLI 接入 ([66ecd31](https://github.com/sunerpy/kiro-provider/commit/66ecd31511d8ef97971c73059cdc450e5acf06dd))

## [0.2.0](https://github.com/sunerpy/kiro-provider/compare/v0.1.0...v0.2.0) (2026-07-19)


### Features

* Kiro OpenAI 兼容网关服务 ([6489e54](https://github.com/sunerpy/kiro-provider/commit/6489e5432042183ec6b32d1150a46aa37749f8aa))
