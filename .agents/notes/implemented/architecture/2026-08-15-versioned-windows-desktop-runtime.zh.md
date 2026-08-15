# Agent Note：独立版本的 Windows 桌面运行时

Status: implemented

[English](2026-08-15-versioned-windows-desktop-runtime.md) | 中文

## 问题

Windows 产品需要一个可安装且允许用户选择安装目录的壳，同时 Harness 主程序必须能继续跟随经过审核的 `master` 变更，而不是每个 Harness 版本都重新发布 Electron 安装器。

原地更新文件无法留下可信的最后已知可用版本；在应用启动时下载 npm 包又会让已安装产品依赖可变的注册表解析、包脚本与用户自己的 Node 安装。

这个 fork 还需要明确的归属边界：桌面专用代码留在 `dev-windesktop`，运行时则由经过审核的 `master` 提交构建。

## 决策

[`apps/desktop`](../../../../apps/desktop/README.md) 是版本为 `1.x` 的私有 Electron 宿主；它排除在 dsh 的 npm 发布族之外，该发布族中的可发布应用仍是 [npm 发布决策](../process/2026-08-10-npm-release-sequences.md)所定义的 `apps/cli` 与 `apps/web`。

壳从 `dev-windesktop` 手动发布为 `desktop-v*`；普通壳更新不自动进行。

[运行时 workflow](../../../../.github/workflows/windows-runtime-release.yml) 只能从 `master` 执行：它把 `@deepseek-ai/dsh` 的生产闭包部署为无符号链接的 hoisted 树，复制官方 Node 24 可执行文件与 notices，启动暂存的 `dsh web` 以验证真实 Web 壳，然后归档准确的目录树。

每个运行时版本都是不可变的 `runtime-v<harnessVersion>-r<revision>` GitHub Release，包含压缩包、准确 JSON 清单与 Ed25519 分离签名。

壳内嵌公钥，并在解析严格清单前验证签名；签名字段绑定平台、架构、Harness 版本、打包修订、提交 SHA、Node 版本、资源名与大小、SHA-256、最低桌面端版本、准确桌面协议版本及发布时间。

下载与解压都有边界，使用暂存文件和目录，拒绝未知清单字段、路径穿越、重复的不安全名称与 ZIP 链接，并在清理归属目录树时绝不跟随链接。

NSIS 引导式安装器按当前用户安装、不请求提权并允许自定义壳目录；种子运行时作为额外资源嵌入，所以首次启动可离线完成。由仓库蓝色 favicon 生成的多尺寸 ICO 统一用于安装器、卸载器、可执行文件、快捷方式与应用窗口。

Electron 用户数据与桌面专用 Harness home 位于 `%APPDATA%\DeepSeekHarnessDesktop`；版本化运行时及其原子状态位于 `%LOCALAPPDATA%\DeepSeekHarnessDesktop`，与壳安装目录相互独立。

这里沿用既有的[单一 Harness home 解析器](2026-07-24-single-harness-home-resolver.md)：宿主通过 `DSH_HOME` 提供专用目录，而不引入第二个解析器；首次启动可在明确同意后复制现有 home，且不修改来源。导入时会省略可重建的 `node_modules` 依赖树，而不会跟随其中的包管理器链接；其他位置的链接仍会被拒绝。不存在或为空的桌面 home 可以直接替换；已经产生独立桌面数据后，一次性的明确选择会先把它保留为随机命名的同级备份，在导入失败时恢复该备份，并记录导入或保留决定，使后续启动不再反复询问。

运行时状态保留 `active`、`previous`、`pending` 标识，以及候选失败次数和被跳过的 release。

更新会安装在现有版本旁，并在用户确认后标记为重启候选；候选只有在 Web 页面加载并持续存活 30 秒后才成为当前版本，启动失败不会改变当前版本，两次失败后拒绝候选，用户也可明确交换当前版本与上一个版本。

宿主只启动运行时自带的 Node，只接受带有 Web 壳标记的已声明 `http://127.0.0.1` URL，把 renderer 导航限制在该 origin，并在退出或重启前等待准确的子进程树与日志流完全收敛。

## 考虑过的替代方案

**把 Electron 与 Harness 作为一个产品更新。** 拒绝，因为每次经过审核的 Harness 变更都会要求发布更大的安装器，并把稳定的原生壳绑定到更快的运行时节奏。

**原地安装最新 npm 包。** 拒绝，因为解析是可变的、可能执行包生命周期脚本、依赖外部 Node 与 pnpm 状态，而且没有可认证、可完整保留用于回滚的制品。

**替换当前运行时目录。** 拒绝，因为中断或启动失败可能破坏唯一可用版本；不可变版本目录让激活成为原子状态变更。

**直接复用 CLI home。** 拒绝，因为桌面端回滚与试验不应隐式修改命令行状态；明确的一次性复制既保留用户选择，也维持单一解析器政策。

**在首版提供增量更新。** 拒绝，先证明完整自包含 release 路径与回滚状态；后续增量格式仍必须认证重建后的完整制品。

## 后果

Harness release 可以独立于壳推进，首次启动可使用离线种子，并保留一个最后已知可用运行时用于自动或手动回滚。

签名私钥成为发布基础设施：它必须留在仓库之外，作为 `RUNTIME_SIGNING_PRIVATE_KEY_PEM` 保存在受保护的 `runtime-release` environment 中；轮换私钥时必须同时发布内嵌新公钥的壳。

完整压缩包的下载量与磁盘占用高于增量包，首次种子安装也必须解压生产依赖树；无符号链接的 hoisted 布局在不改变运行时闭包的前提下限制了这项成本。

个人 MVP 没有 Authenticode 身份，所以即使运行时内容经过密码学认证，Windows 仍可能对安装器发出警告。

GitHub 可用性与匿名 API 限额会影响更新发现，但不影响首次启动或当前已安装运行时。
