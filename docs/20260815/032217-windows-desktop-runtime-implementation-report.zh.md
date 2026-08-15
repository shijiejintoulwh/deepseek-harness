# Windows 桌面运行时实施报告

[English](032217-windows-desktop-runtime-implementation-report.md) | 中文

完成时间：2026-08-15 03:22:17 +08:00

## 结果

个人 Windows MVP 已在本地实现并打包：来自 `dev-windesktop` 的稳定 Electron 壳承载从经过审核的 `master` 构建的独立版本 Harness 运行时，按当前用户安装到用户选择的壳目录，在应用内检查已签名的 Harness 更新，下载与重启前征求确认，保留上一个运行时，并在候选失败时回滚且不回滚用户数据。

最终 NSIS 安装器已安装到隔离的自定义目录，安装后的可执行文件使用内嵌运行时完成离线首次启动，产品卸载器随后移除了该测试安装；三个进程的退出码均为 0。壳 `1.0.2` 修复了首次导入 npm/pnpm Junction 依赖树的问题，并使用 DeepSeek Harness 品牌图标。

本次没有创建 commit、push、GitHub Release 或仓库 secret。

## 已交付设计

[`apps/desktop`](../../apps/desktop/README.md) 只负责 Electron 窗口、原生更新提示、版本选择、运行时存储、进程生命周期、首次导入与回滚；它通过经过验证的回环 origin 加载普通 `dsh web` UI，并启用 renderer sandbox 与 context isolation，同时禁用 Node integration。

壳是私有的 `1.0.2` workspace 应用并排除在 dsh 的 npm 发布族之外，可发布的 CLI 与 Web 应用继续使用根 Harness 版本。

仓库中的蓝色 DeepSeek Harness favicon 生成了包含七种尺寸的 Windows ICO，统一用于安装器、卸载器、可执行文件、快捷方式与 Electron 窗口。

[`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml) 只从 `master` 构建，部署带 Node 24 的完整、无符号链接 hoisted 生产闭包，验证暂存 Web 壳，用 Ed25519 签署严格清单，并可发布不可变的 `runtime-v<harnessVersion>-r<revision>` 资源。

[`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) checkout `dev-windesktop`，下载指定的已签名运行时 release 作为离线种子，构建 NSIS 引导式安装器，执行打包冒烟测试，并可发布手动安装的 `desktop-v*` 壳 release。

运行时状态在原子 JSON 文档中保存 `active`、`previous`、`pending`、候选启动失败次数和被跳过的 release；新候选只有在页面加载并持续存活 30 秒后才提交，两次启动失败会拒绝候选并保留当前版本。

架构与安全理由保存在 active implemented 的[版本化 Windows 桌面运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-versioned-windows-desktop-runtime.md)中。

## 存储与安装

NSIS 配置采用引导式而非 one-click 安装，设置 `perMachine: false`、禁用提权，并启用 `allowToChangeInstallationDirectory`。

用户选择的目录只包含 Electron 壳；Electron 用户数据与桌面专用 `DSH_HOME` 位于 `%APPDATA%\DeepSeekHarnessDesktop`，版本化运行时与选择文档位于 `%LOCALAPPDATA%\DeepSeekHarnessDesktop`。

首次启动会在明确同意后询问是否复制现有 CLI Harness home，且绝不修改来源 home。导入器会省略可重建的 `node_modules` 依赖树，而不会跟随其中的包管理器 Junction；其他位置的链接仍会被拒绝，首次运行中断遗留空的桌面 home 时也可安全重试。

`1.0.0` 导入失败后，桌面版又生成了新的 profiles、凭据、设置与存储数据。壳 `1.0.2` 可以直接替换不存在或为空的真实目录；对于现在的非空状态，它会询问是否先把完整目录保留为同级备份再导入，并在导入失败时恢复备份，绝不合并或静默覆盖两个 home。

## 本地产物

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| `dist-desktop/DeepSeek-Harness-Desktop-1.0.2-win-x64.exe` | 200,279,729 | `be6d2f04d0bc1e703b7b6dd0be9fda0f099e6c080eb1c366f3acb4c7c3a7a10b` |
| `dist-desktop/runtime/deepseek-harness-runtime-win32-x64-0.1.0-rc.5-r1.zip` | 113,588,985 | `b37780a7355786c35889d6805290e12b34d72ff94c8b0aba25d78dd4fc559864` |
| `dist-desktop/runtime/runtime-manifest.json` | 487 | `b09a917e6f12cc5a7bec6687fa8151679c9c634cd68cd9873268c66323b46aca` |
| `dist-desktop/runtime/runtime-manifest.sig` | 89 | `5f861dca9197c72d23a0282d4acb2b9743cebfb48c368d7fa508d594225f6e92` |

签名清单选择 Harness `0.1.0-rc.5-r1`、提交 `47f943859bef60e4160492346772ded9b24f765a`、Node `v24.19.0`、最低桌面端 `1.0.0` 与桌面协议 `1`。

生成的安装器、运行时资源、种子与本地签名密钥均被 Git 忽略；只有源码、workflow、文档与锁文件变更应进入版本控制。

## 验证证据

| 证据 | 结果 |
|---|---|
| 运行时构建 | 生产部署、锁文件供应链政策、链接收容、暂存 `dsh web` 健康检查、ZIP、SHA-256 与 Ed25519 清单生成均通过。 |
| RuntimeStore 安装 | 最终 113,588,985 字节 release 通过验证，并在 115.3 秒内安装为 `0.1.0-rc.5-r1`。 |
| 已安装运行时启动 | 已安装运行时声明 `127.0.0.1` URL、提供真实 Web 壳，并达到进程与日志收敛。 |
| 打包壳冒烟 | `win-unpacked` 完成离线种子安装、选择预期运行时、启动 `dsh web`，并在 123 秒内以退出码 0 结束。 |
| 打包图标 | ICO 包含从 16 到 256 像素的七种 Windows 尺寸；打包资源与源文件的 hash 完全一致，从应用与 NSIS 安装器中提取的图标均显示蓝色 DeepSeek Harness 标志，带品牌图标的 `1.0.2` 应用在隔离启动冒烟测试中以退出码 0 结束。 |
| Junction 导入回归 | 打包后的 `1.0.2` 壳会将隔离的非空桌面 home 保留为同级备份，导入旧 home 标记，不跟随或修改外部 SDK Junction，从所选运行时重建依赖并启动 `dsh web`；7 个聚焦导入场景也全部通过，包括非空桌面 home 的失败恢复。 |
| NSIS 自定义目录测试 | 安装器退出 0、已安装应用冒烟退出 0、卸载器退出 0，隔离安装目录已移除。 |
| 聚焦行为测试 | 桌面状态、签名/压缩包安装、home 导入、进程生命周期、运行时清单、发布族排除与 pnpm 风格 profile 遍历的 7 个文件、42 个测试通过。 |
| Workflow 与变更范围测试 | 2 个文件通过；17 个测试通过，3 个不适用于当前平台的测试跳过。 |
| 最终合并回归 | 9 个相关文件通过；59 个测试通过，3 个不适用于当前平台的测试跳过。 |
| 仓库构建 | 完整 host、client 与 Web 构建在 93.8 秒内通过。 |
| 静态检查 | Client TypeScript 检查、全仓 lint、knip、publint、workspace 约束、包许可证、包不变量、构建后不变量、NodeNext 声明与运行时闭包均通过。 |
| 文档检查 | 28 个 doc-sync gate 全部通过，包括 Markdown 链接与换行、Agent Note 格式与分类、双语配对、catalog、文档预算与文档站点构建。 |
| Agent Note 审计 | 新架构记录保留为 active；没有 implemented note 被归档，没有 rejected note 被保留或删除，也没有 proposed note 被拒绝。npm 发布记录已按事实更新，以排除私有桌面应用。 |

## 发布交接

本地签名密钥对只存在于被忽略的 `.desktop-local/runtime-signing`；私钥 PEM 必须复制到受保护的 `runtime-release` GitHub environment，命名为 `RUNTIME_SIGNING_PRIVATE_KEY_PEM`，且不得提交或写入日志。

运行时构建器、生产闭包修复、CLI peer 声明与运行时 workflow 必须进入 `master`；Electron 应用与桌面 workflow 留在 `dev-windesktop`，随后消费已发布的运行时标签。

当前环境无法刷新 SSH 远程，因为 GitHub 拒绝了可用公钥，所以远程 CI 与 Releases 仍未验证、未发布。

分支变更经过审核并推送后，从 `master` dispatch 运行时 workflow，revision 使用 `1`、最低桌面端使用 `1.0.0` 并启用发布；再在 `dev-windesktop` 上用该运行时标签与 `desktop-v1.0.2` dispatch 桌面 workflow。

## 已知限制

个人 MVP 没有 Authenticode 证书，所以即使 Harness 运行时拥有独立 Ed25519 签名与 SHA-256 摘要，Windows 仍可能显示未知发布者警告。

更新使用完整自包含压缩包而不是增量包，Electron 壳也不会自动更新；壳的兼容性或安全变更需要手动安装 `desktop-v*` release。

更新发现使用 GitHub 公共 API，可能受匿名限额或网络可用性影响；首次启动和已经安装的运行时仍可离线工作。
