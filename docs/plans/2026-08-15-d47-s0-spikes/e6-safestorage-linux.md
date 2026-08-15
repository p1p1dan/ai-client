# D47 S0-E6 spike：本机（Linux 桌面 VM）实测 electron safeStorage 行为

来源需求：`docs/plans/2026-08-15-login-management-design-spec.md` §3.C —— CredentialVault 存储拍定
"safeStorage 可用即加密，Linux `basic_text`/不可用 → `enc:"none"` + 0600 + 诊断位，不阻断登录"。全仓
safeStorage 零使用先例，需要实测本机后端、加密可用性、密文跨进程可解性。本 spike 只做实验，未改任何
`src/` 产品代码。

## 结论（≤8 行）

1. 本机（GNOME/Wayland、VMware VM、gnome-keyring-daemon 常驻）默认 backend = **`gnome_libsecret`**，
   `isEncryptionAvailable()` = `true`；同进程 encrypt→decrypt 往返、**跨进程**（第二次独立 electron 进程）
   decrypt 均成立——密文可在"模拟重启"后被正确解密。
2. 用 `--password-store=basic` + 清空 `DBUS_SESSION_BUS_ADDRESS` 强制降级后，backend = **`basic_text`**，
   此时 `isEncryptionAvailable()` 正确返回 **`false`**——**Electron 自身已经把 basic_text 判定为"不可用"**，
   规格 §3.C 的判断可以只读 `isEncryptionAvailable()`，**不需要**再额外显式判 `getSelectedStorageBackend()`
   名称去区分 basic_text 分支。
3. **意外重大发现（非任务预期但阻断性）**：在**从未创建过任何 `BrowserWindow`** 的纯无窗口 main 进程里，
   `safeStorage.isEncryptionAvailable()` 会**无限期挂死**（实测两次分别挂起 >230s、>140s，`timeout` 都杀不
   死其 Chromium 子进程），而 `getSelectedStorageBackend()` 在同样零窗口环境下秒回不受影响。用
   `dbus-monitor` 抓包确认：挂死前只做了 `ListNames`/`ListActivatableNames`，从未真正发起对
   `org.freedesktop.secrets` 的 D-Bus 调用——不是等 keyring 解锁提示卡住，更像 Chromium/GTK 主循环相关的
   进程内死锁。创建一个 `show:false` 的隐藏窗口后再调用，`isEncryptionAvailable()` 立即返回，问题消失。
4. 对规格的直接影响：CredentialVault 若在 Main 进程**首个窗口创建之前**（例如极早期 bootstrap/单实例锁
   逻辑里）调用 `safeStorage.isEncryptionAvailable()`，在类似本机的 Linux 桌面环境下有**挂死整个 app**
   的风险；需要在施工阶段确认真实调用时机晚于首窗口创建，或补一个超时兜底。
5. Windows / macOS 两行留待真机轮（`test.4` 通道）补测；本 spike 未在这两个平台跑过。

## 环境

- 系统：Linux 桌面 VM（VMware 虚拟机内 GNOME、Wayland session，`XDG_SESSION_TYPE=wayland`，`DISPLAY=:0`
  可用，GDM 自动登录）
- `gnome-keyring-daemon` 常驻（`--components=pkcs11,secrets`），D-Bus session bus 可用且
  `org.freedesktop.secrets` 已注册（`gdbus call ... Ping` 应答正常）
- Electron 版本：**39.2.7**（`node_modules/electron/package.json`），Chrome 142.0.7444.235，Node 22.21.1
- 沙箱：仓内 `node_modules/electron/dist/chrome-sandbox` 未按 root+4755 配置，直接跑会
  `FATAL ... setuid_sandbox_host.cc`；全程用 `--no-sandbox` 兜底，未用 `xvfb-run`（本机已有真实
  DISPLAY，不需要虚拟帧缓冲）

## 复现命令

```bash
# 脚本目录（本 spike 的 scratchpad，会话级临时目录，产出未纳入仓库）
DIR=/tmp/claude-1000/-home-dan-projects-ai-client/8139279c-c4ed-416e-b915-6d3470238954/scratchpad/e6

# 1) 进程一：默认 backend，encrypt + 同进程 decrypt 往返，密文写盘
/home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox "$DIR/encrypt.js"

# 2) 进程二（独立进程，模拟重启）：只做 decrypt，读进程一写的密文
/home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox "$DIR/decrypt.js"

# 3) 强制 basic_text 分支：断开 D-Bus + --password-store=basic
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_CURRENT_DESKTOP -u DESKTOP_SESSION \
  XDG_CURRENT_DESKTOP=unknown \
  /home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox \
  --password-store=basic "$DIR/probe-basic-text.js"

# 4) 零窗口挂死 vs 建窗口即通的对照
/home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox "$DIR/probe-available.js"      # 挂死，需 kill -9
/home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox "$DIR/probe-with-window.js"    # 秒回

# 5) D-Bus 抓包（验证发现 3 用）
dbus-monitor --session > dbus-monitor.log &
/home/dan/projects/ai-client/node_modules/.bin/electron --no-sandbox "$DIR/probe-available.js"
```

关键脚本逻辑（`encrypt.js` / `decrypt.js` 均：`app.whenReady()` 后建一个 `show:false` 隐藏窗口 → 跑
safeStorage 逻辑 → `win.destroy()` + `app.quit()`，全程无可见窗口）。

## 输出原文

### 进程一：encrypt（默认 gnome_libsecret backend）

```json
{
  "electronVersion": "39.2.7",
  "chromeVersion": "142.0.7444.235",
  "nodeVersion": "22.21.1",
  "platform": "linux",
  "workaroundUsed": "created hidden BrowserWindow before calling safeStorage (see finding: isEncryptionAvailable hangs with zero windows)",
  "isEncryptionAvailable": true,
  "selectedStorageBackend": "gnome_libsecret",
  "ciphertextWritten": true,
  "ciphertextByteLength": 35,
  "sameProcessDecryptMatches": true,
  "sameProcessDecryptValue": "d47-spike-fixture"
}
```

密文（base64）：`djExAVwOUybKNKc0xHOvD75UpAMmxWe90PJsvpQmt1RLI98=`

### 进程二：decrypt（独立进程，读进程一写的密文——跨进程/模拟重启验证）

```json
{
  "electronVersion": "39.2.7",
  "platform": "linux",
  "isEncryptionAvailable": true,
  "selectedStorageBackend": "gnome_libsecret",
  "crossProcessDecryptMatches": true,
  "crossProcessDecryptValue": "d47-spike-fixture"
}
```

### 强制 basic_text 分支（`--password-store=basic` + 无 D-Bus）

```
[239357:...:ERROR:dbus/bus.cc:408] Failed to connect to the bus: Could not parse server address ...
```

```json
{
  "platform": "linux",
  "selectedStorageBackend": "basic_text",
  "isEncryptionAvailable": false
}
```

### 零窗口挂死对照（`probe-available.js`，无 window，只调 `isEncryptionAvailable()`）

两次独立运行分别在 **234s**、**142s+**（本进程主动 `kill -9` 才结束，非自然退出）仍未产出任何结果；
`getSelectedStorageBackend()` 单独探测在同样零窗口条件下秒回 `gnome_libsecret`
（脚本 `probe-backend.js`）。`dbus-monitor` 全程只见 `ListNames` / `ListActivatableNames`，未见任何对
`org.freedesktop.secrets` 的方法调用。

### 建窗口即通对照（`probe-with-window.js`：`whenReady` 后先 `new BrowserWindow({show:false})`）

```
READY
WINDOW_CREATED
CALLING isEncryptionAvailable (with window present)...
AVAILABLE=true
```

秒回，无挂死。

## 回答任务第 4 步的四个问题

- **backend 名称**：默认 `gnome_libsecret`；强制降级后可复现 `basic_text`。
- **`isEncryptionAvailable()`**：`gnome_libsecret` 下为 `true`；`basic_text` 下为 `false`。
- **`basic_text` 是否仍返回 `true`（决定规格要不要显式判 backend 名）**：**不需要**——`basic_text` 下
  `isEncryptionAvailable()` 已经如实返回 `false`，规格 §3.C 只读这一个布尔值就够，无需额外分支判断
  backend 字符串。
- **跨进程解密是否成立**：成立——进程二独立启动、独立读盘、`decryptString` 正确还原进程一写入的明文。

## 待补测（真机轮 / `test.4` 通道）

- Windows：DPAPI backend，预期 `isEncryptionAvailable()` 恒 `true`（依赖当前用户 profile），需真机验证
  跨进程解密与"零窗口挂死"现象是否复现（怀疑该挂死是 Linux GTK/D-Bus 主循环特有，Windows/macOS 大概率
  不受影响，但未验证前不可当结论用）。
- macOS：Keychain backend，同样需真机验证挂死现象是否平台特有。
