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
## v2.6.2

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 新增代理链接对 VLESS XHTTP、XMUX（`reuse-settings`）、后量子加密与 `ech-opts` 参数的完整解析支持
- 新增 `mieru://`、`sudoku://` 与 `ssh://` 代理分享链接导入解析，支持多端口组与更多 Mihomo 传输参数
- 节点特性标签按独立订阅作用域精确识别，支持嵌套下行配置的多路复用标识展示

</details>

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复首页「IP 信息」与「DNS 泄露」卡片默认自动发起外部探测的问题，改为默认手动触发并保留自动刷新开关
- 修复多处设置弹窗输入校验与保存时序问题：规则可视化编辑未及时同步、PAC 占位符被提前固化、外部控制器未先校验凭据即开启开关
- 修复代理链状态识别、`Logs` 满缓冲自动滚动、规则集批量更新状态反馈与侧边栏折叠态后台资源占用问题
- 修复应用内更新在部分语言环境不显示更新日志及空说明无法点击更新的问题，完善内置更新源与依赖版本同步
- 修复默认 DNS 服务器配置分歧并清理本地/扩展配置中的无效系统回退项，统一采用海外公共 DNS 基准配置
- 修复系统代理关闭并发等待提前返回、内核切换失败状态未回滚及订阅/测速流程中的边界异常处理

**🍎 macOS**

- macOS 修复多实例监听端口探测逻辑，避免清理残留套接字后误判本地端口可用性

**🐧 Linux**

- Linux 修复部分非 systemd 环境与提权工具参数兼容性问题，优化启动阶段环境初始化顺序

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>

- 加固 WebDAV 凭据本地存储加密（AES-256-GCM），收紧备份归档导入导出路径白名单并补充解压体积校验
- 优化更新下载签名摘要与体积上限防护机制，限制低速分块上传超时与流式进度通道取消处理

</details>

## v2.6.1

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 首页新增当前代理节点独立网络测速卡片（支持延迟、丢包率、流式下载与分块上传四维测定）
- 首页新增「代理流量」与「直连流量」双轨分类统计卡片与高性能 Canvas 流量折线图
- 首页新增 DNS 泄露端到端检测卡片与 TUN 严格路由自动加固
- 首页新增多源 IP 风险综合评分展示（0-100分与网络类型识别）与出口详情分流透视弹窗
- 出口透视集成 Cloudflare 边缘人机验证信誉实测与 WebRTC 泄露检测

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>

- 代理节点列表支持展示 XHTTP 传输协议与 XMUX 多路复用标识标签
- 异步上下文代理特性提取重构为并发后台任务，杜绝大订阅下的调度卡顿与 Clippy 复杂度告警
- 测速引擎单块上限严格限制为 25MB 并实施稳态平滑采样，有效杜绝 Cloudflare 403 阻断

</details>

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复 DNS 泄露检测在零端口下的安全直连降级隐患，改用 nanoid 随机化探针标识
- 修复流量卡片在 React Compiler 检查下的状态读取冲突与 cloneElement 规范警告
- 修复配置文件原子写入与备份文件名安全路径校验，杜绝截断损坏与目录穿越风险
- 修复出口透视未探测即硬编码协议结论的缺陷，优化时区比对缺失兜底

</details>
