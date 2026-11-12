# 教学影像网关
全部标识与像素均为合成资料。`/studies/1/instances` 返回DICOM JSON，响应ETag代表目录版次；`/advance` 新增实例。`/bulk/<id>` 提供大字段字节，`/instances/1.1.1/frames/1,2` 返回故意与请求次序不同的两个帧。
帧通过Content-Location关联，不依赖返回次序。元数据以UI标识检查、序列及实例。查看器目前只展示一轮元数据，不下载帧或宣告检查接收完成。
