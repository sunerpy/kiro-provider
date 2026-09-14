# Responses 工具回放与中断交付验收

日期：2026-09-14。基线：v3.1.2。实现代码：`2144b2b`。

本报告只记录本批已实施的回放、交付和 Codex 模型目录修复。原始会话、账号库、密钥和完整请求保留在本机；以下为脱敏结果。

## 问题与修复

| 场景                             | 修复前                                                               | 修复后                                                                       |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 子代理回报插入父会话             | 相邻 reasoning 被错误归入同一父响应，出现不同 token 冲突             | `agent_message` 划分外部输入边界；独立的子代理 reasoning 不作为父响应回放    |
| 历史工具已从当前声明中移除       | namespace/custom 历史必须依赖已不存在的旧声明或映射                  | 完整 stateless 历史按公开身份建立稳定别名；历史身份不授予本轮新调用权限      |
| reasoning 完成时客户端接收新消息 | 完整响应 token 先于工具调用完成事件交付，客户端可能只保存部分响应    | 全部关联 message/tool 完成后才交付 token；按 `output_index` 保持逻辑输出顺序 |
| 回放校验失败                     | 租户、模型、账号、会话和输出冲突合并为一个含糊提示                   | 保持原错误码，明确列出不匹配字段，不公开凭据或账号值                         |
| 当前 Codex 读取模型目录          | `web_search_tool_type: null` 使目录解析失败                          | 返回合法格式枚举，搜索能力开关仍为关闭                                       |
| Sol/Terra 的 Ultra 菜单          | Provider 目录生效后只列出 Low 到 Max，覆盖了 Codex 内置的 Ultra 选项 | 补齐 Codex Ultra、多代理 v2 与 `max` 推理映射；不增加 Kiro 原生 Ultra effort |

旧格式中只有 canonical 快照、缺少必要历史身份绑定的记录仍按原规则拒绝。没有弱化签名、租户、账号、会话或 TTL 校验。

## 中断案例

一次真实父会话故障中，17 条父响应 token 均属于同一账号和 Kiro 会话。前 16 条输出指纹一致；最后一条不一致。上游已完成文本和一个工具调用，但客户端只保存了文本和 token，随后插入了子代理消息。

旧交付顺序：

```text
message.done
reasoning.done(token binds message + tool)
  -> Codex admits queued agent message and stops reading
tool.done
```

下一请求的可见历史缺少工具调用，与 token 绑定的完整输出不一致。

新交付顺序：

```text
message.done
tool.done
reasoning.done(token binds message + tool)
  -> queued message can now be admitted with complete signed output
```

可见 reasoning 的增量仍正常传输；延后的是其完成事件。官方 SDK 按索引重建的 `response.output` 与各 item 的最终内容保持一致。

## 离线验收

- 新增中断边界回归覆盖 GPT 占位 reasoning、Claude 可见 reasoning、无可见 reasoning 但有 token、多个工具调用。旧实现的失败已在修改前记录。
- 官方 OpenAI TypeScript SDK `7.13.0` 验证延后 reasoning 完成时的输出组装。
- 保留历史工具重排、移除、别名隔离、未知新工具拒绝、签名篡改和账号不匹配等负例。
- 1,723 项测试通过，覆盖率门禁为 94.06%，阈值保持 93%。
- typecheck、lint、格式、Shell 脚本语法、安全套件、Codex smoke security、覆盖率配置一致性及二进制构建通过。

## 真实联调

隔离环境使用独立配置、端口、账号库及 replay key 副本，并关闭副本的后台账号维护。

| 客户端与场景                                          | 结果                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 官方 SDK，Sol / max / store:false，namespace function | reasoning.done 后停止读取，不等待 response.completed，回传已收到的调用和结果，续接成功                                |
| 官方 SDK，Sol / max / store:false，custom 工具        | 保留公开身份及完整字符串输入，同样通过中断后的续接                                                                    |
| 官方 SDK 正向重复与负向对照                           | 三轮正向通过；故意删除签名绑定的工具调用仍被拒绝                                                                      |
| Codex 0.154.0，原历史的隔离 fork                      | 压缩、真实终端工具调用及后续回答通过                                                                                  |
| 本地原会话恢复                                        | 在确认客户端退出并备份后，仅在一次压缩请求中排除已证实残缺的 token；随后直连 Provider，连续两轮工具执行与历史回放成功 |
| Zuno 0.10.39，kiro profile / max                      | 一次 Shell 调用 exit 0，结果进入历史；同一会话下一轮正确引用结果且没有重复执行工具                                    |
| Codex Ultra                                           | 模型列表包含 Ultra，实际请求启用 proactive 策略并发送 effort=max，正常完成                                            |
| 真实终端 `/model` 菜单                                | 候选和替换后的本地服务均显示 Max 与 Ultra(current)                                                                    |

恢复原会话没有补造缺失的工具参数，没有重放旧工具或直接修改会话数据库。该一次性恢复流程不属于通用的“忽略回放校验”机制。

Zuno 联调中出现独立的 Figma OAuth 配置警告；本批未调用 Figma，不对该连接状态作通过声明。

## 本地替换与边界

已备份二进制、配置、replay keyring 和账号数据库；原子替换后校验运行进程的二进制哈希、ready、SQLite quick_check 和账号数量。配置、密钥字节及 42 个账号数量保持一致。

上述构建尚不等同于公开发行包；公开发布以对应 release tag、CI、五目标构建、原生 macOS/Windows 冒烟、npm 发布及远端资产校验为准。

本批没有修正 usage 的估算口径。已确认缺少精确上游 token 用量时，现有输出估算遗漏工具参数，缓存和不可见 reasoning 细项也不能据当前零值判断。该问题在后续统计变更中独立处理，不作为本批已完成能力。
