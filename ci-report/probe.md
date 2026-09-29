出口 IP        : 20.109.39.54
User-Agent     : Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, l
Cookie         : 未提供（只做可达性探测）

| 站点 | HTTP | 字节 | CF拦截 | 登录态 |
| --- | --- | --- | --- | --- |
| https://www.north-plus.net | 403 | 5828 | **是** | 已登录 |
| https://www.south-plus.net | 403 | 5849 | **是** | 已登录 |
| https://www.summer-plus.net | 403 | 5850 | **是** | 已登录 |
| https://www.level-plus.net | 403 | 5828 | **是** | 已登录 |

判读方法：
  1. 出口 IP 和你浏览器当前的公网 IP 不一致 → 会话会被 PHPWind 判为异地，
     表现为「Cookie 明明有效却提示没有登录」。
  2. CF拦截=是 → 这个 IP 被 Cloudflare 挑战页挡住，纯 HTTP 客户端过不去。
  3. CF拦截=否 但登录态仍为「未登录」→ 就是第 1 条。

## 带 Cookie 的真实校验

未配置 NORTH_COOKIE secret，跳过这一步。
