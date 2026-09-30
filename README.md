# dsh-writing-style

> 在**创作模式**里学习你的写作风格：采样你在 DSH 里**亲自发送**的文本，蒸馏成一份
> 写作风格技能（`SKILL.md` + `references/writing-style.md`），写进写作模式的技能目录，
> 之后写作类请求会自动带上它。

对标 ChatGPT 桌面版的「参考我的写作风格」：那边用 `skill-creator` 把 connected apps
里"我撰写的内容"蒸馏成 skill；这边把采样源换成 **DSH 会话本身**，连接器层按同一契约
留好了接口。

## 它解决什么

- 你不想每次都提醒模型"用我的口吻写"。
- 你的文风散在长期对话里，没人替你归纳。
- 归纳出来的东西不该是"再读一遍原文"，而该是**一份可复用的技能**。

## 怎么用

1. 设置 → 插件 → `dsh-writing-style` → **写作风格** tab。
2. 选采样范围（当前工作区 / 全部工作区）→ 点 **预览采样** 看能采到多少条。
3. 点 **开始学习我的写作风格**：采样 → 蒸馏 → 写入技能目录（异步，页面看进度）。
4. 生成的技能落在 `$DSH_HOME/skills-writing/<slug>/`，**只在写作模式可见**。

## 采样规则

| 采纳 | 丢弃 |
| --- | --- |
| `user/message` 且 `data.source.kind === "user"`（你真人发送） | AI 回复、系统注入、子代理回填、工具结果 |
| `content[].type === "text"` | 图片、附件、引用块 |
| 达到最短字数（默认 12） | 斜杠命令、纯链接、纯符号、附件占位 |
| 清洗后的正文 | 围栏代码块、行内代码、URL |

会话文件是**多帧 zstd**（`session.v4.jsonl.zstd`），必须先扫 magic `28 B5 2F FD`
切帧再逐帧解压 —— 整体解压只能拿到第一帧，表现为"会话看起来是空的"。

## 产物结构

```
$DSH_HOME/skills-writing/<slug>/
├── SKILL.md                     # 简短：何时触发 + 硬规则
└── references/writing-style.md  # 详细：Overall voice / Common patterns / Do and avoid / 示例
```

`name` 必须 kebab-case（中文名会被宿主判非法丢弃），插件会把模型给的名字洗成合法形式。

## 连接器（预留接口）

`StyleSource` 契约：

```js
{
  id: "gmail",                     // 稳定 id
  label: "Gmail",
  kind: "connector",
  contexts: ["email"],             // chat | email | message
  description: "…",
  status: async () => ({ available: true }),
  list: async (opts) => [{ text, time, meta }],
}
```

接入方式：

```js
// 任何已在同一 host 进程里挂载的插件
ctx.writingStyle.registerSource(mySource);
```

也可以先只登记声明（不实现取数）：

```sh
curl -X POST http://127.0.0.1:<port>/dsh-writing-style/connectors/register \
  -H 'Content-Type: application/json' \
  -d '{"id":"gmail","label":"Gmail","description":"从我的邮件里采样","enabled":false}'
```

## HTTP 接口（回环、免 token）

```
GET  /dsh-writing-style/status                配置 + 连接器 + 已生成技能 + 可用模型
POST /dsh-writing-style/config                合并写配置
POST /dsh-writing-style/preview               采样预览（统计 + 前 5 条摘要）
POST /dsh-writing-style/learn                 开始学习（202 + jobId）
GET  /dsh-writing-style/jobs[/<id>]           任务进度
GET  /dsh-writing-style/skills                已生成的技能
POST /dsh-writing-style/skills/delete         删除技能
GET  /dsh-writing-style/connectors            连接器清单
POST /dsh-writing-style/connectors/register   登记外部连接器
```

## 配置

`$DSH_HOME/state/writing-style/config.json`：采样范围 / 条数 / 最短字数 / 只看最近 N 天 /
技能目录 / 写作上下文名 / 蒸馏模型（provider+model，留空自动沿用最近会话用过的）。

## 回滚

`dsh.profile.bundles` 去掉 `dsh-writing-style` + 重启应用；生成的技能目录单独删即可，
不影响写作模式其它技能。

## 边界

- 全部逻辑都在插件里，**不碰客户端**（`/Applications/DeepSeek Harness.app` 只读）。
- 蒸馏只输出风格特征：提示词明确禁止把话题 / 人名 / 项目名 / 机密信息当风格，
  也不允许复述样本原句；示例是**按风格新写**的，不是原文摘录。
