# cortico-world-ntfy

一个 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 格式的 World 扩展：订阅 [ntfy](https://ntfy.sh) 话题，收到通知时让桌宠告诉你。
为 [Coopet](https://github.com/wtxdew/coopet-maibot) 写的，也可以用在 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 这类 Cortico 宿主里。

## 为什么是 ntfy

个人电脑没有固定 IP，外面的服务没法直接打进来（WebHook 行不通），轮询又费资源。ntfy 是现成的推送中转：

- **发**：任何能 `curl` 的东西往 `ntfy.sh/<话题>` POST 一条消息，例如脚本、GitHub Actions、Home Assistant、另一台电脑上的 Claude Code hook：
  ```bash
  curl -d "构建完成" ntfy.sh/build_k3f9x2q8m1zawd7p
  ```
- **收**：这个扩展对 ntfy 保持**一条**长连接（和聊天软件一样，平时空着，服务器约 45 秒发一次心跳），有消息马上推下来，不轮询。
  断线自动重连，并按消息 id 补拉断线期间的消息；**离线时收到的只记进面板，不念出来**。

## 用法

在宿主的设置窗里启用「ntfy 通知」，到它的「话题与连接」面板：

1. 起一个片段名（例如 `build`），点「添加话题」。话题名是 `片段_随机码`，例如 `build_k3f9x2q8m1zawd7p`。
   **知道话题名的人都能往里发、也能订阅**，随机码就是密码：不要发密码这类敏感内容。
2. 「复制 curl」拿到发通知的命令，放进你的脚本里；「发一条测试」马上试一下。
3. 每个话题可以设去向：桌宠说 / 交给麦麦 / 不处理（Coopet 的「Coopet 怎么处理它的通知」选「规则」时生效）。
4. 「重新生成」只换随机码（旧的话题名就失效了）。

服务器默认是官方的 `https://ntfy.sh`（在「配置」里改，留空也用官方）。用自己架的服务器且开了访问控制时，在面板里填访问 token；
token 存成宿主的密钥（`NTFY_TOKEN`），不进配置文件。官方服务器匿名使用有限额（大约每天几百条），个人通知够用。

## 事件

`ntfy.message`，meta 里有 `topic`、`label`（片段）、`route`（这个话题的去向）、`title`、`message`、`priority`、`tags`、`click`。
正文是给模型看的（"请用 pet_say 简短转告用户"）；Coopet 有专门的说法（`片段：标题：内容`）。

## 开发

```bash
corepack pnpm install
corepack pnpm run build      # 面板脚本 → dist/webui.js
corepack pnpm test
corepack pnpm run typecheck
```

在 Coopet 里试：`corepack pnpm run ext add link:/path/to/cortico-world-ntfy`（Coopet 仓库里），重启 Coopet。

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
