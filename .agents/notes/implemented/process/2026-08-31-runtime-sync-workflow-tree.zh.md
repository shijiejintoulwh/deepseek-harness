# Agent Note: 官方 runtime 同步保留 fork 的 workflow 树

Status: implemented

[English](2026-08-31-runtime-sync-workflow-tree.md) | 中文

## 问题

定时和手动 runtime 同步使用仓库只有 contents 写权限的 `GITHUB_TOKEN` 合并官方 `master`。官方 workflow 的改动可能在产生合并提交前就与本 fork 的 workflow 树冲突。即使合并没有冲突，该 token 也不能推送发生变化的 workflow 文件，runtime 打包因此不会启动。

## 决策

同步脚本执行 no-fast-forward 合并，但暂不提交。它只接受 `.github/workflows` 或 fork 自有的 `scripts/ci-workflow.spec.ts` 中的未解决路径，从第一个父提交恢复这些文件，再提交合并。任何 runtime 源码冲突都会在推送前停止作业。结果提交保留官方 runtime 源码和本 fork 的发布编排，只有 contents 写权限的 token 因此能推送 `master`，并按精确的合并源码提交打包。

## 考虑过的替代方案

**为 workflow token 授予 workflow 文件权限。** 拒绝，因为该权限需要另行管理的 token 或仓库 secret，默认 `GITHUB_TOKEN` 的权限声明无法提供。

**当 workflow 文件变化时跳过官方合并。** 拒绝，因为仅仅由于官方同时改动控制面文件，就停止接收官方源码更新会使 runtime 分支过期。

**对所有合并冲突都优先采用 fork 版本。** 拒绝，因为自动选择 runtime 源码可能悄悄丢失官方的安全或生命周期修复。

**手工列出需要恢复的 workflow 文件。** 拒绝，因为恢复完整目录也能覆盖官方新增和删除的 workflow 文件，不会让控制面发生漂移。

## 后果

Runtime 源码和包元数据会在源码合并无冲突时随官方前进；源码冲突需要审查解决。本 fork 保留 `.github/workflows` 和对应的 workflow 测试。合并提交会作为 Windows runtime release 的 source SHA，因此发布元数据标识的就是实际打包的精确树。本 fork 的 workflow 变更仍通过普通的已认证分支推送进入。
