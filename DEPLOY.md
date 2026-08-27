# 聚会狼人杀（联网版）· 免费云端部署指南

适用场景：**外出聚会、没有 WiFi、大家用手机流量联网玩**，不想带电脑。
本服务是 Node + SSE 实时推送（房间数据在内存里），必须部署到一个"常驻运行"的 Node 平台，
不能用纯静态托管（GitHub Pages / Vercel / Netlify 不行）。

已就绪：
- `server.js` 已读取 `process.env.PORT`、绑定 `0.0.0.0`
- 已有 `package.json`（`npm start` = `node server.js`）
- 已有 `render.yaml`（Render 一键蓝图）

---

## 方案 A：Render（推荐，免费、无需绑卡）
1. 把本文件夹推送到一个 **GitHub 公开仓库**（没有账号先注册 github.com）。
   ```bash
   cd 聚会狼人杀联网版
   git init && git add . && git commit -m "party werewolf"
   # 在 GitHub 网页新建仓库后，按提示 git remote add origin <仓库地址> && git push -u origin main
   ```
2. 打开 https://render.com ，用 GitHub 登录（免费）。
3. 点 **New → Blueprint**，选中你的仓库，Render 会自动读取 `render.yaml`。
4. 确认 `plan: free`、`startCommand: node server.js`，点 **Apply**。
   - 大约 1–2 分钟部署完成，得到一个 `https://party-werewolf-xxxx.onrender.com` 公网地址。
5. 所有人手机浏览器打开这个地址即可建房 / 加入，用手机流量也能连。

注意：
- 免费版在**空闲 15 分钟后会休眠**，首次有人访问有约 30–50 秒冷启动；聚会进行中一直有人访问则不会睡。
- 服务偶尔重启会清空房间（内存数据），单场聚会内基本无影响；如需持久化可后续加数据库。

---

## 方案 B：Koyeb（免费、常驻不休眠，备选）
1. 同样先把代码推到 GitHub。
2. 打开 https://koyeb.com ，GitHub 登录。
3. **Create App → GitHub → 选仓库**，Builder 选 **Node.js**，Run command 填 `node server.js`。
4. 部署完成后得到 `https://<app>.koyeb.app` 公网地址。

---

## 国内手机流量延迟说明
Render / Koyeb 服务器在海外，国内手机访问延迟约 200–400ms（回合制游戏完全够用，SSE 已带 25 秒心跳保活）。
若想要国内最低延迟，最稳的是买一台轻量云（腾讯云/阿里云 Lighthouse，约几元/月）或把本项目搬到国内 Serverless，
但那需要付费或更多改造。免费方案里 Render/Koyeb 是性价比最高的选择。

---

## 本地自测（开发用，非部署）
```bash
node server.js          # 默认 http://localhost:3000
```
同一 WiFi 下手机访问电脑局域网 IP:3000 也能玩（无需公网）。
