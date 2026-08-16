# DeepSeek Harness Desktop

[English](README.md) | 中文

> 由开源社区维护的 [DeepSeek Harness](https://www.deepseek.com/harness/) Windows 桌面壳。本项目不是 DeepSeek 官方桌面客户端。

[下载 Windows 版](https://github.com/shijiejintoulwh/deepseek-harness/releases) · [桌面端文档](apps/desktop/README.md) · [Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)

## 桌面体验

DeepSeek Harness Desktop 使用 Windows Electron 壳封装官方开源的 Harness Web 应用。引导式安装器允许用户选择安装目录，原生标题栏会跟随应用的浅色或深色主题，关闭主窗口后 Harness 仍可从系统托盘访问。

Electron 壳保留在 `dev-windesktop` 分支，独立版本的 Harness 运行时从 `master` 构建。桌面应用会在启动时检查已签名的运行时 release，验证 Ed25519 签名和 SHA-256 摘要，并保留上一个运行时以供回滚。

## 下载

打开 [GitHub Releases](https://github.com/shijiejintoulwh/deepseek-harness/releases)，选择最新的 `desktop-v*` Windows 安装器。这个个人 MVP 没有 Authenticode 身份，因此 Windows 可能显示未知发布者警告。

存储位置、生命周期行为、更新安全机制、构建命令与当前限制详见[桌面端参考文档](apps/desktop/README.md)。

## 运行

Harness 也可以不通过桌面壳直接运行。

### 通过 `npm` 运行

安装 Node.js，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认在 `http://127.0.0.1:3080` 启动 Web UI。

### 从源码运行

如需从当前仓库 checkout 直接运行 Harness：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 项目链接

- [DeepSeek Harness 官方网站](https://www.deepseek.com/harness/)
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [社区桌面端仓库](https://github.com/shijiejintoulwh/deepseek-harness/tree/dev-windesktop)
- 社区友链：[Linux.do](https://linux.do/)

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
