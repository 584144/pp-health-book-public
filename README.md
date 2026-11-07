# PP's 健康簿 · 家庭健康中枢

> 不是记录健康，而是读懂健康。

一个给自己和家人用的私有健康看板：把散落在体检报告、医院系统、各种 App 和手表里的健康信息汇到一处，**按每个人自己的基线**持续读懂这些数据，再把结论变成「今天最值得做的事」。每天只需要和 AI 说一次今天的生活，其余全部自动同步。

![今日](docs/screenshots/01-today.png)

<p>
<img src="docs/screenshots/phone-today.png" width="24%"> <img src="docs/screenshots/phone-sleep.png" width="24%"> <img src="docs/screenshots/phone-women.png" width="24%"> <img src="docs/screenshots/phone-body.png" width="24%">
</p>

> 所有截图都来自 `scripts/make_demo_data.py` 生成的**虚构家庭**（林小禾一家），人名和数值都是编的。

**English summary.** A self-hosted family health dashboard. It merges checkup reports, prescriptions, Apple Watch / Apple Health data (heart rate, HRV, sleep, cycles), smart-scale readings and a once-a-day natural-language check-in into one place, compares every metric with the person's *own* baseline, and turns that into at most three concrete actions for today. Single-file front end, zero-dependency Node.js server, JSON file storage. Not a medical device and not medical advice.

---

## 解决什么问题

- 一家人的健康信息**分散**：纸质报告、医院小程序、手表 App、体脂秤 App、聊天记录里的处方照片，各自孤立，没人能连起来看。
- 往往**等到生病才去翻**，翻也翻不全；复查时间、上次的结果、在吃什么药都靠记忆。
- 通用参考范围只能告诉你「正常 / 异常」，看不出「这几天不像平时的你」。
- 记录太累：逐餐打卡、拍照识别、填表单，坚持不了几天。

## 核心思路：三层框架

| 层 | 做什么 | 例子 |
|---|---|---|
| **数据层** | 不同医院、单位、设备的数据归到同一套标准里；一份数据只存一处，多处引用 | 同一指标的不同叫法归并（「谷丙转氨酶」=「ALT」），单位自动换算并保留原值和原报告参考范围；手表和口述的同一场运动去重；体脂秤离群读数自动剔除 |
| **分析层** | 以**每个人自身基线**为准找异常、趋势和关联 | HRV、静息心率和自己近 28 天比；连续 3 次偏离才提醒；睡眠 × 次日 HRV、睡眠 × 月经周期等交叉分析，标明样本量 |
| **建议层** | 把分析变成可执行的下一步 | 今天训练要不要减量、复查什么时候到、下次体检该查什么、乳腺 B 超哪天去做最准 |

## 板块

```text
PP's 健康簿
├── 今日              今日记录（每天一次对话整理）+ 今天最值得做的事（最多 3 条）
├── 生活方式           只对本人开放，家人默认隐藏
│   ├── 护肤美容       皮肤状态 · 日常护肤 · 功效护理（刷酸 / A 醇怎么开始）· 医美项目 · 产品库
│   ├── 运动健身       运动概览 · 训练计划 · 训练记录 · 身体成分
│   ├── 营养饮食       每日饮食 · 食物 + 补剂 + 合计的营养分析 · 常吃食物库 · 每周复盘
│   └── 睡眠恢复       睡眠概览 · 身体恢复 · 交叉分析 · 个人睡眠洞察
├── 健康趋势           7/30/90 天趋势 · 目标进度 · 周报 · 任意两项指标的关联
├── 女性健康           周期阶段与建议 · 身体数据随周期的变化 · 周期症状 · 周期记录与预测
├── 医疗总档案         人体图谱 · 检查指标（含异常、指标字典）· 检查报告 · 就诊记录 · 用药管理（处方 / 补充）
└── 体检计划           复查提醒 · 下次体检清单（按年龄、病史、家族史生成）· 已完成
头像菜单               个人档案 · 家庭成员与权限 · 数据同步 · 导出数据 · 外观风格
```

| | |
|---|---|
| ![护肤美容](docs/screenshots/02-skin.png) | ![运动健身](docs/screenshots/03-fitness.png) |
| ![营养饮食](docs/screenshots/04-nutrition.png) | ![睡眠概览](docs/screenshots/05-sleep-overview.png) |
| ![身体恢复](docs/screenshots/06-sleep-recovery.png) | ![交叉分析](docs/screenshots/07-sleep-cross.png) |
| ![个人睡眠洞察](docs/screenshots/08-sleep-insights.png) | ![健康趋势](docs/screenshots/09-trends.png) |
| ![女性健康](docs/screenshots/10-women.png) | ![人体图谱](docs/screenshots/11-medical-map.png) |
| ![用药管理](docs/screenshots/12-medical-meds.png) | ![体检计划](docs/screenshots/13-plans.png) |

## 每天一次对话

用户在聊天里随口说一段，比如：

> 早餐还是平时的燕麦牛奶杯和鸡蛋；午餐牛肉饭，晚餐三文鱼和青菜；晚上打了一个半小时网球，有点累；下巴冒了两颗痘；鱼油和 D3 都吃了；下午喝了杯拿铁。

AI 把它整理成一条结构化的「当天记录」，通过 `POST /api/checkin` 写进健康簿（格式见 [docs/每日记录接口.md](docs/每日记录接口.md)）：饮食、运动（和手表同一场去重）、皮肤、补剂实际服用、咖啡因、主观感受、症状。用户在「今日」里一键确认、修改或撤销。手表、体脂秤、经期等设备数据照常自动同步，不依赖这次对话。

## 设计原则

- **个人基线优先**：和自己比，不只和人群参考范围比；连续偏离才提示，并写明依据。
- **不假精确**：口述饮食只给区间，不编造精确热量；手表睡眠分期、HRV 只作参考，不打「恢复分数」。
- **未记录 ≠ 0**：没说的餐次是「未记录」，不是没吃；没提到咖啡不等于没喝。
- **相关 ≠ 因果**：交叉分析只做分组对比，每组写明样本量，样本不足显示「等待积累数据」。
- **数据只存一处**：化验、补剂、周期在多个页面引用，但只维护一份；医美项目就是医疗档案里的一条记录。
- **低摩擦**：每天最多一次对话，不拍照、不逐餐打卡、不填复杂表单。
- **医疗边界**：不诊断、不调整药物、不建议补剂剂量、不自动推荐再次医美注射；异常持续或伴随症状时提示就医。

更完整的产品思路见 [docs/design/](docs/design/)：完整看板框架、生活方式模块、睡眠恢复模块。

## 数据从哪来

| 数据 | 来源 | 方式 |
|---|---|---|
| 心率、HRV、睡眠（含入睡起床时间和分期）、步数、运动、血氧、呼吸、经期、周期症状 | Apple Watch / Apple 健康 | iPhone 装 App Store 上的 health4.ai（Supabase 模式），服务器模拟它的登录和上传接口，逐条接收原始样本；也兼容 Health Auto Export、Pulso、FreeReps 格式 |
| 体重、体脂 | 体脂秤 → Apple 健康 | 同上 |
| 体检、化验、影像、处方 | 报告 PDF / 照片 | 页面上传；有文字层的 PDF 自动提取指标 |
| 饮食、补剂、皮肤、感受、咖啡因 | 每天一次 AI 对话 | `POST /api/checkin` |

## 技术

- **前端**：`server/public/index.html` 一个文件（原生 JS + 内联 SVG 图表），手机优先，5 套外观风格（默认「奶油极简」）。直接双击打开会用内置示例数据。
- **服务端**：`server/server.js`，只用 Node 内置模块，无需 `npm install`。数据存在 `DATA_DIR/state.json`，原始设备样本按类型存成 `raw/<成员>/<类型>.ndjson`；每次保存前自动备份。
- **认证**：整个页面用 Basic 认证（`PAGE_PASSWORD`）；设备推送用单独的 `INGEST_TOKEN`。

## 本地试用（虚构数据）

```bash
python3 scripts/make_demo_data.py demo-data
PORT=3000 DATA_DIR=demo-data node server/server.js
# 打开 http://localhost:3000
```

## 部署到自己的服务器

```bash
cd server
cp .env.example .env        # 填 PAGE_PASSWORD、INGEST_TOKEN、H4_ACCOUNTS
docker compose up -d --build
```

容器只监听本机端口，建议用 nginx / Caddy 反向代理并配 HTTPS。健康数据保存在 `server/data/`，**不要提交到 Git**。发布更新可参考 `deploy.example.sh`。

## 隐私

这个仓库只包含代码、文档和虚构的演示数据。真实的健康数据、报告原件、`.env` 口令都只在自己的服务器上，`.gitignore` 已排除 `data/`、`demo-data/`、`.env`。

## 声明

本项目用于个人和家庭的健康信息整理，**不是医疗器械，不提供医疗诊断或治疗建议**。所有提示均为一般性健康管理参考，身体不适或指标异常请咨询医生。

## License

[MIT](LICENSE)
