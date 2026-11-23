# CXL-RDMA Cluster Deployment Simulator

面向多轮 LLM 推理的存量 RDMA 集群 **CXL 增量部署** 交互式可视化模拟器（纯前端 · 教学示意 · 非实测）。

一个开箱即用的静态单页应用：无需构建、无需后端、无需安装依赖，直接用浏览器打开 `index.html` 即可运行。

## 在线体验

部署到 GitHub Pages 后，访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

## 五个功能页

| 页面 | 内容 |
| --- | --- |
| 01 集群总览 | 4 机架 Leaf-Spine RDMA 拓扑、CXL 部署形态、平面/立体切换 |
| 02 机架解剖 | 42U 机柜的 2D 物理 / 网络拓扑，以及可旋转缩放的 **Three.js 三维**解剖（透明壳 / 整机 / 剖切 / 拆解 / 仅 CXL，含部件装配树与技术档案） |
| 03 KV 资源 | KV Block 分布、热度与访问画像、CXL MHD 与 RDMA 池容量 |
| 04 网络与访问 | RDMA 访问路径、链路负载与拥塞分析 |
| 05 KV 生命周期 | **KV 全生命周期**：推理生成 → 信息采集 → 存储决策 → 位置查询 → 数据访问 → 迁移复制，在三维集群中播放五类实验场景（本地热点 / 跨机架复制 / 访问主体迁移 / 网络拥塞等） |
| 06 方案对比 | 全量 RDMA / 增量 CXL / 全量 CXL 三种部署方案对比 |

> 所有容量、成本、时延与链路负载均为教学示意数据，非实测；三维模型为通用工程重构，非厂商 CAD。

## URL 参数（便于分享与演示）

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `page` | 直接打开某页 | `?page=lc` |
| `hwview` | 机架解剖默认视角 | `?page=rack&hwview=threeD` |
| `lcsc` | 生命周期页指定场景 | `?page=lc&lcsc=S3` |
| `cxl` / `units` | 指定 CXL 机架与每机架 MHD 数 | `?cxl=R1,R3&units=2` |
| `kv` | 预选中某 KV | `?page=kv&kv=KV-003` |

## 本地运行

直接用浏览器打开 `index.html`，或用任意静态服务器：

```bash
# 任选其一
npx serve .
python -m http.server 8080
```

## 发布到 GitHub Pages

1. 新建仓库并推送本项目（本仓库已用 `.gitignore` 排除全部 `_` 前缀调试文件）。
2. 仓库根目录已放置 `.nojekyll`，避免 Pages 的 Jekyll 处理下划线文件。
3. 进入 **Settings → Pages**，Source 选 `Deploy from a branch`，Branch 选 `main` / `/ (root)`，保存。
4. 等待部署完成后访问上方在线地址。

## 技术

原生 HTML/CSS/JavaScript + Three.js（`vendor/` 内置，无 CDN 依赖），几何全部程序化生成，无外部模型与贴图。零构建、零依赖。
