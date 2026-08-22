# Agent Note: 运行时更新检查以被选中的运行时为比较基线

Status: implemented

[English](2026-08-22-runtime-update-check-selected-baseline.md) | 中文

## Problem

用户接受 Harness 更新并重启后，桌面端会在下一次启动时再次弹出同一版本的更新对话框——公告的正是应用正在运行的版本。`RuntimeUpdater.check` 用 `state.active` 与远端最新版本比较，但刚更新的运行时以 `pending` 身份启动，只有在 [versioned Windows desktop runtime](../architecture/2026-08-15-versioned-windows-desktop-runtime.md) 设计规定的 30 秒稳定期之后才提交为 `active`。自动检查在启动 2 秒后触发，落在该窗口之内；而短于稳定期的会话根本不会提交 pending 运行时——开发期间对话框因此在每次启动时重现，尽管预览壳已经显示最新版本。

## Decision

`RuntimeUpdater.check` 读取 `selectedRuntimeId(state)`（`pending ?? active`）的 manifest 作为比较基线：即桌面端实际运行的运行时。不高于被选中运行时的版本报告 `none`，即使 pending 候选尚未提交；真正更新的版本仍然报告 `available` 或 `desktop-required`。当 pending 候选启动失败、桌面端回退到 `active` 时，记录失败的状态会清除或重试该选择，因此基线始终跟随实际运行的版本。

## Alternatives considered

**在 pending 运行时未结算期间抑制自动检查。** 在 `main.ts` 里做基于时间的抑制会掩盖真正更新、足以取代 pending 的版本，并把更新规则从检查器扩散到编排层。

**启动时立即把 pending 运行时提交为 `active`。** 这会取消稳定期——它保护用户免受启动后立即退出的运行时——并破坏回滚设计。

**在持久状态中记住上次公告的版本。** 仅为掩盖错误基线就增加 updater 状态字段；被选中的运行时本身已经携带答案。

## Consequences

更新对话框不会再公告桌面端正在运行的版本；代价是当 pending 运行时在提交前就被更新版本取代这一罕见情形中，更新提示最多推迟一个稳定期。跳过某版本的用户保持跳过；失败回退在 `pending` 清除后仍会恢复提示。`apps/desktop/tests/updater.spec.ts` 固定四条路径：pending 等于最新、active 等于最新、被选中版本旧于最新、以及更新的版本取代已暂存的 pending 运行时。
