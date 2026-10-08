# Claude Code messages.249 内容交错修复验收

基线 `ae9180ddf9a61d60bd06cd21d7a1cafb950a2691`（3.8.1）在一条包含
`tool_result → text → text → image → text` 的用户消息上返回 400。
完整 250 条合成 Messages 在流式、非流式入口均复现原错误，SDK 派发次数为 0；
新增常规回归测试在旧实现上失败，修复后通过。

## 投影边界

仅携带完整 `claude-code-bash-v1` 归一化上下文的 Messages 请求允许此投影。
开头连续的纯文本工具结果保留为一个 Kiro 用户段，其后的直接文本与图片按原顺序
拆分，总计最多 16 段。工具 ID、结果状态、文本字节、图片顺序、指令位置、历史缓存
边界及 reasoning 回放索引均保留。图片型工具结果、非前缀工具结果及未声明兼容上下文
的交错请求仍按原有规则拒绝。

## 本地与真实入口结果

- `make pre-ci`：3056 项测试通过，0 项失败；行覆盖率 95.64%，门槛 93%。
  修改的 36 行可执行源码全部被覆盖。独立二进制构建通过。
- 真实 Kiro：Opus 5.5 与 Fable 5.1，流式／非流式、首次图片投影／签名续接，共 8/8
  成功。先完成一个真实上游工具调用，再发送工具结果前缀和红／蓝图片；模型首次及
  续接均返回相同的标记与颜色顺序。
- 真实 Claude Code 2.1.294：使用报错会话副本、原工作目录、Opus 5.5 和 max effort
  续接，返回预期标记。工具执行与会话写回关闭，原会话文件校验值未变化。
- 本地候选版：绑定代码提交 `9a9cfa7ef3bb06d26e0465fb6bedbaaddd858380`；原子替换并
  重启后，进程校验值匹配，`NRestarts=0`；health、认证后的 ready／models 为 200，
  未认证 models 为 401。数据库 `quick_check=ok`，53 个账户及 schema version 8
  保留，配置与回放密钥未改变。

计数、枚举、源码及二进制校验值见
[消毒验收记录](evidence/message-249-2026-10-09/verification.json)。
会话正文、图片字节、工具参数、签名、API key 和数据库副本均未提交。

## 可重复探针

使用独立配置、端口、账户副本及回放密钥启动候选二进制，然后运行：

```bash
bun run scripts/probe-image-run-order.ts \
  --base-url http://127.0.0.1:18983 \
  --provider-config /tmp/isolated-provider/config.json \
  --out /tmp/isolated-provider/tool-prefix-order.json \
  --tool-result-prefix
```

探针拒绝生产端口 8787 和仓库内的证据输出路径，只输出固定模型名、状态、场景枚举
及通过与否；支持真实工具调用 SSE 参数收集，并检验唯一的终止事件。
