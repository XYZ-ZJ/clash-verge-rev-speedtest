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

## v2.6.0

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复检测更新后又发布新版时，应用内更新失败

</details>

<details>
<summary><strong> ✨ 新增功能 </strong></summary>


</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>


</details>
