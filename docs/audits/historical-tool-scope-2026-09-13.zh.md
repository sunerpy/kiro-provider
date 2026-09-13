# 历史工具与当前授权分离：联合验收

基线为 Kiro Provider v3.1.1 / `cac7a17993a90c444faa1c886a591b9486e6fffc`。本次仅修改 Provider，不修改 Zuno 源码、真实会话、已完成 Goal 或业务文件。

## 已复现的问题与修复

旧实现先在 Responses 桥接层、再在 Kiro 投影的共用历史校验里，要求历史调用出现在当前声明中。Zuno 候选保留原始调用与密封项后，撤下 `read` 仍得到 `400 missing_tool_declaration`。

本次把两种校验分开：

- 历史继续检查重复 ID、孤立/重复结果、顺序、调用/结果种类和 JSON；不因当前工具缺席而删除或改写旧调用。
- 原有 tenant/model/account/conversation/output-fingerprint 密封校验保持不变。
- 新输出仍只允许当前工具，使用当前 schema 验证；历史映射不能恢复或授权新的调用。
- `previous_response_id` 的 stateless V3 记录保存并恢复私有别名绑定，保留撤下工具及重排声明后的历史身份，不补造历史 schema。
- 没有历史绑定的旧 namespace/custom 记录，在缺少当前声明时明确返回 `missing_historical_tool_binding`，不猜测旧别名，不重新开放工具。这是保留的能力边界。

普通函数名称和原始 arguments 字符串继续用于逻辑历史/输出指纹；Kiro `toolUses.input` 仍按相同 JSON 值投影。当前同名 schema 的修改只约束新输出。

## 同一匿名密封会话对照

使用交接脚本的同一 `seed/snapshot.db`，保持相同 tenant、replay 数据与 keyring，模型/effort 固定为 `claude-opus-5 / max`。仅修改自身测试目录；不重投真实会话。

| 场景 | v3.1.1 | 修复候选 |
| --- | --- | --- |
| 重启后撤下全部工具 | 400 missing_tool_declaration | 一条请求返回旧值 43921 |
| 原始历史调用指纹 | 保持 | 保持 |
| 原始密封项指纹 | 保持 | 保持 |
| 本轮 tools | 空 | 空 |
| 新工具执行/Goal | 无 | 无 |

成功同时满足 `succeeded`、`originalCallsPreserved`、
`originalCapsulesPreserved`、`noToolsExposed` 为 true，且请求数为 1。
没有通过删除推理、补回声明、换模型、切换 native 或换账号跑通。
真实上游接受历史 tool-use/result 与当前空工具集合，未加入历史专属 schema。

官方 OpenAI SDK 7.13.0 对照也通过：

| 场景 | 检查 |
| --- | --- |
| 同一密封历史，本轮仅保留新工具 | 正确回忆 43921，无新调用 |
| 同一密封历史，当前 read 改为 numeric-key schema | 旧参数不按新 schema 解释，正确回忆 43921 |
| namespace，保存 Response 后撤下工具 | 原始绑定续接成功，tools 为空，无新调用 |
| custom，保存 Response 后撤下工具 | 原始绑定续接成功，tools 为空，无新调用 |

SDK 工具结果是显式合成值，不执行工具。Zuno 匿名 seed 原本仅执行一次测试目录内的 `read`；恢复阶段无可调用工具。

## 回归与边界

修复前回归有两个正常对照通过、三个“空集合/子集/none”断言失败。
修复后 JSON/SSE 反例证明，模型若新调用已撤下工具，仍得到
`unknown_upstream_tool` 或 `upstream_tool_choice_violation`，且只派发一次；
新参数不符合当前 schema 时仍为 `upstream_tool_schema_violation`。
重复/孤立/错序/错种类结果、非法参数、别名碰撞继续拒绝。
原有跨 tenant/account/model、输出不匹配、过期、取消及失败终态回归保留。

最终本地门禁：1,707 pass / 0 fail，覆盖率 19,975/21,262 = 93.95%，
保持 93% 阈值。类型、格式、脚本语法、安全、覆盖率口径和构建结果由最终 PR
提交及发布记录绑定。没有新配置、数据库 DDL、默认超时或 reasoning 调整。

用户后续提供的安装构建为
`Zuno local-replay-20260913-05e2c3ec4101 (Rust package 0.10.37)`，
SHA-256 `990cf387f368983d1e8b3e9567f5fc5ac4c535d687ef42124f16a7ad8cd079eb`。
它是未发布构建，不当作新的 Zuno 正式版。已使用该安装文件与编译后的 Kiro
候选连续验收三次，均满足四个成功条件且请求数为 1；
耗时分别为 8.785、7.880、7.809 秒。

[匿名对照证据](evidence/historical-tool-scope-2026-09-13/joint-before-after.json) ·
[真实 SDK 矩阵](evidence/historical-tool-scope-2026-09-13/sdk-matrix.json) ·
[安装版 Zuno 三次验收](evidence/historical-tool-scope-2026-09-13/installed-zuno.json) ·
[协议与旧记录边界](../HISTORICAL_TOOLS.md)
