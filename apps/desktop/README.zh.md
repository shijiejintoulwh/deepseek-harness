# DeepSeek Harness Desktop

[English](README.md) | 中文

`dsh-desktop` 是一个私有的 Windows Electron 宿主，承载普通的 Harness Web profile。

宿主负责安装、运行时选择、进程监管、原生提示与回滚；Harness 功能继续由独立版本的 `dsh web` 运行时提供。

## 发布归属

桌面端源码与安装器版本位于 `dev-windesktop`，使用 `desktop-v*` 标签；经过验证的 Harness 运行时从 `master` 构建，在 `shijiejintoulwh/deepseek-harness` 中使用不可变的 `runtime-v<harnessVersion>-r<revision>` 标签。

预览版壳会在桌面包与 `desktop-v*` 标签中使用相同的 SemVer 预发布后缀。预览版与稳定版 release 会发布相互独立的 Electron 更新通道，因此预览版既不会替换稳定通道元数据，也不会成为最新的稳定桌面端 release。

桌面包保持私有，并有意排除在 dsh 的 npm 发布族之外。

[上游同步 workflow](../../.github/workflows/sync-upstream-runtime.yml) 定义在 fork 的默认分支上，并且每六小时运行一次。定时与手动运行只以合并方式把 `deepseek-ai/deepseek-harness` 同步到 fork 的 `master`，且不重写该分支；`master` push 则会打包该次 push 的精确提交。打包工具以只读方式固定为 `dev-windesktop` 提交；workflow 绝不检出、合并或推送这个桌面分支。生产依赖闭包与签名清单中的源提交只来自 `master`。发生冲突或任何构建、冒烟测试、签名、发布失败时，本次 release 会停止；下次运行会识别已经同步但没有对应 release 目标的 `master` 提交，并重试未完成的发布。

全自动运行要求两个 workflow 文件均位于默认分支、GitHub Actions 的 workflow 权限设为可读写，并在 `runtime-release` environment 中配置 `RUNTIME_SIGNING_PRIVATE_KEY_PEM`。如果为该 environment 设置必需审核人，签名会有意恢复为人工批准步骤。

运行时 workflow 产出一个自包含的 Windows x64 ZIP、`runtime-manifest.json` 与 Ed25519 分离签名；清单绑定 Harness 版本、打包修订、源码提交、Node 版本、压缩包大小、SHA-256 摘要、最低桌面端版本与桌面协议版本。

桌面端 workflow 会在不取得发布凭证的情况下构建并验证 NSIS 安装器、对应 blockmap、一个通道文件（稳定版使用 `latest.yml`，预览版使用 `preview.yml`）与 `desktop-update-manifest.json`。本地发布机先按照预期版本、`desktop-v*` 标签、通道和源码提交验证这组未签名文件，再添加 Ed25519 分离签名并准确发布这五个文件。签名后的桌面端清单会绑定壳版本、通道、源码提交、安装器与 blockmap 的名称、大小和 SHA-256 摘要。

桌面安装器把一组已验证的 release 作为离线种子嵌入，因此首次启动不依赖 GitHub 可用性。

## 存储与生命周期

NSIS 引导式安装器按当前用户安装、不请求提权，并允许用户选择壳的安装目录。

安装器、卸载器、可执行文件、快捷方式与 Electron 窗口统一使用 `build/icon.ico` 中的多尺寸蓝色 DeepSeek Harness 图标。

Electron 用户数据（包括桌面版专用的 `DSH_HOME`）保存在 `%APPDATA%\DeepSeekHarnessDesktop`；版本化运行时与原子选择文档保存在 `%LOCALAPPDATA%\DeepSeekHarnessDesktop`，绝不放入用户选择的安装目录。

主窗口会等待其沙箱化 CommonJS preload 上报 Web 应用解析后的配色方案，以及持久化偏好是否跟随操作系统。宿主先校验发送窗口与固定的上报字段，再应用 Electron 原生主题和匹配的 BrowserWindow 背景，使 Windows 标题栏、应用菜单、对话框与 Web 内容同步切换，同时不向页面暴露任何 Electron API。

关闭主窗口会把它隐藏到 Windows 通知区域，Harness 运行时继续运行。点击托盘图标会恢复并聚焦窗口；托盘上下文菜单可以打开窗口、检查 Harness 更新或明确执行完全退出。首次拦截关闭操作时，程序会静默通知用户如何退出。

首次启动时，宿主会询问是否把现有 CLI Harness home 复制到桌面版专用 home，且不会修改来源目录。可重建的 `node_modules` 依赖树会被省略，不会跟随包管理器创建的 Junction；依赖树之外的任何链接仍会被拒绝。导入中断遗留的空 home 可以直接重试；桌面数据已经存在时，宿主会一次性询问是否先将其保留为同级备份再导入，并在替换导入失败时自动恢复。

宿主使用运行时自带的 Node 24 和明确的 `--no-open` 启动所选版本，只接受其声明的 `http://127.0.0.1` 源，等待真实 Web 壳健康标记，并在退出或重启前等待子进程与日志流完全收敛。不会启动浏览器的旧运行时也早于这个参数；只有运行时精确拒绝 `--no-open` 时，宿主才会去掉它重试。

启动过程不会打开系统浏览器。自动弹窗和跨源顶层导航会被拒绝；只有用户真实操作外部 HTTP(S) 链接时才会交给默认浏览器，且主进程会在打开前重新校验消息来源与 URL。

宿主在启动时检查最新 `runtime-v*` release，下载前征求确认，解析元数据前验证 Ed25519 签名，执行兼容性检查，校验大小与 SHA-256，拒绝不安全的 ZIP 路径和链接，并先安装到全新版本目录再标记为重启候选。发现版本时优先使用匿名 GitHub REST feed；GitHub 报告限流后，宿主会遵守其重置时间，转用公开 Releases Atom feed 和签名资源的直接 URL，不会重复请求受限的 REST 接口。两条发现路径都不可用时，手动检查会显示预计重试间隔，自动检查则保持静默。

独立的 `ShellUpdater` 会检查由已安装壳版本选定的桌面端通道。稳定版只接受更高的稳定版本；预览版可以接受更高的预览版本或稳定版本，两个通道都不允许自动降级。没有可用更新时，后台检查保持静默；通过 `帮助` > `检查桌面端更新` 进行手动检查时，程序会报告检查结果。

发现壳 release 不会直接开始下载。宿主会先征求同意，再让 `electron-updater` 下载 NSIS release，验证桌面端清单签名，并按照签名后的大小与 SHA-256 校验所下载的安装器和 blockmap，随后提供 `重启并更新`。执行安装时，程序会通过正常的完全收敛关闭路径停止 Harness 进程与日志流，再把已经验证的安装包交给 NSIS；普通退出绝不会隐式安装待处理的壳 release。

壳下载与 Harness 运行时下载互斥。壳更新只替换 Electron 安装文件：`%APPDATA%` 用户数据、桌面版专用 Harness home、`%LOCALAPPDATA%` 运行时版本和运行时回滚状态均位于安装目录之外，不会被替换。

上游同步与运行时 release 发布无需人工参与。桌面壳发布需要本地签名和明确的 GitHub Release 命令；个人电脑上的安装继续保留既有的下载与重启确认，防止后台检查在未经同意时占用带宽或打断正在进行的工作。

候选版本只有在页面成功加载并保持存活 30 秒后才会成为当前版本；候选启动失败时保留原运行时，两次失败后拒绝该候选，菜单也可手动交换当前版本与上一个版本以完成回滚。被拒绝的候选会记录进桌面日志，并在下一次启动时提示一次，而不是无声地保持旧版本。

## 版本信息

打开 `帮助` > `关于 DeepSeek Harness`，可以查看启动时实际选择的运行时进程清单所记录的 Harness 语义版本和打包修订，以及 Electron 宿主版本。复制操作还会加入运行时源码提交和内置 Node 版本，便于诊断。这个本地视图不会执行更新发现，也不需要网络访问。

## 本地构建

先在被忽略的本地目录中生成一次签名密钥对，再把公钥嵌入 [`src/config.ts`](src/config.ts)，并把私钥 PEM 作为 `runtime-release` GitHub environment 的 `RUNTIME_SIGNING_PRIVATE_KEY_PEM` secret 保护：

```powershell
pnpm exec tsx scripts/runtime-release/generate-signing-key.ts --out .desktop-local/runtime-signing
```

在被忽略的壳目录中生成独立的桌面端更新签名密钥对。把 `desktop-update-public.pem` 嵌入 [`src/config.ts`](src/config.ts)，并让 `desktop-update-private.pem` 只保留在本地发布机上；不要把它上传到 GitHub Actions 或 Release。生成器拒绝替换任一已有密钥：

```powershell
pnpm exec tsx scripts/desktop-release/generate-signing-key.ts --out .desktop-local/shell-signing
```

在使用 Node 24 且已构建的 Windows x64 checkout 中，生成并验证 release 集、复制为离线种子并打包安装器：

```powershell
pnpm exec tsx scripts/runtime-release/build-windows-runtime.ts --private-key .desktop-local/runtime-signing/runtime-signing-private.pem
pnpm exec tsx scripts/runtime-release/prepare-desktop-seed.ts --from dist-desktop/runtime
pnpm run desktop:dist
```

把四个未签名的桌面端文件整理到 `dist-desktop/release` 后，使用独立复核的 release 输入对其签名。该命令会先验证准确文件集、清单字段、通道元数据、源码提交、大小与摘要，再读取本地私钥并创建 `desktop-update-manifest.sig`：

```powershell
pnpm run desktop:release:sign -- --directory dist-desktop/release --private-key .desktop-local/shell-signing/desktop-update-private.pem --version 1.0.4-preview.3 --tag desktop-v1.0.4-preview.3 --channel preview --source-commit <40-hex-commit>
```

[`sync-upstream-runtime.yml`](../../.github/workflows/sync-upstream-runtime.yml) 与 [`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml) 是权威运行时同步与发布路径。[`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) 是 `desktop-v*` 标签的权威干净 Windows 构建与打包后冒烟测试路径；它仅用仓库读取权限上传包含四个文件的未签名候选。只有该标签 workflow 成功后，发布者才会发布本地签名后的五文件集合。

## 当前限制

个人 MVP 没有 Authenticode 身份，因此即使 Harness 运行时与桌面端 release 产物都会由内嵌 Ed25519 公钥和 SHA-256 摘要独立认证，Windows 仍可能显示未知发布者警告。

Harness 运行时更新仍使用完整的自包含压缩包。Electron 可以使用已发布的 NSIS blockmap 提高传输效率，但壳更新 MVP 不提供自动壳回滚：下载或验证失败时继续运行当前壳，安装失败后则由用户明确重试。

## 社区友链

- [Linux.do](https://linux.do/)
