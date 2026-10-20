# 邮件通知（第 15 项）部署清单

> 范围：**发信**（工单事件 → 公司邮箱 SMTP → 收件人）。第 16 项（收信自动建单）未做。
> 架构：纯前端不能直连 SMTP，发信走 Supabase **Edge Function** `send-email`
> （Deno，直连 `smtp.longi.com:465` 隐式 TLS）。账号密码只存在 Supabase
> Secrets 里，**不进代码、不进前端**。

## 一、跑 SQL（顺序不能错）

在 Supabase Dashboard → SQL Editor 依次执行（都是幂等可重复跑）：

1. `migrations/migration_v6.sql`
2. `migrations/migration_v6_1.sql`
3. `migrations/migration_v7.sql`
4. `migrations/migration_v6_2.sql` ← 本次新增：`app_settings` / `email_templates`（6 事件 × 中英 12 个模板）/ `email_log` / `notification_preferences`

> 新建表/列的 RLS 与之前风格一致（authenticated 可读、admin 可写；`email_log` 允许已登录用户写入——供 Edge Function 记日志；`notification_preferences` 每人只能读写自己的行，admin 全读）。

## 二、部署 Edge Function

1. Supabase Dashboard → **Edge Functions** → **New function**，命名为 `send-email`。
2. 把仓库里 `supabase/functions/send-email/index.ts` 的**全部内容**粘贴进去 → **Deploy**。

## 三、填 Secrets（Edge Functions → Secrets / Manage secrets）

| Secret | 值 | 说明 |
|---|---|---|
| `SMTP_HOST` | `smtp.longi.com` | 收发信服务器 |
| `SMTP_PORT` | `465` | SSL 隐式 TLS 端口 |
| `SMTP_USER` | 发信邮箱账号 | **先用你个人邮箱跑通测试** |
| `SMTP_PASS` | 专用密码（app password） | **不能用主登录密码**（公司邮箱开了 MFA 的话主密码直连 SMTP 会被拒绝） |
| `SMTP_FROM` | 发件人地址（可选） | 不填则默认等于 SMTP_USER |

> ⚠️ **密码安全**：Secrets 由你在 Supabase 后台直接填写，永远不要发到聊天里。
> 之前截图里露过面的专用密码，跑通后请删掉并重建一个新的，再更新 `SMTP_PASS`。

## 四、发前端代码

把 `v6` 分支 push → GitHub Pages 自动重新部署。登录后**硬刷新**（Ctrl+Shift+R）。

## 五、测试（平台内：导航栏「管理 → 邮件通知」，仅 admin 可见）

1. 点 **「发送测试邮件」** → 发到你自己的邮箱，检查：
   - 能收到 → SMTP 通了；
   - 收不到 → 看页面上的失败提示，并去 Supabase → Edge Functions → `send-email` → **Logs** 看错误。
2. 「发送日志」页能看到每封邮件的收件人 / 状态 / 错误。
3. 建一张测试工单 → 指派 → 改状态 → 写评论，确认收件人能收到对应邮件。

## 六、日常使用说明

- **收件人规则**：工单创建人、指派人、指派支持组全员（v6.1 的 group_members）、站点 remote owner 邮箱。触发动作的人自己不会收到自己的邮件。
- **个人偏好**：侧边栏「我的通知」——每个人可单独开关 6 类事件（默认全开）。
- **客户通知总开关**：「邮件通知」设置页 —— 默认**关闭**（customer 角色收不到邮件）。要给客户发时，管理员手动打开。
- **模板**：「邮件模板」页可直接改主题和 HTML 正文（中英文分开），变量如 `{{ticket_no}}` 会自动替换。
- **总开关**：`email_enabled`（默认 true），紧急时可一键停掉所有通知。
- **SLA 预警/逾期**：前端渲染时检测到就发（无定时任务），同一次会话内同一工单同一时钟只发一次。

## 七、正式上线：切换专用邮箱

IT 批下专用邮箱（如 eu-service@longi.com）后，**只改 3 个 Secrets**（`SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`），**不用改代码、不用重新部署**。

## 八、故障排查

| 现象 | 排查 |
|---|---|
| 测试发送失败 `SMTP not configured` | Secrets 没填或没保存（`SMTP_HOST/SMTP_USER/SMTP_PASS` 必填） |
| `AUTH LOGIN failed: 535` | 专用密码错 / 已过期 / 账号被锁 → 重建专用密码 |
| 连接超时 | 公司邮件服务器可能限制了境外 IP（Supabase 发信是从云端连 smtp.longi.com，不是你电脑）→ 找 IT 确认是否有 IP 白名单限制 |
| 收到但进垃圾箱 | 发信量小一般没事；量大了让 IT 配 SPF/DKIM（专用邮箱上线时一并做） |
| 前端没发任何邮件 | 检查：migration_v6_2 跑了没、Edge Function 部署了没、总开关是否被关；浏览器控制台搜 `[email]` 看降级日志 |

## 九、已知限制（Supabase 免费档 + Deno SMTP）

1. **Edge Function 调用次数**：免费档每月 50 万次 —— 工单通知一天 <50 封，完全够用。
2. **单次执行超时 60 秒**：一封邮件的 SMTP 握手通常 <3 秒，超时只会发生在公司邮件服务器无响应时。
3. **Deno 直连 TCP/TLS**：Edge Function 允许任意出站 TCP（不限于 HTTPS），465 端口隐式 TLS 可用；我们手写了 SMTP 协议，没有第三方 HTTP 邮件 API 依赖。
4. **并发**：同时多人操作工单时，每个收件人一次 `invoke`，免费档并发足够。
5. **AUTH 方式**：先 `AUTH LOGIN`，失败自动回退 `AUTH PLAIN`；两家都失败才报错。
6. 中文主题自动做 RFC2047（`=?UTF-8?B?...?=`）编码，HTML 正文为 `text/html; charset=utf-8`。
