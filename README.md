# 县域影像交流的检查资料采集

本项目用于授权教学资料的目录查看与**按检查完整接收**，使用 Node.js 22，全部数据为去标识合成样本，不做诊断或像素分析。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build   # 语法检查
npm test        # 26 项单元/集成测试
npm run demo    # 端到端演练：封口、目录新增、乱序帧、传输表示变化、单资源重取
npm start       # 常驻服务，默认端口 3000
```

`npm run demo` 启动本地来源和接入服务，完整演示一轮接收并写入临时目录，随后关闭服务并清理。`npm start` 默认端口 3000，可通过 `PORT`、`DATA_DIR` 修改；`SOURCE_URL` 连接另一进程的本地来源，不设置时自动创建演练来源。恢复演练可先用 `npm run source` 启动来源，再以 `SOURCE_URL` 重启接入服务。

## 按检查接收的接口

| 接口 | 说明 |
| --- | --- |
| `GET /intake/poll?study=1` | 执行一轮目录轮询与资源对账，返回作业状态 |
| `GET /intake/run?study=1&maxRounds=10` | 连续轮询直到封口或达到最大轮数 |
| `GET /intake/job?study=1` | 读取持久化作业（版次历史、未完成清单），无作业返回 404 |
| `GET /intake/published?study=1` | 读取已封口发布的分层清单；未封口返回 409，讨论区不可见 |
| `GET /intake/published-list` | 已发布检查列表 |
| `GET /intake/resource?...` | 仅回送**已发布检查**内的资源字节，路径由分层 UID 约束，不接受任意 URL |

兼容接口保留：`GET /health`、`GET /inspect`、`GET /receive?key=sample`、`GET /receipts/sample`。

## 接收判定与留存规则

- **分层标识**：目录按 `检查 UID / 序列 UID / 实例 UID` 落盘；`BulkDataURI` 大字段与分帧资源都归属各自实例。分帧再按**传输语法 UID** 分目录，不同传输表示互不混淆。
- **封口判定**：首轮只登记不封口；目录 `ETag` 连续 `STABLE_ROUNDS`（默认 2）轮不变、且无未完成资源时才封口。目录在接收期间新增实例会使版次变化、稳定计数清零并回到 `open`，记录版次差异（新增/移除）与未完成清单。
- **复用与重取**：每个资源带独立回执（字节 SHA-256、媒体类型、传输语法、来源 URI、ETag）。完好资源跨作业复用、不再请求网关；本地摘要校验失败只重取该资源。分帧先批量领取，整批核对失败则拆成单帧逐个核对重取。
- **版本可见性**：只有完整封口的一版检查写入 `published/` 对讨论区可见；同版次同内容不重复发布，目录或资源变化才产生新版本，清单摘要只由稳定字段计算。
- **multipart 核对**：part 数量、`Content-ID` 唯一性、实际媒体类型与 `transfer-syntax`、`Content-Location` 帧号与请求帧号集合必须全部一致；乱序返回按 `Content-Location` 归位。

## 外域授权与凭据边界

- 回环地址与来源同源默认可访问；其他外域必须列入 `ALLOWED_ORIGINS`（逗号分隔），否则拒绝连接，接口不提供任意目标代理。
- 凭据由部署配置给出：`SOURCE_TOKEN`（来源 Bearer 令牌）、`ALLOWED_TOKENS=来源|令牌,...`。`Authorization` 只发给配置了凭据的授权来源；重定向手动逐跳跟随，跨域重定向不携带原凭据并重新做授权判定。
- 仅允许 `http/https`，演练客户端拒绝回环以外且未授权的地址。

## 模块

- `src/multipart.mjs`：二进制安全的 multipart/related 解析与分帧核对
- `src/policy.mjs`：授权清单、凭据隔离与逐跳重定向
- `src/dweb.mjs`：DICOMweb 客户端（目录、大字段、分帧）
- `src/intake.mjs`：接收编排（封口、版次差异、未完成清单、复用、单资源重取）
- `src/intake-store.mjs`：分层落盘、资源回执、作业与发布清单
- `src/service.mjs` / `src/main.mjs`：HTTP 入口与部署配置
- `src/connector.mjs`：兼容的单次 DICOM JSON 查看；`fixtures/source.mjs`：可重复启动的本地来源

## 存储布局（DATA_DIR）

```
studies/<检查>/<序列>/<实例>/bulk/<标签>.bin(+.receipt.json)
studies/<检查>/<序列>/<实例>/frames/<传输语法>/frame-<帧号>.bin(+.receipt.json)
jobs/<检查>.json            # 作业状态、版次历史、未完成清单
published/<检查>.json       # 仅封口后的完整分层清单（讨论区可见）
```

生产接入地址与凭据需由部署配置给出。异常以明确错误响应返回，接收失败不覆盖已发布版本。
