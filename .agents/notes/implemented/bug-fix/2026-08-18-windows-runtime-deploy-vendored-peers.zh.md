# Agent Note: Windows 运行时部署补全工作区依赖闭包

Status: implemented

[English](2026-08-18-windows-runtime-deploy-vendored-peers.md) | 中文

## 问题

Windows 运行时 release 从 fork `master` 构建，而 `pnpm --filter @deepseek-ai/dsh deploy --prod` 会遗漏只作为已部署入口 peer dependency 出现的 package，例如 vendored cordis plugin `@deepseek-ai/cordis-plugin-group`，以及 `dsh-agent-presets` 导入的工作区库 `@deepseek-ai/dsh-scope`。部署后的目录随后会因 `ERR_MODULE_NOT_FOUND` 而无法通过 staged `dsh web` 启动，因此不能发布 `runtime-v*` release，桌面端壳的运行时更新通道也会保持为空。

## 决策

[`build-windows-runtime.ts`](../../../../scripts/runtime-release/build-windows-runtime.ts) 会在生产部署后补全已部署目录的工作区依赖闭包：它扫描每个已部署 manifest 的 `dependencies`、`peerDependencies` 与 `optionalDependencies`，找出 checkout 中存在但尚未安装的工作区 package，以可发布形式复制每个缺失 package 的 manifest、notices、`bin.js`、`lib`、`src`、`config` 与 `cordis.patch.yml`，拒绝链接，并重复执行直到闭包稳定。pnpm 已安装的 package 保持不变，既有的链接逃逸断言与运行时冒烟启动仍会检查补全后的目录。该修复随 `dev-windesktop` 上的打包工具维护；[运行时 workflow](../../../../.github/workflows/windows-runtime-release.yml) 会把这些工具复制到 source checkout，因此 fork `master` 不需要携带 tooling 侧依赖修改。

## 验证

运行时 workflow 的 build job 会针对 fork `master` 执行闭包补全，并通过 staged `dsh web` 启动验证完成后的目录；缺失的运行时导入会在生成任何压缩包或清单之前使构建失败。

## 考虑过的替代方案

**把缺失 package 添加到 fork `master` 上的 `apps/cli` dependencies。** 拒绝，因为 fork `master` 通过仅合并同步跟随官方 `master`，在该分支修改依赖会与后续上游合并冲突，并使已发布的 npm metadata 产生偏差。未来任何只通过 peer dependency 引入的内容也会再次遗漏，而闭包补全会自动跟随依赖图。

**无条件注入每个工作区 package。** 拒绝，因为生产压缩包会包含没有任何导入方的测试支持与示例 package。由 manifest 引用驱动的闭包只会注入运行时可达集合。

## 后果

上游可以新增、移动或重新确定工作区或 vendored package 的 scope，而不会破坏 Windows 运行时构建；闭包会跟随已部署 manifest。注入的 package 仍需要已经构建好的 `lib/`，因此部署前的构建步骤仍然必需。这扩展了[版本化 Windows 桌面运行时](../architecture/2026-08-15-versioned-windows-desktop-runtime.md)的打包路径。
