# 本地三维渲染依赖

- 组件：CesiumJS 1.147.0，固定版本。
- 来源：官方 npm 包 `https://registry.npmjs.org/cesium/-/cesium-1.147.0.tgz` 的 `Build/Cesium/` 浏览器构建。
- 用途：前端局部平面三维态势显示。模型、脚本、Workers、图片与字体全部由当前项目服务提供。
- 许可证：Apache 2.0，见 `cesium/LICENSE.md`；第三方资源清单见 `cesium/ThirdParty.json` 和 `cesium/ThirdParty.extra.json`，相关许可在发行资源中保留。
- 此版本不使用 Cesium ion、外部地形、在线地图或在线模型，不需要添加地图服务 token。

升级时一起更换完整浏览器构建，保证 `Cesium.js` 与 `Workers/Assets/ThirdParty/Widgets` 版本一致。
