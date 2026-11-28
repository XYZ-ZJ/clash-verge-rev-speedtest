<!-- Release-notes skeleton. Entries accumulate in ./Changelog.md as PRs land;
     before publishing a release, distill them:
     - user-visible changes only — no dev tooling, CI fixes, or refactors whose
       effect is already covered by another entry
     - describe outcomes, not internals: no internal module names, IPC or
       protocol details, or implementation mechanics — write what the user
       observes, not how the code achieves it
     - one line per theme: merge entries that share a root cause
     - each entry fits a single readable line (about 60 CJK characters); if it
       overflows, it is packing multiple themes or detail that belongs in the
       linked issue/PR — split it or drop the detail
     - line grammar: open with a verb (修复/新增/优化), with the platform
       first (Windows/macOS/Linux) when the change is platform-specific;
       merge sub-symptoms as 主题：症状、症状; full-width punctuation,
       「」 for UI labels, backticks for config keys and commands
     - platform entries sit under their platform heading (bold, emoji
       prefixed, ordered Windows/macOS/Linux, combined for pairs like
       macOS/Linux) at the end of their section;
       scripts-workflow/group_platforms.sh regroups, --check verifies
     HTML comments are stripped by the update dialog's sanitizer and hidden on
     GitHub, so they never reach users. -->
## v2.6.3

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 新增出口详情弹窗「多源 IP 纯净度评分」面板，支持 0–100 分分级展示与一键刷新

</details>

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复代理链环状引用导致挂起的问题，完善页面异常后切换路由时的自动恢复能力
- 修复内核切换或备份恢复失败时的配置回滚与状态恢复问题

**🐧 Linux**

- Linux 修复部分桌面环境下终止信号未能触发清理退出的问题

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>

- 加固图标下载与直连测速的重定向及内网探测防护，拦截危险 SVG 事件脚本
- 强化内核升级 SHA-256 校验机制，补充脚本沙箱线程隔离与递归深度限制
- 优化备份归档恢复阶段校验与原子回滚机制，完善 WebDAV 流式下载大小限制

</details>

## v2.6.2

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 新增 VLESS XHTTP、XMUX 多路复用、后量子加密与 `ech-opts` 链接导入解析
- 新增 `mieru://`、`sudoku://` 与 `ssh://` 分享链接导入，补全主流协议参数支持
- 新增按订阅独立识别节点特性标签，支持嵌套下行配置的多路复用标识展示

</details>

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复首页「IP 信息」与「DNS 泄露」卡片默认自动发起外部请求的问题，改为默认手动触发
- 修复 VLESS 普通 WebSocket 节点被误判开启 HTTP Upgrade 导致连接失败的问题
- 修复规则或节点可视化编辑未及时同步、PAC 占位符被提前固化与表单校验边界问题
- 修复代理链状态识别、日志自动滚动、规则集批量更新提示与侧边栏后台资源占用问题
- 修复应用内更新在非中文界面不显示更新日志及空说明无法点击更新的问题
- 修复默认 DNS 服务器配置分歧并清理残余 `system` 回退项，统一采用海外公共 DNS
- 修复关闭系统代理提前返回、内核切换失败未回滚及测速状态异常问题

**🖥️ Windows**

- Windows 修复全部输入框与编辑器无法打开右键菜单的问题，完善外链导入确认弹窗与脚本打开防护

**🍎 macOS**

- macOS 修复多实例监听端口探测逻辑，避免清理残留套接字后误判本地端口可用性

**🐧 Linux**

- Linux 修复部分非 systemd 环境与提权参数兼容性问题，优化启动阶段环境初始化顺序

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>

- 加固 WebDAV 证书校验与凭据存储保护，限制备份归档恢复路径并自动清除高危启动字段
- 优化核心与更新包校验下载机制，拦截订阅拉取、延迟测速与节点扫描中的私网及异常路径
- 默认随机生成控制接口密钥并收窄本地资源访问范围，补充配置验证与启动脚本超时保护

</details>

## v2.6.1

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 首页新增当前代理节点独立网络测速卡片（支持延迟、丢包率、下载与上传测定）
- 首页新增「代理流量」与「直连流量」双轨分类统计卡片与实时折线图
- 首页新增 DNS 泄露端到端检测卡片与 TUN 严格路由自动加固
- 首页新增多源 IP 风险综合评分展示（0-100 分与网络类型识别）与出口详情分流透视弹窗
- 出口透视集成 Cloudflare 边缘人机验证信誉实测与 WebRTC 泄露检测

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>

- 代理节点列表支持展示 XHTTP 传输协议与 XMUX 多路复用标识标签
- 优化大量订阅节点下的特性提取效率与测速分块上限策略

</details>

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复 DNS 泄露检测在无代理端口下的直连降级隐患，完善出口时区与全局模式判定
- 修复配置文件写入与备份文件名路径校验问题，杜绝截断损坏与越界访问

</details>
