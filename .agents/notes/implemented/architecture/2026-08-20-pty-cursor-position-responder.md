# Agent Note: The PTY seam answers cursor-position queries

Status: implemented

English | [中文](2026-08-20-pty-cursor-position-responder.zh.md)

## Problem

node-pty terminals are not terminal emulators: nothing on the master side answers Device Status Report queries. POSIX console stacks block interactive startup on the reply — pwsh emits `ESC[6n` during console initialization and, without an `ESC[row;colR` response, never renders its first prompt, never executes submitted input, and only the kernel echo of typeahead reaches the scrollback. ConPTY services the query internally on Windows, so the interactive-pwsh paths (terminal sessions and the persistent pwsh tool), authored and exercised against Windows, wedged on the first darwin CI run of the rc.8 suite: every send settled through silence inference with empty viewports.

## Decision

`LocalTerminalHandle` scans the PTY output stream for `ESC[6n` and answers each query on the PTY input with the canned cursor-position report `ESC[1;1R`. A bounded carry completes queries split across data chunks. The reply is terminal-emulator behavior moved into the master side; the position value is fixed because the seam renders no screen and no consumer of the true position exists. The responder stays dormant on Windows. The pwsh terminal dialect also sets `TERM=xterm-256color` instead of `dumb` so PSReadLine's interactive reader comes up; the streaming sanitizer already discards escape sequences, so the extra VT output changes nothing downstream.

## Alternatives considered

**Wait for the first native prompt before writing the bootstrap.** The wedge happens before any output, so no signal exists to wait for, and readiness semantics would diverge between dialects.

**Run pwsh non-interactively.** Prompts never render in non-interactive mode, removing the OSC `133;D;` marker that `stdin_read` readiness and prompt-text detection depend on.

**Track the real cursor position for the reply.** The seam performs no screen modeling; a fabricated position is indistinguishable to the querying console stack, which only needs a well-formed report.

## Consequences

Interactive pwsh sessions initialize and render their prompt function on POSIX, restoring marker-based `stdin_read` readiness for terminal sessions and marker-anchored extraction for the persistent pwsh tool. The bash dialect and Windows behavior are unchanged. Tests pin the responder for whole, repeated, and split queries and its rejection of other DSR codes.
