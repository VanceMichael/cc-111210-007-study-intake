# 教学影像网关（本地演练来源）

全部标识、大字段与帧字节均为合成资料，服务只绑定回环地址。

## 目录与版次

- `GET /studies/1/instances` 返回 DICOM JSON 数组，响应 `ETag` 代表目录版次（`"study-1"`、`"study-2"` …）。
- `GET /studies/1/instances?external=1` 时，像素元素的 `BulkDataURI` 返回绝对外域地址，用于演练授权清单；默认返回同源相对地址。
- `GET /advance` 使目录新增实例 `1.1.2`（含一个额外的非像素 `BulkDataURI`），版次递增。
- `GET /stats` 查看目录、大字段、分帧的请求计数与当前故障注入；`POST /stats/reset` 清零计数。

## 大字段

- `GET /bulk/<id>` 返回 `application/octet-stream` 字节与 `ETag`。
- `POST /flaky?key=bulk:/bulk/<id>` 切换该资源的 500 故障，用于演示未完成清单与单资源重取。

## 分帧（multipart/related）

- `GET /instances/<实例UID>/frames/<逗号分隔帧号>` 返回 multipart 内容，part 次序故意与请求次序不同；
  关联只看每个 part 的 `Content-Location`（…/frames/<帧号>）与 `Content-ID`，不能依赖返回次序。
- 每个 part 的 `Content-Type` 带 `transfer-syntax` 参数。请求 `Accept` 中给出
  `transfer-syntax=1.2.840.10008.1.2.5` 时返回 RLE 表示，否则返回显式 VR 小端（`1.2.840.10008.1.2.1`）。
  不同传输表示是同帧的不同资源，必须分别核对、分别存储。
- `POST /flaky?key=frame:<实例>:<帧|all>:<传输语法UID>` 切换分帧 500 故障。

## 重定向

- `GET /redirect-to-bulk?target=...` 返回 302，用于演练重定向逐跳授权与凭据不跨域跟随。

接入端必须核对 part 数量、`Content-ID` 唯一性、实际媒体类型与传输语法、帧号与请求集合的对应关系；
任一项不符即拒绝整批响应并退化为逐帧领取。查看器只展示一轮元数据，不下载帧也不宣告检查接收完成；
接收封口由接入服务按“目录版次稳定 + 资源全部完整”的判定负责。
