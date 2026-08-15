# DeepSeek Harness Desktop

[English](README.md) | 中文

`dsh-desktop` 是一个私有的 Windows Electron 宿主，承载普通的 Harness Web profile。

宿主负责安装、运行时选择、进程监管、原生提示与回滚；Harness 功能继续由独立版本的 `dsh web` 运行时提供。

## 发布归属

桌面端源码与安装器版本位于 `dev-windesktop`，使用 `desktop-v*` 标签；经过审核的 Harness 运行时从 `master` 构建，在 `shijiejintoulwh/deepseek-harness` 中使用不可变的 `runtime-v<harnessVersion>-r<revision>` 标签。

桌面包保持私有，并有意排除在 dsh 的 npm 发布族之外。

运行时 workflow 产出一个自包含的 Windows x64 ZIP、`runtime-manifest.json` 与 Ed25519 分离签名；清单绑定 Harness 版本、打包修订、源码提交、Node 版本、压缩包大小、SHA-256 摘要、最低桌面端版本与桌面协议版本。

桌面安装器把一组已验证的 release 作为离线种子嵌入，因此首次启动不依赖 GitHub 可用性。

## 存储与生命周期

NSIS 引导式安装器按当前用户安装、不请求提权，并允许用户选择壳的安装目录。

安装器、卸载器、可执行文件、快捷方式与 Electron 窗口统一使用 `build/icon.ico` 中的多尺寸蓝色 DeepSeek Harness 图标。

Electron 用户数据（包括桌面版专用的 `DSH_HOME`）保存在 `%APPDATA%\DeepSeekHarnessDesktop`；版本化运行时与原子选择文档保存在 `%LOCALAPPDATA%\DeepSeekHarnessDesktop`，绝不放入用户选择的安装目录。

首次启动时，宿主会询问是否把现有 CLI Harness home 复制到桌面版专用 home，且不会修改来源目录。可重建的 `node_modules` 依赖树会被省略，不会跟随包管理器创建的 Junction；依赖树之外的任何链接仍会被拒绝。导入中断遗留的空 home 可以直接重试；桌面数据已经存在时，宿主会一次性询问是否先将其保留为同级备份再导入，并在替换导入失败时自动恢复。

宿主使用运行时自带的 Node 24 启动所选版本，只接受其声明的 `http://127.0.0.1` 源，等待真实 Web 壳健康标记，并在退出或重启前等待子进程与日志流完全收敛。

宿主在启动时检查最新 `runtime-v*` release，下载前征求确认，解析元数据前验证 Ed25519 签名，执行兼容性检查，校验大小与 SHA-256，拒绝不安全的 ZIP 路径和链接，并先安装到全新版本目录再标记为重启候选。

候选版本只有在页面成功加载并保持存活 30 秒后才会成为当前版本；候选启动失败时保留原运行时，两次失败后拒绝该候选，菜单也可手动交换当前版本与上一个版本以完成回滚。

## 本地构建

先在被忽略的本地目录中生成一次签名密钥对，再把公钥嵌入 [`src/config.ts`](src/config.ts)，并把私钥 PEM 作为 `runtime-release` GitHub environment 的 `RUNTIME_SIGNING_PRIVATE_KEY_PEM` secret 保护：

```powershell
pnpm exec tsx scripts/runtime-release/generate-signing-key.ts --out .desktop-local/runtime-signing
```

在使用 Node 24 且已构建的 Windows x64 checkout 中，生成并验证 release 集、复制为离线种子并打包安装器：

```powershell
pnpm exec tsx scripts/runtime-release/build-windows-runtime.ts --private-key .desktop-local/runtime-signing/runtime-signing-private.pem
pnpm exec tsx scripts/runtime-release/prepare-desktop-seed.ts --from dist-desktop/runtime
pnpm run desktop:dist
```

[`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml) 与 [`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) 是权威发布路径。

## 当前限制

个人 MVP 没有 Authenticode 身份，因此即使每份 Harness 运行时都会由内嵌 Ed25519 公钥与 SHA-256 摘要独立认证，Windows 仍可能显示未知发布者警告。

目前只支持完整的自包含运行时压缩包；增量更新与 Electron 壳自动更新留待后续实现。
