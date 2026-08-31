# Agent Note: Windows 运行时 smoke 会交换 Web 启动令牌

Status: implemented

[English](2026-08-31-windows-runtime-smoke-auth.md) | 中文

## 问题

Windows runtime smoke 直接请求带认证信息的 Web URL，并要求立即得到 `200`。Connection 的 Web 认证会有意让第一次启动令牌请求返回 `303` 并设置绑定 authority 的 cookie，因此 staged runtime 虽然能够启动并打印 URL，所有 smoke probe 仍然未认证。构建会在签名和发布一个完整 runtime 压缩包之前停止。

## 决策

Smoke probe 使用手动重定向处理请求打印出的 URL，提取返回的 session cookie，然后携带该 cookie 请求不带查询参数的 loopback 根路径，再检查注入的 `__DSH_BOOT__` 标记。子进程增加 `--no-open`，因此 CI smoke 不会启动浏览器。probe 仍受现有重试期限限制，并且不会把提取出的 cookie 追加到有界的子进程输出诊断中。

## 考虑过的替代方案

**让 fetch 按默认策略跟随重定向。** 拒绝，因为 Node 的 fetch 不保留浏览器 cookie jar，重定向后的 clean 请求仍然不会通过认证。

**为 smoke 进程关闭 Web 认证。** 拒绝，因为打包 runtime 必须验证桌面端使用的同一启动令牌与 cookie 交换；绕过认证会使发布的压缩包没有经过真实启动路径的测试。

## 后果

Smoke test 现在覆盖首次浏览器请求的完整流程，可以发布实际可访问 Web shell 的 runtime。该检查依赖 Web 启动协议保持为 `303` 令牌交换再请求 clean root；如果协议改变，必须同时更新该 probe 与其聚焦测试。
