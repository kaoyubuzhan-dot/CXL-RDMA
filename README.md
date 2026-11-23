# CXL-RDMA Cluster Deployment Simulator

面向多轮 LLM 推理的存量 RDMA 集群 **CXL 增量部署** 交互式可视化模拟器（纯前端 · 教学示意 · 非实测）。

一个开箱即用的静态单页应用：无需构建、无需后端、无需安装依赖，直接用浏览器打开 `index.html` 即可运行。

## 在线体验

### 👉 https://kaoyubuzhan-dot.github.io/CXL-RDMA/

由 GitHub Pages 从 `main` 分支根目录直接发布，零构建。首次打开若返回 404，说明 Pages 仍在构建中（约 1～3 分钟），稍后刷新即可。

常用直达链接（可直接发给别人）：

| 演示场景 | 链接 |
| --- | --- |
| 首页 · 集群总览 | https://kaoyubuzhan-dot.github.io/CXL-RDMA/ |
| 机架解剖 · 三维 | https://kaoyubuzhan-dot.github.io/CXL-RDMA/?page=rack&hwview=threeD |
| KV 生命周期 · 跨机架共享热点 | https://kaoyubuzhan-dot.github.io/CXL-RDMA/?page=lc&lcsc=S3 |
| 网络与访问 | https://kaoyubuzhan-dot.github.io/CXL-RDMA/?page=traffic |
| 方案对比 | https://kaoyubuzhan-dot.github.io/CXL-RDMA/?page=compare |

## 七个功能页

| 页面 | 内容 |
| --- | --- |
| 01 运行流程 | **主入口**：七阶段生命周期（推理生成 → 信息采集 → 存储决策 → 位置查询 → 数据访问 → 迁移复制 → 淘汰回收），每阶段都有专属动画、数据方块与「动作 / 对象 / 原因 / 结果」说明 |
| 02 集群总览 | 4 机架 Leaf-Spine RDMA 拓扑、CXL 部署形态、平面/立体切换 |
| 03 机架解剖 | 42U 机柜的 2D 物理 / 网络拓扑，以及可旋转缩放的 **Three.js 三维**解剖（透明壳 / 整机 / 剖切 / 拆解 / 仅 CXL，含部件装配树与技术档案） |
| 04 KV 资源 | KV Block 分布、热度与访问画像、CXL MHD 与 RDMA 池容量 |
| 05 网络与访问 | RDMA 访问路径、链路负载与拥塞分析 |
| 06 三维生命周期 | 三维集群中的 KV 生命周期场景演示（S1–S6） |
| 07 方案对比 | 全量 RDMA / 增量 CXL / 全量 CXL 三种部署方案对比 |

> 所有容量、成本、时延与链路负载均为教学示意数据，非实测；三维模型为通用工程重构，非厂商 CAD。

## URL 参数（便于分享与演示）

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `page` | 直接打开某页 | `?page=lc` |
| `hwview` | 机架解剖默认视角 | `?page=rack&hwview=threeD` |
| `lcsc` | 生命周期页指定场景 | `?page=lc&lcsc=S3` |
| `cxl` / `units` | 指定 CXL 机架与每机架 MHD 数 | `?cxl=R1,R3&units=2` |
| `kv` | 预选中某 KV | `?page=kv&kv=KV-003` |
| `stage` | 运行流程页直接跳到某阶段（编号或 id） | `?stage=access` · `?stage=5` |
| `flowsc` | 运行流程页指定场景 | `?stage=decide&flowsc=S3` |

## 本地运行

直接用浏览器打开 `index.html`，或用任意静态服务器：

```bash
# 任选其一
npx serve .
python -m http.server 8080
```

## 发布到 GitHub Pages（已配置）

站点以 `main` 分支根目录发布（Deploy from a branch → `main` / `/ (root)`），仓库根目录的 `.nojekyll` 关闭 Jekyll 处理，避免下划线开头的资源被忽略。所有资源均为相对路径（`./styles.css`、`./vendor/three.min.js`），因此在 `/CXL-RDMA/` 子路径下可直接加载。

首次配置备忘：

1. 仓库 **Settings → Pages**，Source 选 `Deploy from a branch`。
2. Branch 选 `main`，Folder 选 `/ (root)`，Save。
3. 在 **Actions** 页等 `pages build and deployment` 跑完，再访问上方在线地址。

### 更新站点

```bash
git add -A
git commit -m "更新说明"
git push
```

推送后 Pages 会自动重新构建，约 1～2 分钟生效；若仍是旧页面，按 `Ctrl+F5` 硬刷新或开无痕窗口。

## 技术

原生 HTML/CSS/JavaScript + Three.js（`vendor/` 内置，无 CDN 依赖），几何全部程序化生成，无外部模型与贴图。零构建、零依赖。
