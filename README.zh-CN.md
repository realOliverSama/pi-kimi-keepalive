# pi-kimi-keepalive

为 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 中的 Kimi（`kimi-coding` provider）会话保持 **prompt 缓存不过期**。

[English](README.md) | 中文文档

## 背景

使用 Kimi K3 订阅（provider `kimi-coding`）时，其自动 prompt 缓存的 TTL 实测约 **5 分钟**（非官方承诺）。在 pi 里思考、看代码、开会超过 5–10 分钟后再次发消息，整个会话上下文会以全价 input 重新读取——上下文越长越贵。

手动对策（每 5 分钟发一条最小 prompt）确实有效，但每条消息都进入会话历史，永久污染上下文。

## 方案对比

| 方案 | 保缓存 | 污染上下文 | 说明 |
| --- | --- | --- | --- |
| 手动每 5 分钟发 prompt | ✅ | ✅ 真实消息 | 纯手工，无法坚持 |
| [pi-idle-time](https://github.com/clankercode/pi-idle-time) | ✅ | ✅ 真实 turn | 发 `[cache keepalive] {time}`，模型真实回复，上下文无限增长 |
| [pi-warm-cache](https://github.com/ribbons-digital/pi-warm-cache) | ✅ | ❌ | fail-closed：只对注册为 `anthropic-messages` 且带 `cacheControlFormat === "anthropic"` 的路由生效，**kimi-coding 不满足，默认不工作** |
| **pi-kimi-keepalive（本项目）** | ✅ | ❌ | 重放最后一条真实请求（前缀 byte-identical），带完整护栏 |

## 工作机制

1. **捕获（只读）**。通过 `before_provider_headers` / `before_provider_request` 钩子拿到最后一条真实 provider 请求的完整 payload（system/messages/tools，含缓存标记）与认证 headers。只在内存中，**不落盘**。
2. **重放**。空闲时把捕获的请求 POST 到 `{baseUrl}/v1/messages`，只改终端参数：去掉 `stream` / `thinking`、`max_tokens` 收紧（默认 16）、attempt 1 附加 `tool_choice: {type:"none"}`（若 400 报错则去掉重试一次）。**对话前缀一字节不改**，因此命中同一份自动前缀缓存，把 TTL 重新计满，按 cache-read 价格收费。
3. **零侵入**。探测绝不进入 Pi 会话：没有合成 user message、没有模型回合、没有工具调用。只有聚合统计（hit / miss / 预估节省）展示给你。

## 护栏

- agent 忙碌时不探测（`agent_settled` 重新 arm）；
- `maxidle`（默认 30 分钟）后停止探测——不会挂机过夜空烧；
- 连续 2 次缓存 miss 暂停；连续 3 次错误或 HTTP 401/403 暂停；
- 会话探测花费超过 `cap`（默认 $1.00）后暂停；
- 下一条真实请求会自动解除一切 sticky 暂停、重新捕获凭据；
- 定时器 `unref()`，绝不阻止进程退出。

## 安装

```bash
pi install npm:pi-kimi-keepalive
```

或本地试跑：

```bash
git clone https://github.com/oliverlyu/pi-kimi-keepalive
pi -e ./pi-kimi-keepalive/src/index.ts
```

需要 Node ≥ 20，pi ≥ 0.84（提供 `before_provider_headers` / `before_provider_request` 钩子）。

## 使用

```
/keepalive                查看状态
/keepalive on|off         启用 / 停用（持久化到 ~/.pi/cache-keepalive/state.json）
/keepalive now            手动探测一次（绕过暂停）
/keepalive resume         清除 sticky 暂停
/keepalive interval=4m    探测间隔（≥ 30s）
/keepalive maxidle=30m    空闲多久后彻底停探测（0 = 不设限）
/keepalive cap=1.0        单会话探测花费上限（USD，0 = 无上限）
/keepalive token=512      判定 miss 的最小 prompt token 数
/keepalive maxoutput=16   探测的 max_tokens
/keepalive reset          清零统计
```

默认：**opt-in**（需 `/keepalive on`）、间隔 4 分钟（实测 TTL ≈ 5 分钟，留余量）、maxidle 30 分钟、cap $1.00。调试日志设 `PI_KEEPALIVE_DEBUG=1` 输出到 stderr。

## 成本模型

Kimi K3 单价（$/1M tokens）：input 3 · output 15 · **cache read 0.3**。

- 一次 **hit** 探测 ≈ 整个上下文按 cache-read 计费：50k tokens ≈ $0.015，100k ≈ $0.03。
- 一次 **miss** 探测 = 全价重读上下文 —— 连续 2 次即暂停探测。
- K3 的 cache *write* 为 $0，所以 probe 命中时几乎没有额外成本。
- 订阅（OAuth）用户按 quota 计费，USD 数字仅供参考。

挂机时每小时 ≈ 15 次探测 × $0.03 ≈ $0.45，远低于回来后一次冷恢复的全价重读。`maxidle` 与 `cap` 用于封顶。

## 免责声明

- Kimi 缓存 TTL（~5 分钟）与价格是**观测行为，非 API 契约**；`saved` 统计为估算，不是退款承诺。
- 仅支持 `kimi-coding` + `anthropic-messages` 路由。
- 捕获内容只存内存；探测仅发往 `https://` 端点。

## 开发

```bash
npm install
npm run typecheck
npm test
```

测试基于 Node 原生 TypeScript 剥离（Node ≥ 22.18 / 24）运行，stub fetch + 临时 `$HOME`，无网络、无真实密钥。

## License

MIT，见 [LICENSE](LICENSE)。