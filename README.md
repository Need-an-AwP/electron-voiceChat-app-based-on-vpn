## 基于虚拟局域网的语音聊天软件

在zerotier或tailscale提供的虚拟局域网基础上建立的无中心语音连接。

目前仅使用tailscale网络连接客户端，计划添加获取指定进程音频以及屏幕共享功能

（tailscale目前的网络状况较差）
计划同时使用zerotier和tailscale网络

采用分布式信令服务
前端页面由纯js构建
（用户界面依然非常原始）

使用的神经网络降噪在客户端上处理本地的麦克风音频输入，默认开启
模型来自https://jmvalin.ca/demo/rnnoise/