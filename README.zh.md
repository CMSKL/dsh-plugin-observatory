# dsh-plugin-observatory

[English](README.md) | 中文

这是一个用于 DSH 插件安装前检查，以及插件挂载后 Loader 生命周期观测的独立 bundle。

它面向 DSH 插件作者、维护者和工具开发者，帮助你在激活插件前快速判断本地包是否声明了正确的 bundle、运行时依赖和宿主版本范围，补丁会插入哪些 bundle 行，以及当前进程里发生过哪些 Loader 转换。

本包提供两个只读工具：

- `plugin_audit` 检查本地包的 `package.json` 与其中声明的 `dsh.bundle.patch`。检查项包括 manifest（元数据清单）完整性、DSH／Cordis／Node 版本范围、运行时依赖声明、安装生命周期脚本、补丁行、重复 id、路径约束，以及尚未求值的 `!!js` 表达式。
- `plugin_observe` 投影当前非 group Loader 条目，以及本插件激活后观测到的有界根 fiber 转换历史。

`plugin_audit` 返回确定性的机器可读 JSON 报告，结论为 `compatible`、`needs-review` 或 `incompatible`。它只读取包元数据和声明的补丁，不会导入目标 JavaScript，也不会求值补丁表达式，因此可以用于安装前兼容性判断。`plugin_observe` 只保留有界的进程内状态和转换历史，不会替代 Loader 的当前状态。

## 快速上手

把稳定版 bundle 安装到 DSH profile：

```sh
dsh plugin --profile demo add dsh-plugin-observatory@0.1.0
```

在运行中的 profile 里，让模型审计一个本地插件：

```text
请使用 plugin_audit 检查 /path/to/my-plugin，并返回 verdict、issues 和插入的 bundle 条目。
```

也可以在从本仓库根目录运行的 profile 中，把 `package_path` 设为 `.` 来审计当前 checkout。结果是 JSON 报告。本仓库的一次代表性结果如下：

```json
{
  "verdict": "needs-review",
  "issues": [
    {
      "severity": "warning",
      "code": "lifecycle-script",
      "path": "package.json#scripts.prepare"
    }
  ],
  "bundle": {
    "insertedEntries": [
      { "id": "observatory", "moduleName": "dsh-plugin-observatory" },
      { "id": "observatory-invariant", "moduleName": "dsh-plugin-observatory/invariant" }
    ]
  }
}
```

本仓库出现 `needs-review` 是因为源码包在常见安装流程中会通过 `prepare` 构建 TypeScript。这是需要人工查看的提示，不代表 bundle 不兼容。版本范围兼容且没有复核项的插件可以返回 `compatible`。如果要查看当前运行时状态，可以让模型使用 `plugin_observe`，列出非 group Loader 条目和保留的转换历史。

如果这个工具帮你在插件激活前发现了问题，欢迎给[项目点一个 Star](https://github.com/CMSKL/dsh-plugin-observatory)，方便之后找到兼容性更新。

本包位于 DeepSeek Harness 官方仓库之外，通过公开的 bundle、Cordis 服务、Loader 事件和工具注册接口接入 Harness。它的 `dsh.bundle` 补丁把 `PluginObservatoryService` 挂载到 `ctx.pluginObservatory`，并挂载本包拥有的 invariant companion。

报告不含时间戳，检查项按确定顺序排列，并且不会导入目标 JavaScript 或求值 bundle 表达式。包文件与补丁的读取都有字节上限，要求有效 UTF-8，会解析符号链接，并且必须留在允许的根目录中。解析后的 patch 图还受嵌套深度和对象／数组访问次数限制；循环 YAML alias 会返回不兼容报告，而不会耗尽递归栈。

`PluginObservatoryService.audit(packagePath, cwd, signal?)` 向受信插件暴露同一套静态审计。服务在激活时只采集一次宿主包版本：能够解析 DSH CLI 包时以它为准，否则使用当前 DSH 发行族中一致的核心包版本；版本不可用或相互冲突时会产生明确的人工复核警告。`snapshot(entryId?)` 返回分离的调用时点生命周期报告，`assertObservedTransition(...)` 支持 invariant companion。Loader 仍是当前状态的权威；Observatory 只拥有有界、进程本地的转换历史。

`0.1.0` 是首个稳定版本，通过 npm 的 `latest` dist-tag 发布。后续候选版本仍只进入 `next`，不带版本限定的安装只会解析到稳定版本。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `allowedRoots` | 直接挂载时为 `[process.cwd()]`；随包配置使用工作目录与 DSH profile 根目录 | 包目录必须解析到其中一个规范根目录之下。 |
| `maxManifestBytes` | `262144` | 从 `package.json` 读取的最大 UTF-8 字节数；允许配置的最大值为 32 MiB。 |
| `maxPatchBytes` | `1048576` | 从所声明 bundle 补丁读取的最大 UTF-8 字节数；允许配置的最大值为 32 MiB。 |
| `maxPatchDepth` | `64` | 解析后 patch 对象／数组的最大嵌套深度；允许配置的最大值为 256。 |
| `maxPatchNodes` | `10000` | 对象／数组的最大访问次数，重复 alias 展开也计入；允许配置的最大值为 100,000。 |
| `maxObservedEntries` | `256` | 内存中最多保留的 Loader 条目历史数。 |
| `maxTransitionsPerEntry` | `64` | 每个 Loader 条目最多保留的最近转换数。 |

## 安装细节

把当前 npm 稳定版本安装到 DSH profile：

```sh
dsh plugin --profile demo add dsh-plugin-observatory
```

需要可复现安装时，固定精确版本：

```sh
dsh plugin --profile demo add dsh-plugin-observatory@0.1.0
```

也可以从 [v0.1.0 GitHub Release](https://github.com/CMSKL/dsh-plugin-observatory/releases/tag/v0.1.0) 下载 tarball 和 checksum，校验后安装：

```sh
shasum -a 256 -c dsh-plugin-observatory-0.1.0.tgz.sha256
dsh plugin --profile demo add ./dsh-plugin-observatory-0.1.0.tgz
```

配置输出中应出现来自 `cordis.patch.yml` 的 `observatory` 与 `observatory-invariant` 两行：

```sh
dsh --profile demo --dump-config
```

即使 profile 没有提供 `ctx.invariants`，invariant companion 也会先正常激活；它会在内部等待，并在该服务稍后出现时自动完成注册。因此，缺少这个可选 registry 不会阻塞 profile 激活门禁或 Observatory 的两个工具。

确认组合结果后，再按正常方式启动对应 profile。卸载命令为 `dsh plugin --profile demo remove dsh-plugin-observatory`。

## 从本地 checkout 安装

先构建独立仓库，再把它添加到 DSH profile：

```sh
pnpm install
pnpm run check
dsh plugin --profile demo add .
dsh --profile demo --dump-config
```

直接从 Git checkout 安装时，pnpm 需要获得构建授权，因为源码包使用 `prepare` 编译 TypeScript。npm 包和 GitHub Release 附带的 tarball 都包含预构建的 `lib/`，不需要源码构建授权。

产品单元就是这个独立插件包。未来的 CLI（命令行界面）、CI 报告器或 Web 视图应作为 `ctx.pluginObservatory` 的轻量消费方，而不是第二套兼容性引擎。

## 开发

```sh
pnpm install
pnpm run check
pnpm run test:coverage
pnpm run publint
pnpm run test:e2e
pnpm pack --dry-run
```

运行时 DSH 与 Cordis 包均为 peer dependency；开发阶段使用它们已发布的版本，不会通过 workspace 链接回官方 Harness 仓库。

必过兼容矩阵在 Node `22.19.0` 和 Node `24` 上验证 DSH `0.1.0-rc.6`。E2E 测试会把精确 release tarball 或固定 registry 版本安装到隔离的临时 DSH profile，检查实际包名和版本、两条 bundle 配置、两个包导出，并真实启动 profile 通过激活门禁，随后卸载并清理，不会触碰用户 profile。CI 还会通过每周定时和手动触发任务探测最新发布的 DSH 版本。

## 模型体验

### 插件审计与生命周期观测

#### 模型会看到什么

挂载本 bundle 后，模型会看到生成的 `plugin_audit` 与 `plugin_observe` schema。成功的审计结果是描述兼容性检查项与所提取 bundle 事实的确定性 JSON。观测结果包含当前 Loader 状态、采集时间与有界转换时间戳；两个工具都不提供独立的系统提示词段落。

#### token 影响

只要工具可见，两个固定 schema 就会在每次请求中重复。结果依数据而定，每次工具调用追加一次；审计大小受 manifest 与补丁上限约束，观测大小受条目数与转换数上限约束。

#### KV Cache 影响

只要本插件的可见性与 schema 文本不变，schema 前缀就可复用。挂载或移除插件会改变工具 schema 前缀；每个结果则追加在可复用的会话前缀之后。

## 已知限制与暂缓事项

- **仅限本地源码** —— 审计输入是已有的本地包目录；npm registry、GitHub、压缩包下载、签名验证和依赖安装不属于本包职责。
- **静态兼容性不等于执行安全** —— 它不会安装或导入目标包、运行冒烟任务、检查传递依赖内容，也不能证明任意插件代码是安全的。
- **宿主版本推导是显式的** —— DSH 版本检查使用 CLI 包或当前发行族中一致的核心包。两者都不可用或版本冲突时，报告会进入 `needs-review`，不会静默宣称兼容。
- **生命周期脚本需要结合来源判断** —— 任何安装生命周期脚本都会产生复核项，因此本包审计自身时会把 `prepare` 构建标记为 `lifecycle-script`；该结果描述的是元数据，并不表示脚本已经执行。
- **进程本地观测** —— 生命周期历史从 Observatory 激活时开始，刻意保持有界，在进程退出时消失；目前还不能把工具延迟、token 用量或失败归因到所属插件。
- **评测是下一层** —— 可复现任务集、基线对比、评分卡、持久化运行产物、CI 策略和 Web 仪表盘仍是本插件服务上暂缓的消费方。
