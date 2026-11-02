# 第三方来源与授权说明

## 界面参考

视觉设计参考 https://github.com/mikufoxxx/Wenku8_Flutter 。借鉴范围为奶白玻璃、悬浮底栏和立体书架的设计方向；本仓库不是原项目的官方版本，也未复制 Flutter／Dart 小说功能代码。

## Mangabz 图源脚本

上游：https://github.com/YHQY-Dev/venera-sources/blob/main/mangabz.js 。

`vendor/mangabz.js` 为本地修改版本；`prepare_source.py` 据此生成适用于本项目的 `assets/source.js`。本地修改涉及网页选择器、探索／排行榜、更新时间和数据解析。保留上游作者对其代码的权利和来源说明。

发布准备时，上游仓库未找到明确的 LICENSE 文件。本仓库不会替上游授予额外授权；修改、再分发或商用第三方部分前，请自行向原作者确认适用授权。README 中欢迎 Fork 自行优化的表述不替代第三方授权。

## 图标与在线内容

应用图标依据用户提供的参考图进行 AI 重绘；原始参考图作者未确认。`artwork/icon-master.png`、导出的应用图标与提示词一并提供，不宣称对原角色及原画拥有专有权利。

漫画书目、封面、章节和图片来自 https://www.mangabz.com/ ，相关内容归原作者及其他权利人所有。`checks/` 内的网页和数据样本用于解析回归检查，不代表内容授权；安装包不附带这些测试网页或漫画图片。
