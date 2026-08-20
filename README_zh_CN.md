# Web Openworld

一个使用 Three.js 与 Cloudflare Durable Objects 构建的多人共享破坏世界。

在线地址：https://gitrnhub.github.io/Web-Openworld/

## 当前版本

- 三层安全屋：参考流水别墅的横向悬挑、中央石材核心、转角玻璃和贴合场地的层叠露台，但场景为原创低多边形设计，并非复刻。
- 一楼是大厅和出生点，二楼是起居区，三楼是休息区与观景台；建筑主体和周边地形都可破坏。
- 本地破坏立即生效，每约 2.5 秒批量同步一次。Cloudflare SQLite Durable Object 先持久化，再广播给其他在线玩家；退出后重新进入会重放已保存的破坏记录。
- 世界采用确定性无限区块：围绕玩家无缝加载、回收远处区块，并使用三级 LOD、边缘裙边、距离雾和视距限制。
- 安全屋附近是较低的岩台与溪谷，中距离才逐渐抬高，远处采用固定种子的随机起伏，不会一出门就撞上山体。
- 离开安全屋后自动隐藏室内家具，距离更远时隐藏场地装饰，以减少绘制和更新成本。

## 操作

- `W A S D`：移动
- `Shift`：加速
- `Space`：跳跃
- 鼠标：观察
- 鼠标滚轮：切换弹体
- 左键 / 按住左键：发射
- `1 / 2 / 3`：切换安全屋楼层
- `H`：显示或隐藏帮助
- `Esc`：释放鼠标

## 数据流

```text
GitHub Pages 静态网页
        |
        | HTTPS + WebSocket
        v
Cloudflare Worker
        |
        | 每个世界 ID 对应一个对象
        v
SQLite Durable Object
```

客户端进入时分页读取历史事件，随后建立可休眠 WebSocket。每个事件都有稳定 ID，可安全重试；Durable Object 完成数据库提交后才向其他客户端广播。

## 本地开发与部署

```bash
pnpm install
pnpm run check
pnpm run dev
```

另行把 `public/` 托管在 `http://127.0.0.1:4173`。本地页面默认连接 `http://127.0.0.1:8787`，也可以使用 `?api=https://example.workers.dev` 临时指定后端。

Cloudflare 部署步骤：

1. 执行 `pnpm wrangler login`，然后执行 `pnpm run deploy`。
2. 如果换用其他 Worker 名称或账户，再更新 `public/src/config.js` 中的 `PRODUCTION_API_BASE`。
3. GitHub Pages 选择 **GitHub Actions** 作为来源；工作流会直接发布 `public/`。

当前共享世界是匿名公共写入模型，并通过精确 CORS 来源、载荷上限和事件校验缩小风险。若公开运营，还应增加登录、限流、管理工具、定期快照和事件压缩。

设计参考：[Fallingwater — Designing Fallingwater](https://fallingwater.org/history/the-kaufmanns-fallingwater/designing-fallingwater/)。
