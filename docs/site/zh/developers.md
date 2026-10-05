# 参与开发

本页面向参与 kiro-provider 本身开发的人：仓库结构、一项改动必须通过的检查，以及本站是如何构建的。

## 仓库结构

kiro-provider 用 TypeScript 编写，运行在 [Bun](https://bun.sh) 1.3.14 上，这是 `package.json` 固定的版本。

| 路径              | 内容                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `src/cli/`        | `kiro-provider` 命令：参数解析、`login`、`accounts`、`self-update`。             |
| `src/server/`     | HTTP 网关：鉴权、准入和路由；`src/server/responses/` 中是 Responses 的两条路径。 |
| `src/protocol/`   | 两种接口与之相互转换的内部请求和输出契约。                                       |
| `src/kiro/`       | Kiro 的传输、登录、模型目录和请求转换。                                          |
| `src/core/`       | 账号调度、重试和请求管线。                                                       |
| `src/storage/`    | `accounts.db` 及其迁移。                                                         |
| `src/reasoning/`  | 加密的推理内容回放。                                                             |
| `src/web-search/` | 由 provider 执行的联网搜索。                                                     |
| `__tests__/`      | 测试，每个模块或行为一个文件。                                                   |
| `docs/`           | 参考文档；`docs/site/` 是本站，`docs/audits/` 是带日期的证据。                   |
| `scripts/`        | 安装脚本、客户端启动器、探针和仓库自身的检查脚本。                               |

[架构](../../ARCHITECTURE.md)（英文）跟随一个请求走过这些部分。[`AGENTS.md`](../../../AGENTS.md) 是每项改动都要遵守的规则，人和编码 Agent 都适用：协议保真、失败即关闭的路由、哪些内容属于机密，以及每类改动需要的测试。

## 构建与测试

```sh
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
bun test __tests__/<target>.test.ts   # 与改动最相关的测试
make check                            # 格式、类型、lint、链接、构建、安全检查和测试
make pre-ci                           # 同样的检查加上覆盖率门槛，与 CI 一致
bun run build:binary                  # dist/kiro-provider
```

覆盖率是发布门槛：`make coverage-gate` 要求行覆盖率不低于 93%，pull request 除了 `CI Success` 之外，还需要 `codecov/project` 和 `codecov/patch` 两项检查通过。修复缺陷时要附带一个没有该修复就会失败的测试。

针对 Kiro 的实测使用单独的配置、端口和账号副本，绝不使用你日常使用的网关。`scripts/` 中的探针脚本因此拒绝使用 8787 端口。

## Pull request 与发布

- 提交信息和 pull request 标题遵循 Conventional Commits，scope 使用小写，例如 `fix(responses): …` 或 `docs(site): …`。
- Pull request 以 squash 方式合并到 `main`，不直接向 `main` 推送。
- 发布由 release-please 完成：它的 pull request 更新版本号和[更新日志](../../../changelog/CHANGELOG-v3.x.md)，合并后构建并发布二进制、`SHA256SUMS`、构建证明和 npm 包。

## 本站

本站的页面位于 `docs/site/`，英文在根目录，中文在 `zh/` 下，与它们描述的代码放在一起。页面链接的参考文档（例如 [`CONFIGURATION.zh-CN.md`](../../readme/CONFIGURATION.zh-CN.md)）原样发布。主题和构建由 FirLab 的仓库负责；本仓库中涉及这些页面的改动合并到 `main` 后，会发布到 `firlab.app/kiro-provider/`。写作规则、首页字段和本地预览方法见 [`docs/site/README.md`](../README.md)。

## 报告问题

在 [GitHub](https://github.com/sunerpy/kiro-provider/issues) 上提交 issue，写明 kiro-provider 的版本、客户端及其版本、HTTP 状态和错误码，以及错误中的 `request_id`。不要附上提示词、密钥或令牌；你附上的日志事件本身不包含这些内容。
