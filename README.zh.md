# dsh-image-to-text

<div align="center">

<p><b>让只能处理文字的模型看图片。</b><br>
纯文本对话模型调用一个 <code>ask_image</code> 工具；同一个 DSH 里已经注册、声明支持图片输入的读图模型来回答，文字作为工具结果返回。</p>

<p>
<a href="https://www.npmjs.com/package/dsh-image-to-text"><img src="https://img.shields.io/npm/v/dsh-image-to-text?style=flat-square&labelColor=1F2328&color=2DA44E&logo=npm&logoColor=white" alt="npm 版本"></a>
<a href="https://www.npmjs.com/package/dsh-image-to-text"><img src="https://img.shields.io/npm/dm/dsh-image-to-text?style=flat-square&labelColor=1F2328&logo=npm&logoColor=white" alt="npm 下载量"></a>
<a href="./LICENSE"><img src="https://img.shields.io/npm/l/dsh-image-to-text?style=flat-square&labelColor=1F2328&color=blue" alt="MIT 许可"></a>
<img src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.5%20%3C0.3.0-38BDF8?style=flat-square&labelColor=1F2328" alt="dsh >=0.2.1-rc.5 <0.3.0">
</p>

<p><a href="README.md">English</a> · <b>简体中文</b></p>

</div>

## 为什么需要它

DeepSeek Harness 允许在同一个会话里混用模型。只接受文字的模型看不见会话里的图片：准入阶段图片被拒绝，适配器把它替换成一行占位文本，模型没有任何办法知道图里有什么。

这个插件用一个工具补上这个缺口。纯文本模型在需要图片时自己决定调用 `ask_image`，并带上 `purpose`——要回答的问题、要提取的文字、要做的检查。插件把图片连同目的交给一个声明支持图片输入的模型，把它的回答以文字返回。

- **不转换、插件不发 HTTP 请求。** 图片始终留在宿主里：插件把附件引用交给 LLM 服务，由选中的读图 provider 发送。图片是否离开本机，取决于该 provider 的部署位置。
- **需要才读。** 模型不调用工具就不会读图，问题也是模型自己的 `purpose`，而不是固定的"描述这张图"。
- **只对纯文本模型生效。** 会话模型声明了 `image` 输入时，`ask_image` 消失，内置 `read_image` 回来。
- **多一次往返。** 读图是一次额外的模型调用、一次额外的工具往返，费用记在读图 provider 上。

## 环境要求

| 项 | 要求 |
|---|---|
| dsh | `>= 0.2.1-rc.5 < 0.3.0`（只在 `0.2.1-rc.5` 上验证过） |
| 宿主服务 | `llm`、`tools`、`systemPrompt`；配置页还需要 `settings` 与 `webServer` |
| 读图模型 | 模型目录里声明了 `image` 输入（`inputModalities` 包含 `image`）的模型 |

缺少 `settings` 和 `webServer` 时工具仍可用，只是没有配置页。

## 安装

在 DSH 里打开 **插件 → 添加插件**，指向本 bundle。两种 `install_bundle` 目标都可以：

- **目录**：`target` 指向本仓库的绝对路径。pnpm 会记为 `link:`，profile 的 `node_modules` 下是指向工作树的软链，适合开发期。注意下面的软链说明。
- **tarball**：在仓库里 `npm pack --pack-destination ./dist`，再把 `target` 指向生成的 `dsh-image-to-text-<版本>.tgz`。pnpm 会安装实体副本，之后移动或删除源码目录都不影响运行。长期使用推荐这种方式。

`link:` 安装时，Node 解析 `@deepseek-ai/schemastery`（本插件唯一依赖）会从包所在目录逐级往上找 `node_modules`，而 `~/.dsh/self-plugins/…` 这条路径上面没有它。要在包内建一个软链指向 profile 里已有的副本，否则插件加载失败：

```bash
mkdir -p <包目录>/node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery \
        <包目录>/node_modules/@deepseek-ai/schemastery
```

tarball 安装没有这个问题：实体副本落在 profile 的 `node_modules` 下，上一级就有 `@deepseek-ai/schemastery`。

装好或重新加载后，`ask_image` 会出现在当前模型是纯文本的会话里。

### 代码改动怎么生效

- **换了安装位置**（tarball ↔ 目录，或换路径）：模块 URL 变了，在 **Plugins** 页把这一行关掉再打开就加载新代码，不用重启。
- **原地改代码**（同一路径）：Node 按 URL 缓存模块，切行只会用旧模块重跑 `apply()`。必须重启承载 `dsh web` 的进程。
- **重新加载失败**（例如 `link:` 依赖没解析到）：插件继续跑上一次成功加载的模块，行的状态仍显示 enabled。先确认包能否独立导入：

```bash
cd <包目录> && node -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

改**配置**（含设置页保存）不用重启：`.volatile()` 字段是引用，`getConfig()` 每次读最新值。

## 配置

打开 **Plugins**，找到 `dsh-image-to-text` 一行，点 **Configure**。模型下拉来自插件自己注册的只读接口 `/plugins/image-to-text/models`，只列出声明图片输入的模型。

| 字段 | 默认值 | 作用 |
|---|---|---|
| `readerMode` | `auto` | `auto` 从模型目录自动挑读图模型；`fixed` 用 `readerProvider` / `readerModel`。 |
| `readerProvider` | 空 | `fixed` 时的 provider id，必填。 |
| `readerModel` | 空 | `fixed` 时的 model id，必填。 |
| `preferProviders` | `[]` | `auto` 时优先尝试的 provider id，按数组顺序。配置页里用英文逗号分隔。 |
| `promptTemplate` | 内置模板 | 调用方给了 `purpose` 时发给读图模型的用户消息。`{{purpose}}` 和 `{{maxChars}}` 各替换一次；留空回退内置模板。 |
| `defaultPrompt` | 内置通用提示词 | 调用方没给 `purpose` 时使用；留空回退内置提示词。 |
| `maxChars` | `8000` | 单次读图回答的字符上限。超出时截断并带 `…[truncated]` 标记；小于 1 或非法值按 `8000`，超过 `100000` 按 `100000`。上限小到放不下标记时直接硬切。 |
| `timeoutSeconds` | `180` | 单次读图调用的截止时间。小于 1 或非法值按 `180`，上限 `3600`。 |
| `bridgeAdmission` | `true` | 向提示准入声明图片支持，使纯文本模型能把图片作为占位内容收进会话。关闭后图片消息可能被直接拒绝，一般只用于排查问题。只在加载时读取，改了要重新加载插件。 |
| `pathImport` | `true` | 允许 `ask_image` 用 `path` 参数直接读磁盘上的图片文件（例如模型刚渲染的幻灯片截图）。关掉后只接受会话里已有的图片。 |
| `cacheEntries` | `200` | 进程内保留多少条读图结果；`0` 表示不缓存，上限 `5000`。 |

`settingsFrom()` 会把设置页写入的 volatile 引用当场解包，所以保存后下一次读图就用新值。缓存键包含提示词与 `maxChars`，改了这两者不会命中旧结果。

## 使用 `ask_image`

工具只有一个，参数都是可选的：

- `image`：要读哪张图。传图片占位符里 `sha256:` 后面的 8 位十六进制标签（大小写均可，也可以带 `sha256:` 前缀），或它在当前会话里的 1 基序号。省略时取最新的一张。
- `path`：图片还只是一个磁盘文件时用这个参数，传绝对路径或相对会话工作目录的路径。插件经宿主的文件服务读一次、存成附件，再交给读图模型，不需要先调内置 `read_image`。给了 `path` 就忽略 `image`。
- `purpose`：想从图里得到什么，用用户的语言写——"读出第三列""检查这张截图有没有报错"。读图模型按你的请求回答，而不是描述整张图。省略时使用 `defaultPrompt`。

`path` 读文件走宿主自己的文件服务：路径解析、访问范围、单文件字节上限都由当前部署决定（例如远端后端解析自己机器上的路径，而不是 DSH 进程所在的机器）。插件只做格式识别与附件存储；格式与大小时效由部署的图片限制决定。

返回值是读图模型的文字，首行标明这张图的 `sha256:` 标签和实际使用的 `provider/model`，例如：

```
[sha256:1a2b3c4d via provider-a/qwen-vl]
这张截图显示……
```

带模型名，是为了让你知道这次额外请求由谁完成、是否被截断。

## 只对纯文本模型生效

插件在每次组装系统提示时判断当前会话模型：

- `inputModalities` 非空且不含 `image`：判定为纯文本。保留 `ask_image`，隐藏内置 `read_image`，并把用法段落填进系统提示。
- `inputModalities` 包含 `image`：判定为能看图。隐藏 `ask_image`，段落保持为空。
- 声明缺失、为空或查询失败：按"能看图"处理，不提供 `ask_image`——没有声明的模型不假定它需要这个工具。

当前路由按"pending 选择 → 会话请求头 → 部署默认模型"的顺序取第一个可用值。同一个 `provider/model` 的判定会缓存，收到 `llm/adapters-updated` 后清空，所以切模型后下一次组装就按新路由判断。工具注册是全局的；真正的可见性由装配时的过滤和 `tools.guard` 决定，guard 只在已经判定该 agent 不是纯文本模型时拒绝 `ask_image`。

## 读图模型怎么选

`auto`：

1. 只考虑模型目录里明确声明了 `image` 的模型。
2. 按 `preferProviders` 里的 provider 顺序优先。
3. 然后优先与当前对话模型用同一个 provider 的候选。
4. 再优先 id、名称或 provider 名里带 `vl`、`vision`、`llava`、`omni` 这类视觉标记的模型。
5. 其余保持模型目录顺序。
6. 一个候选都没有时，工具返回"没有可用的读图模型"，并提示去 Plugins → Configure 设置。

`fixed`：

- `readerProvider` 和 `readerModel` 必须同时填写，否则报配置不完整。
- 模型解析失败、未注册，或明确声明为纯文本，都直接报错，不会静默降级。
- 模态未知的模型允许使用——"未知"不等于"不支持"。

`auto` 只保证挑出一个声明支持图片的模型，不保证它当前可用；一次调用失败会作为工具错误返回给对话模型，不会自动换下一个模型重试。

## 失败会怎样

读图失败只影响这一次 `ask_image` 调用，不会中断会话。对话模型会收到一段英文错误说明，可以据此重试、换图或直接向用户解释：

- 没有可用的读图模型，或 `fixed` 指向不存在的模型。
- `fixed` 指向明确只支持文字的模型。
- 读图超时或被取消。
- 读图模型返回空文本，或只返回工具调用而没有文字。
- 图片选择器没有匹配到任何图片；错误里列出当前会话可用的标签和序号。
- `path` 指向的文件不存在、不是普通文件、扩展名不受支持、内容不是图片，或超出部署的图片大小/像素限制。

主要文案由 `lib/tool.js` 统一映射；未识别的错误保留读图服务返回的原文，模型不需要理解内部错误码。

## 隐私与成本

> [!NOTE]
> 插件本身不上传任何东西：它把附件引用交给宿主 LLM 服务，由读图 provider 的适配器发送图片。图片是否离开本机取决于该 provider 的部署位置。每次读图都是一次额外的模型请求，费用记在读图 provider 上；主模型还要多花一次工具往返的 token。

- 缓存未命中时，每次读图都是一次额外的模型请求，记在读图 provider 上。除了图片，还会发送提示词模板、`purpose` 和当前会话 id 等调用参数。
- 缓存在进程内存里，键为"会话 + 图片 + 读图模型 + purpose + 上限 + 提示词摘要"。重启即失效，不跨进程、不跨会话共享。
- `maxChars` 只限制返回文字的长度，不改变发给读图模型的图片大小。

## 已知限制

- 每次读图都比直接看图多一次往返。
- 主模型可能根本不调用 `ask_image`，尤其是没有明确问题、或它认为自己已经知道答案时；插件只能靠工具描述和提示段引导。
- 工具的 `timeoutMs` 在注册时按 `timeoutSeconds * 1000 + 15000` 固定。多出的 15 秒让读图调用自己的超时先触发、返回更具体的错误。改了 `timeoutSeconds` 要重新加载插件。
- 模态声明缺失的模型按"能看图"处理，拿不到 `ask_image`；如果它其实是纯文本模型，这是声明缺失带来的限制。
- 一次只读一张图；`image` 选择器基于会话可见消息，错误提示最多列出最近 20 张的标签。
- `path` 读图依赖宿主的 `fs` 与 `attachments` 服务；两者都缺失时工具返回一句可读错误，其它功能不受影响（插件不在 `inject` 里声明它们，仍能挂在精简 profile 上）。
- 设置页的下拉只列声明图片输入的模型；模态未知的模型不会出现在列表里，但可以直接写进配置，`fixed` 模式仍会使用。

## 开发

```bash
npm test          # 等价于 node --test test/
npm run check     # node --check，只做语法自检
```

测试只用 `node:test` 和 `node:assert/strict`，不联网，也不读写 `~/.dsh`。测试文件按模块拆分：

```
test/images.test.js
test/prompt.test.js
test/config.test.js
test/route.test.js
test/reader.test.js
test/tool.test.js
test/visibility.test.js
test/bridge.test.js
test/apply.test.js
test/import.test.js
```

仓库根目录 `node_modules/@deepseek-ai/` 下的 `schemastery` 和 `cosmokit` 软链，只是为了本地跑测试时能解析 `@deepseek-ai/schemastery`。它们不是随包发布的运行时依赖（运行时由宿主提供），被 `.gitignore` 忽略，换机器后按需重建：

```bash
mkdir -p node_modules/@deepseek-ai
ln -s <dsh 安装目录>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -s <dsh 安装目录>/node_modules/@deepseek-ai/cosmokit   node_modules/@deepseek-ai/cosmokit
```

改完代码要同步到本地安装副本时，用 `npm run sync:profile`（默认目标 `~/.dsh/self-plugins/dsh-image-to-text`，可用 `DSH_IMAGE_TO_TEXT_TARGET` 覆盖）。脚本只负责拷文件与自查，不负责重启。

## 卸载

在 **Plugins** 里停用或移除即可。插件不在包外保存任何数据，没有别的需要清理。

## 许可

MIT © 2026 Szleaves。见 [LICENSE](LICENSE)。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。
