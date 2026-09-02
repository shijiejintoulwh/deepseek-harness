# Agent Note: runtime 同步向被调用的发布 workflow 转发仓库 secrets

Status: implemented

[English](2026-09-02-runtime-release-secret-forwarding.md) | 中文

## 问题

所有自动化 runtime 发布都在签名步骤以 `RUNTIME_SIGNING_PRIVATE_KEY_PEM is not configured` 失败，尽管该 secret 存在于仓库级，且手动 dispatch 的 `windows-runtime-release.yml` 一直能成功签名。被调用的可复用 workflow 除非调用方显式转发，否则看不到调用方的仓库级 secrets，因此定时和推送路径上签名任务里的 `secrets.RUNTIME_SIGNING_PRIVATE_KEY_PEM` 求值为空字符串，而直接 dispatch 的运行不受影响。

## 决策

`sync-upstream-runtime.yml` 的 `release` 任务在调用 `windows-runtime-release.yml` 时声明 `secrets: inherit`，把仓库级签名私钥转发给签名任务。`scripts/ci-workflow.spec.ts` 固定这一转发，自动化路径不会再悄悄失去密钥访问权。

## 考虑过的替代方案

**把签名密钥复制进 `runtime-release` environment。** 拒绝：environment secrets 确实能到达被调用 workflow 的签名任务，但私钥只存在于 2026-08-17 上传的仓库级 secret 中，本地 PEM 文件已不存在，不重新生成密钥对（使所有已安装的桌面端失去信任）就无法复制。

**在同步 workflow 内部签名而不是在被调用 workflow 中签名。** 拒绝：签名属于发布 workflow 已经隔离出来的无 checkout、绑定 environment 的签名任务，不应与构建凭据混在一起。

## 后果

定时和推送触发的同步可以无人值守地签名并发布 runtime release，与一直可用的直接 dispatch 路径保持一致。`runtime-release` environment 仍是签名的保护边界：在那里添加必需审批人依然能把发布变成需要审批的步骤，无需再改 workflow。
