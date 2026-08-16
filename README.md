# DeepSeek Harness Desktop

English | [中文](README.zh.md)

> Community-maintained Windows desktop shell for [DeepSeek Harness](https://www.deepseek.com/harness/). This project is not an official DeepSeek desktop client.

[Download for Windows](https://github.com/shijiejintoulwh/deepseek-harness/releases) · [Desktop documentation](apps/desktop/README.md) · [Official Harness repository](https://github.com/deepseek-ai/deepseek-harness)

## Desktop experience

DeepSeek Harness Desktop packages the official open-source Harness Web application in a Windows Electron shell. The assisted installer supports a user-selected installation directory, the native title bar follows the application's light or dark theme, and closing the main window keeps Harness available from the system tray.

The Electron shell remains on the `dev-windesktop` branch while independently versioned Harness runtimes are built from `master`. The desktop application checks for signed runtime releases at startup, verifies their Ed25519 signature and SHA-256 digest, and retains the previous runtime for rollback.

## Download

Open [GitHub Releases](https://github.com/shijiejintoulwh/deepseek-harness/releases) and select the newest `desktop-v*` Windows installer. This personal MVP does not have an Authenticode identity, so Windows may display an unknown-publisher warning.

See the [Desktop reference](apps/desktop/README.md) for storage locations, lifecycle behavior, update security, build commands, and current limitations.

## Run

Harness can also run without the desktop shell.

### Run from `npm`

Install Node.js, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default.

### Run from source

To run Harness directly from this repository checkout:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## Project links

- [DeepSeek Harness website](https://www.deepseek.com/harness/)
- [Official DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Community desktop repository](https://github.com/shijiejintoulwh/deepseek-harness/tree/dev-windesktop)
- Community friend: [Linux.do](https://linux.do/)

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
