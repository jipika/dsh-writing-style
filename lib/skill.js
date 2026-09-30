// dsh-writing-style — 写作风格 Skill 的渲染与落盘
//
// 产物形态（照抄 ChatGPT 端那套约定的结构）：
//   <skillsDir>/<slug>/SKILL.md                  —— 简短、负责"何时触发"
//   <skillsDir>/<slug>/references/writing-style.md —— 详细档案：Overall voice /
//                                                     Common patterns / Do and avoid
// 默认 skillsDir 是写作模式（writing preset）的自定义技能目录 `$DSH_HOME/skills-writing`，
// 所以生成的技能**只在写作模式下可见** —— 这正是"做到创作模式里面"的含义，
// 不需要改 preset 声明。
//
// 技能名必须是 kebab-case（宿主按 frontmatter 的 name 解析，中文名会被判非法丢弃），
// 所以模型给的 name 要在这里再洗一遍。

const fs = process.getBuiltinModule("node:fs");
const fsp = process.getBuiltinModule("node:fs/promises");
const path = process.getBuiltinModule("node:path");

/** 洗成合法技能名：小写、字母数字连字符、字母开头。 */
export function toSlug(input, fallback = "my-writing-style") {
	let s = String(input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	if (s === "" || !/^[a-z]/.test(s)) s = `${fallback}-${s}`.replace(/-+$/g, "");
	return s.slice(0, 60);
}

function bullets(items, empty = "- （样本不足以归纳这一项）") {
	const arr = Array.isArray(items) ? items.filter((x) => typeof x === "string" && x.trim() !== "") : [];
	if (arr.length === 0) return empty;
	return arr.map((x) => `- ${x.trim()}`).join("\n");
}

/** 渲染 SKILL.md（简短，负责路由与硬规则）。 */
export function renderSkillMd(profile, meta) {
	const name = toSlug(profile.name);
	const description =
		typeof profile.description === "string" && profile.description.trim() !== ""
			? profile.description.trim()
			: `以「我」的口吻起草、改写或回复${meta.label}时使用：套用我从${meta.sourceLabel}里体现出的写作风格。`;
	const doList = bullets(profile.doAndAvoid?.do, "- （样本不足）");
	const avoidList = bullets(profile.doAndAvoid?.avoid, "- （样本不足）");
	return `---
name: ${name}
description: ${description}
---

# 我的写作风格（${meta.label}）

${typeof profile.overallVoice === "string" ? profile.overallVoice.trim() : "（样本不足以描述整体风格）"}

## 何时使用

当请求是**以我的口吻写作**时使用：起草、改写、回复、润色 —— 尤其是${meta.label}场景。
不要用它改写别人的文字，也不要把风格规则套到代码、命令、结构化数据上。

## 硬规则

${doList}

**避免**

${avoidList}

## 详细档案

完整的风格特征、对照规则与示例见 [\`references/writing-style.md\`](references/writing-style.md)。
`;
}

/** 渲染 references/writing-style.md（详细档案）。 */
export function renderReference(profile, meta) {
	const patterns = bullets(profile.commonPatterns, "- （样本不足以归纳常见模式）");
	const doList = bullets(profile.doAndAvoid?.do, "- （样本不足）");
	const avoidList = bullets(profile.doAndAvoid?.avoid, "- （样本不足）");
	const examples = Array.isArray(profile.examples)
		? profile.examples.filter((x) => typeof x === "string" && x.trim() !== "")
		: [];
	const exampleBlock =
		examples.length === 0
			? "> （本次没有生成示例）"
			: examples.map((e) => `> ${e.trim().replace(/\n+/g, " ")}`).join("\n>\n");
	const t = (ms) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "未知");
	return `# ${meta.label} · 写作风格参考

> 本文档由 \`dsh-writing-style\` 从 **${meta.sourceLabel}** 的样本自动蒸馏，供模型在写作时加载。
> 示例是**按风格新写的**，不是你的原文摘录；档案里不保留姓名、项目名与机密细节。

## Overall voice

${typeof profile.overallVoice === "string" ? profile.overallVoice.trim() : "（样本不足以描述整体风格）"}

## Common patterns

${patterns}

## Do and avoid

**Do**

${doList}

**Avoid**

${avoidList}

## 示例（按该风格新写）

${exampleBlock}

## 采样元信息

| 项 | 值 |
| --- | --- |
| 样本来源 | ${meta.sourceLabel} |
| 样本条数 | ${meta.sampleCount} |
| 样本字数 | ${meta.sampleChars} |
| 时间范围 | ${t(meta.oldest)} ~ ${t(meta.newest)} |
| 生成时间 | ${new Date(meta.generatedAt).toISOString()} |
| 蒸馏模型 | ${meta.provider} / ${meta.model} |
${meta.notes ? `| 备注 | ${meta.notes} |\n` : ""}`;
}

/** 写入一个 skill（覆盖已有同名 skill 的这两个文件）。 */
export async function writeSkill(skillsDir, profile, meta) {
	const slug = toSlug(profile.name);
	const dir = path.join(skillsDir, slug);
	await fsp.mkdir(path.join(dir, "references"), { recursive: true });
	await fsp.writeFile(path.join(dir, "SKILL.md"), renderSkillMd(profile, meta), "utf8");
	await fsp.writeFile(path.join(dir, "references", "writing-style.md"), renderReference(profile, meta), "utf8");
	return { slug, dir };
}

/** 列出已生成的技能（只认本插件的产物：references/writing-style.md 存在）。 */
export async function listSkills(skillsDir) {
	let entries = [];
	try {
		entries = await fsp.readdir(skillsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (!e.isDirectory() && !e.isSymbolicLink()) continue;
		const dir = path.join(skillsDir, e.name);
		const ref = path.join(dir, "references", "writing-style.md");
		let st;
		try {
			st = await fsp.stat(ref);
		} catch {
			continue;
		}
		let description = "";
		try {
			const md = await fsp.readFile(path.join(dir, "SKILL.md"), "utf8");
			const m = md.match(/^description:\s*(.+)$/m);
			if (m) description = m[1].trim();
		} catch {
			// 没有 SKILL.md 也不致命
		}
		out.push({ slug: e.name, dir, description, updatedAt: st.mtimeMs });
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** 删除某个技能目录（只允许删 skillsDir 下的直接子目录）。 */
export async function removeSkill(skillsDir, slug) {
	const clean = toSlug(slug, "x");
	// 只接受已经合法的技能名：任何会被 toSlug 改写的输入（含 `../` 之类穿越）一律拒绝。
	if (clean !== slug) throw new Error("invalid skill name");
	const dir = path.join(skillsDir, clean);
	const root = path.resolve(skillsDir) + path.sep;
	if (!path.resolve(dir).startsWith(root)) throw new Error("invalid skill path");
	await fsp.rm(dir, { recursive: true, force: true });
	return { slug: clean, dir };
}

/** 目录存在性 / 可写性检查（设置页与首次生成都会用到）。 */
export async function ensureDir(dir) {
	await fsp.mkdir(dir, { recursive: true });
	fs.accessSync(dir, fs.constants.W_OK);
	return dir;
}
