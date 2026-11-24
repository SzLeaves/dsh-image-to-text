# 变更记录

## [未发布]

### 修复

- 纯文本模型被误判成"能看图"、`ask_image` 调用被拒（`ask_image only applies to models that cannot see images`）：装配期的能力判定改用 `llm.prepareCall(...).inputModalities`，与请求构造时投影图片所用的数据源一致，也不再经过准入桥。
- 准入桥的原函数同时记在包装函数自身（`Symbol.for('@szleaves/dsh-image-to-text.admission-bridge.original')`）；卸载时若方法已被别的插件包住，保留服务上的槽位，避免 `originalResolveModelInfo` 回退到被包装的方法而读到伪造的 `image` 模态。
- 装配里 `assembly.tools` 不是数组时不再静默跳过，改为写一条 warn（内核会把该值原样交给请求构造）。
- `ask_image` 的 guard 拒绝文案带上当步路由（`provider/model`），从报错就能看出判定的是哪个模型。

## [0.2.1] - 2026-11-24

### 修复

- 配置页的两条只读路由先经宿主 `connection.requestRejection` 判权：未受信请求返回 401/403，`connection` 服务缺失时返回 503，不再无鉴权返回模型清单与决策记录。
- 工具的内核截止时间改为固定上界 `3615s`，`timeoutSeconds` 每次读图时读取；改超时不再需要重载插件。
- 配置页保存提示改为"已保存"；`bridgeAdmission` 旁注明保存后需重新加载插件才生效（该项仍在 `apply` 时读取）。
- 插件卸载时清空模块级的路由缓存与决策记录，重载后不再带出旧实例的数据。

### 变更

- `package.json` 加回 `private: true` 并保留 `publishConfig.access: "public"`（防误发）；发行方式以 GitHub 仓库和本地 tarball 为准，不依赖 npm 发布。
- 两份 README 去掉 npm 徽章，安装说明改为从 GitHub 仓库克隆，或指向本地打出的 tarball。
- 去掉 `dsh.client.immediately`：普通客户端插件不需要占用启动第一阶段。
- 声明 `dsh.manifestVersion: 1`；移除非标准的 `dsh.compatibility` 字段（验证范围改记在 README）。
- `engines.node` 由 `>=20` 提到 `>=22`（代码使用 `AbortSignal.any`，且与 DSH 实际运行环境一致）。
- `locale/*.json` 只保留宿主读取的 `meta`（标题与描述）；设置页文案以 `client.js` 的内联词典为唯一来源，不再两处维护。
- 版本号从 0.2.0 提到 0.2.1。

## [0.2.0] - 2026-11-24

### 新增

- `ask_image` 支持 `path` 参数：直接读磁盘上的图片文件（例如模型自己渲染出来的幻灯片截图），一次调用完成"读文件 → 存附件 → 读图"，不再需要先用内置 `read_image` 把图片导入会话。
- 配置项 `pathImport`（默认 `true`）：关闭后 `ask_image` 只接受会话里已有的图片。
- 新增模块 `lib/import.js`：扩展名与文件签名识别、按部署的字节/像素上限读文件、把附件服务的拒绝码翻成模型可读的句子。
- 新增测试 `test/import.test.js`（22 项），`test/tool.test.js` 补 6 项、`test/config.test.js` 补 1 项；全量 138 项。

### 变更

- `ask_image` 的描述与系统提示段补上"磁盘图片用 `path`"这条路径。
- 读文件走宿主的 `fs` 服务、存附件走 `attachments`，两者在工具执行时惰性获取，不写进插件的 `inject`；缺服务时返回一句可读错误，其它功能不受影响。

## [0.1.1] - 2026-11-23

### 新增

- 只读诊断接口 `GET /plugins/image-to-text/status`：最近 50 次系统提示装配的模型判定（agent、来源、路由、是否纯文本）。

### 修复

- 纯文本子 agent 的首次装配把模型判错（落到部署默认模型）。判定链在"请求头"与"部署默认"之间加入 `agent.options`。
- 装配判定的时机从 `next()` 之前改到之后，优先读内核写进 `assembly.variables` 的当步 `provider/model`。

## [0.1.0] - 2026-11-23

### 新增

- 准入桥：包装 `llm.resolveModelInfo`，给显式纯文本模型补上 `image`，使带图提示能通过准入进入会话。
- `ask_image` 工具：按 `sha256:` 前 8 位或 1 基序号选择会话里的图片，调用已注册的、声明支持图片输入的模型读图并返回文字；`purpose` 参数携带"这一步想知道什么"。
- 系统提示段：仅在当步模型是纯文本时填入，能看图时保持为空。
- 可见性过滤：纯文本路由保留 `ask_image`、隐藏内置 `read_image`；能看图的路由反过来；`tools.guard` 兜底拒绝切模型瞬间的残留调用。
- 配置页：`plugins.row.config`（key `dsh-image-to-text#image-to-text`），含读图模型下拉，选项来自只读接口 `GET /plugins/image-to-text/models`。
- 读图结果缓存（按会话 + 图 + 模型 + purpose + 上限 + 提示词摘要），失败与超时会话内提示，不影响会话继续。
