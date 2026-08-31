# Agent Note: 官方 runtime 同步保留 fork 的 workflow 树

Status: implemented

[English](2026-08-31-runtime-sync-workflow-tree.md) | 中文

## 问题

定时和手动 runtime 同步使用仓库只有 contents 写权限的 `GITHUB_TOKEN` 合并官方 `master`。当官方合并包含 `.github/workflows` 下的变更时，GitHub 会因为该 token 不能创建或更新 workflow 文件而拒绝推送，runtime 打包因此不会启动。

## 决策

官方 no-fast-forward 合并完成后，从该合并的第一个父提交恢复完整的 `.github/workflows` 树，并且只在这棵树发生变化时 amend 合并提交。结果提交保留官方 runtime 源码，同时保留本 fork 的发布编排；随后只有 contents 写权限的 token 就能推送 `master`，runtime workflow 也能按 amend 后的精确源码提交打包。

## 考虑过的替代方案

**为 workflow token 授予 workflow 文件权限。** 拒绝，因为该权限需要另行管理的 token 或仓库 secret，默认 `GITHUB_TOKEN` 的权限声明无法提供。

**当 workflow 文件变化时跳过官方合并。** 拒绝，因为仅仅由于官方同时改动控制面文件，就停止接收官方源码更新会使 runtime 分支过期。

**手工列出需要恢复的 workflow 文件。** 拒绝，因为恢复完整目录也能覆盖官方新增和删除的 workflow 文件，不会让控制面发生漂移。

## 后果

Runtime 源码和包元数据继续随官方前进，而 `.github/workflows` 始终由本 fork 持有。amend 后的合并提交会作为 Windows runtime release 的 source SHA，因此发布元数据标识的就是实际打包的精确树。本 fork 的 workflow 变更仍通过普通的已认证分支推送进入。
