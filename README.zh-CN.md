# pi-kimi-keepalive

English | [中文文档](README.zh-CN.md)

Prompt-cache keepalive for [Kimi](https://www.kimi.com/) (`kimi-coding` provider) sessions in the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Kimi 的自动 prompt 缓存 TTL 实测约 5 分钟。TTL 过期后恢复会话时，整个上下文以全价 input（$3 / 1M）重新计算。本扩展捕获最后一条真实 provider 请求，在会话空闲期间以固定间隔将其重放至同一端点，使缓存前缀在 TTL 内保持有效，后续请求按 cache-read 价格（$0.3 / 1M）计费。

重放请求直接发送到 provider 端点，不经过 Pi 会话管道：不产生合成消息、不产生模型回合、不改动对话历史，仅在界面上展示聚合统计。

## 环境要求

- Node ≥ 20，pi ≥ 0.84（提供 `before_provider_headers` / `before_provider_request` 钩子）
- `kimi-coding` provider（建议 OAuth 订阅），`kimi-openai-completions` API

## 安装

```bash
git clone https://github.com/realoliversama/pi-kimi-keepalive
pi install /path/to/pi-kimi-keepalive
```

单次会话试运行（不安装）：

```bash
pi -e /path/to/pi-kimi-keepalive/src/index.ts
```

npm 发布后可使用 `pi install npm:pi-kimi-keepalive`。

## 初始化

首次启动（`~/.pi/cache-keepalive/state.json` 不存在）且有交互 UI 时，扩展运行初始化向导配置四项护栏。提示符留空或按 Esc 保留默认值；之后可用 `/keepalive setup` 重新运行；headless 会话自动跳过并保留默认值。

| 步骤 | 设置项 | 命令 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | Max idle cutoff | `maxidle` | `30m` | 空闲超过该时长后停止探测；`0` 表示不设限 |
| 2 | Miss pause threshold | `miss` | `2` | 连续 N 次探测未命中前缀缓存后暂停；命中会重置计数 |
| 3 | Error circuit breaker | `errors` | `3` | 连续 N 次探测失败（网络错误、HTTP 5xx）后暂停；HTTP 401/403 不受此值约束，直接暂停 |
| 4 | Session spend cap | `cap` | `$1.00` | 会话探测花费（估算 USD）上限；`0` 表示不设上限 |

向导结束时询问是否立即启用 keepalive。探测在下一次真实请求（完成捕获）之后开始。全部配置持久化到 `~/.pi/cache-keepalive/state.json`。

## 命令

```
/keepalive                  查看状态
/keepalive setup            重新运行初始化向导
/keepalive on|off           启用 / 停用（持久化）
/keepalive now              手动探测一次（绕过暂停）
/keepalive resume           清除 sticky 暂停
/keepalive interval=4m      探测间隔（≥ 30s）
/keepalive maxidle=30m      空闲上限（0 = 不设限）
/keepalive miss=2           连续 N 次缓存 miss 后暂停
/keepalive errors=3         连续 N 次探测失败后熔断
/keepalive cap=1.0          会话探测花费上限（USD，0 = 无上限）
/keepalive token=512        判定 miss 的最小 prompt token 数
/keepalive maxoutput=16     探测 max_tokens
/keepalive reset            清零会话统计
```

统计（hits / misses / spend）为会话级；配置项持久化。`PI_KEEPALIVE_DEBUG=1` 输出调试日志到 stderr。

## 工作机制

1. **捕获**。`before_provider_request` 钩子快照每条真实 `kimi-coding` 请求的 payload（`structuredClone`）。只存内存，不落盘。
2. **重放**。捕获的请求 POST 至 `{baseUrl}/chat/completions`（kimi-openai-completions 路由），仅修改终端参数：

   | 修改 | 原因 |
   | --- | --- |
   | 移除 `stream` / `stream_options` | 非流式响应中 usage 可直接解析 |
   | 移除 `thinking` / `store` | 与输出收紧参数兼容性未知；非前缀组成部分 |
   | `max_completion_tokens: 16` | 限制探测输出成本 |
   | HTTP 400 时重试 | 去掉 `prompt_cache_retention`（终端参数，非缓存键） |

   `messages` / `tools` / `prompt_cache_key` / `prompt_cache_retention` 保持 byte-identical——这些是 provider 前缀缓存键的输入，重放因此命中既有缓存条目并重置 TTL，按 cache-read 计费。实测对 48k 上下文的探测实现 48,116/48,116 全量命中。
3. **认证**。pi 在 `before_provider_headers` 钩子之后才注入 OAuth 凭据，捕获的 headers 通常不含认证；探测时从 pi 的凭据存储（`~/.pi/agent/auth.json` 的 `kimi-coding.access`）读取当前 token，与 pi 的自动刷新保持同步。
4. **判定**。解析响应 usage（`prompt_tokens_details.cached_tokens`，回退 Anthropic 风格字段）将探测分类为 hit 或 miss；响应其余部分丢弃。

捕获的业务 headers 原样合并（去除 hop-by-hop 与长度头）。

## 护栏

- 回合运行中跳过探测；`agent_settled` 重新 arm 定时器。
- `maxIdle` 在长空闲期停止探测。
- `miss` / `errors` 连续次数达到阈值，或 HTTP 401/403，暂停探测；下一次真实请求重新捕获凭据并自动解除暂停。
- 会话探测花费按模型定价估算，达到上限即暂停。
- 定时器 `unref()`，不阻止进程退出。

## 成本

Kimi K3 官方单价（$/1M tokens）：input 3，output 15，cache read 0.3，cache write 0。

- 命中的探测约等于整个上下文的 cache-read 费用：50k tokens ≈ $0.015，100k ≈ $0.03，200k ≈ $0.06。
- 未命中的探测按全价 input 重读同一前缀；连续 miss 达到阈值即暂停。
- `saved` 统计 = `cacheReadTokens × (input − cacheRead) / 1M`，即等效冷恢复在全价下的开销的估算。

Kimi 订阅按 quota 计费，USD 数值仅供参考。

## 限制

- ~5 分钟 TTL 与上述定价为观测行为，非 API 契约；`saved` 仅为估算。
- 仅支持 `kimi-coding`（`kimi-openai-completions` API，含 `anthropic-messages` 回退）；其他 provider 缓存键语义不同，不在范围内。
- 捕获内容仅存内存；探测仅发往 `https://` 端点。

## 开发

```bash
npm install
npm run typecheck
npm test          # 26 项测试；stub fetch、临时 $HOME、无网络
```

测试依赖 Node 原生 TypeScript 剥离（Node ≥ 22.18 / 24）。

## License

MIT，见 [LICENSE](LICENSE)。