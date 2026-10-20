# Clash Verge Rev (SpeedTest & Traffic Enhanced)

A modern, high-performance proxy client based on [Tauri 2](https://github.com/tauri-apps/tauri) and the [Mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo) core. This fork features an **Active Proxy Speedtest Card**, **Proxy & Direct Split Traffic Stats**, and a comprehensive fix for **background traffic tracking**.

---

## 🌟 Enhanced Features in This Fork

### 1. 🚀 Active Proxy Network Speedtest
- **True Proxy Testing**: Integrated directly on the main dashboard, speed tests route strictly through the active proxy node via the live Mixed Port tunnel.
- **4 Key Metrics**:
  - **Latency (Ping)**: Average round-trip time across multiple probes.
  - **Packet Loss (%)**: Probe failure percentage.
  - **Download Speed (MB/s)**: Real-time streaming download bandwidth test.
  - **Upload Speed (MB/s)**: Real-time upload bandwidth test.
- **Node Location & Timestamp**:
  - Automatically identifies and displays the outbound location of the tested node (e.g. `Singapore, SG`).
  - Displays the completion timestamp on the bottom-right.
- **Persistent State**: Test results are automatically cached locally; the card can be toggled on/off in the home settings dialog.

### 2. 📊 Split Traffic Stats (Proxy vs. Direct)
- Refactored cluttered individual metric cards into two clean, informative cards:
  - **● Proxy Traffic**: Real-time upload/download speeds and cumulative downloaded/uploaded volume routed through proxy nodes.
  - **● Direct Traffic**: Real-time upload/download speeds and cumulative downloaded/uploaded volume routed through DIRECT connections.
- Clean dual-color styling paired with the real-time canvas traffic graph.

### 3. 🔄 Continuous Background Traffic Tracking
- Fixed the upstream issue where minimizing or running in the background halted WebSocket subscriptions and created gaps in traffic stats.
- Decouples background data sampling from frontend rendering: traffic curves and cumulative totals remain continuous throughout the application's lifecycle.

---

## 📦 Downloads & Installation

Download the latest releases from this repository:

👉 **[Download Latest Release](https://github.com/XYZ-ZJ/clash-verge-rev-speedtest/releases)**

| Architecture | Package | Description |
| :--- | :--- | :--- |
| **Windows x64** | `Clash.Verge_2.5.9_x64-setup.exe` | Recommended 64-bit installer, signed with dedicated Minisign key |

---

## 📜 License

This project is licensed under the [GPL-3.0 License](./LICENSE).
