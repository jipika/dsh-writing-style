// dsh-writing-style — host 半边
//
// 做什么：把「你亲自在这台机器上发送过的文本」采样出来，蒸馏成一份写作风格
// Skill（SKILL.md + references/writing-style.md），落到写作模式（writing preset）
// 的自定义技能目录里 —— 于是它只在创作模式可见，且下次写作请求会被自动带上。
//
// 对标：ChatGPT 桌面版的「参考我的写作风格」= 用 skill-creator 把 connected apps
// 里"我撰写的内容"蒸馏成 skill。差别只在采样源：那边是邮件/消息连接器，这里是
// 本机 DSH 会话；连接器层按同一契约留好了接口（见 connectors.js）。
//
// 路由（prefix /dsh-writing-style，只监听回环、免 token）：
//   GET  /                      探活 + 端点清单
//   GET  /status                配置 + 连接器状态 + 已生成技能 + 可用的蒸馏模型
//   POST /config                合并写配置（state/writing-style/config.json）
//   POST /preview               采样预览（统计 + 少量样本摘录，不落盘）
//   POST /learn                 启动一次"学习我的写作风格"（异步 job）
//   GET  /jobs                  最近的任务
//   GET  /jobs/<id>             单个任务进度
//   GET  /skills                已生成的风格技能
//   POST /skills/delete         删除某个技能目录
//   GET  /connectors            连接器清单（内置 + 已登记的）
//   POST /connectors/register   登记一个外部连接器（预留接口，只登记元数据）
//
// 不碰客户端：全部逻辑在插件里（用户红线：严禁改 /Applications/DeepSeek Harness.app）。

import { createRegistry, createSessionsSource } from "./connectors.js";
import { collectSamples, findLastModelSelection } from "./sessions.js";
import { ensureDir, listSkills, removeSkill, toSlug, writeSkill } from "./skill.js";

export const name = "dsh-writing-style";
export const inject = [];

const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const fsp = process.getBuiltinModule("node:fs/promises");

const ROUTE = "/dsh-writing-style";
const VERSION = "0.1.0";
const HOME =
	typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(HOME, "state", "writing-style");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
/** 写作模式的自定义技能目录（见 profile 里 preset-writing 的 customSkillDirs）。 */
const DEFAULT_SKILLS_DIR = path.join(HOME, "skills-writing");
const SESSIONS_DIR = path.join(HOME, "sessions");
const MAX_BODY = 256 * 1024;

const log = (...a) => console.log("[dsh-writing-style]", ...a);

const DEFAULT_CONFIG = {
	/** 采样范围："cwd" 只当前工作区 / "all" 所有工作区 */
	scope: "cwd",
	/** 最多取多少条样本 */
	limit: 400,
	/** 最多扫多少个会话文件（按 mtime 从新到旧） */
	maxSessions: 40,
	/** 单条样本低于这个字数就丢掉（"好"、"继续" 不是写作样本） */
	minChars: 12,
	/** 只看最近 N 天（0 = 不限） */
	maxAgeDays: 0,
	maxCharsPerSample: 1200,
	maxTotalChars: 120000,
	/** 产物落点：默认写作模式的技能目录 */
	skillsDir: DEFAULT_SKILLS_DIR,
	/** 蒸馏出的技能的"写作上下文"名字，会进 SKILL.md 标题与描述 */
	label: "创作",
	/** 蒸馏模型；留空则自动取最近一次会话用过的模型 */
	provider: "",
	model: "",
	/** 启用哪些连接器（内置 dsh-sessions 默认开） */
	enabledSources: ["dsh-sessions"],
	/** 预留：外部连接器声明（id -> { enabled, config, label, description }） */
	connectors: {},
};

// ── 配置读写 ────────────────────────────────────────────────────────────────

async function readConfig() {
	try {
		const raw = await fsp.readFile(CONFIG_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_CONFIG, ...(parsed !== null && typeof parsed === "object" ? parsed : {}) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function writeConfig(patch) {
	const current = await readConfig();
	const next = { ...current, ...(patch ?? {}) };
	await fsp.mkdir(STATE_DIR, { recursive: true });
	await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
	return next;
}

// ── 蒸馏 ────────────────────────────────────────────────────────────────────

const DISTILL_SYSTEM = `你是写作风格分析师。输入是一个人**自己撰写并发送**的文本样本（来自他日常与 AI 的对话）。
你的任务：只提炼**稳定的写作风格特征**，输出严格 JSON。

规则：
1. 只描述风格：语气、句式与句长、词汇与口头禅、标点与排版习惯、细节颗粒度、开场/收尾方式、反复出现的模式。
2. **绝对不要**把话题、项目名、人名、技术栈、机密信息当成风格特征；结论里不要复述或引用样本原句。
3. 样本可能横跨不同场景（技术讨论、小说创作、日常闲聊）。请归纳**共同**特征，并指出明显的场景差异。
4. 证据不足就明说"样本不足以判断 X"，不要编造。
5. 只输出 JSON，不要 markdown 代码围栏，不要任何解释文字。字段与类型：
{
  "name": "kebab-case 的英文技能名（体现语言与场景，如 chinese-chat-tech-style）",
  "description": "一句话中文：什么场景应该加载这个风格技能（写清触发条件）",
  "overallVoice": "3-6 句中文整体印象",
  "commonPatterns": ["中文要点", "..."],
  "doAndAvoid": { "do": ["散文式规则"], "avoid": ["散文式规则"] },
  "examples": ["按该风格**新写**的示例 1", "示例 2"]
}`;

function buildUserPrompt(samples, label) {
	const blocks = samples
		.map((s, i) => `【样本 ${i + 1}】\n${s.text}`)
		.join("\n\n");
	return `写作场景：${label}\n样本条数：${samples.length}\n\n${blocks}`;
}

/** 容错解析模型输出里的 JSON。 */
function parseProfile(text) {
	let t = String(text ?? "").trim();
	t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) t = t.slice(start, end + 1);
	return JSON.parse(t);
}

async function resolveModel(ctx, config) {
	if (config.provider !== "" && config.model !== "") return { provider: config.provider, model: config.model };
	const fromSessions = await findLastModelSelection(SESSIONS_DIR);
	if (fromSessions !== null) return fromSessions;
	try {
		const providers = ctx.llm?.listProviders?.() ?? [];
		const first = providers[0];
		if (first !== undefined) {
			const id = typeof first === "string" ? first : first.id ?? first.name;
			if (typeof id === "string" && id !== "") return { provider: id, model: config.model };
		}
	} catch {
		// 下面统一报错
	}
	throw new Error("找不到可用于蒸馏的模型：请在设置里指定 provider / model，或先跑一次会话");
}

async function distill(ctx, samples, { provider, model, label }) {
	if (ctx.llm === undefined || typeof ctx.llm.stream !== "function") {
		throw new Error("llm 服务不可用（ctx.llm.stream 缺失）");
	}
	const messages = [
		{ role: "system", content: [{ type: "text", text: DISTILL_SYSTEM }] },
		{ role: "user", content: [{ type: "text", text: buildUserPrompt(samples, label) }] },
	];
	let out = "";
	let finishReason = null;
	for await (const chunk of ctx.llm.stream({ provider, model, messages })) {
		const type = chunk?.type;
		if (type === "text-delta") out += chunk.text ?? chunk.delta ?? "";
		else if (type === "finish") finishReason = chunk.reason ?? chunk.finishReason ?? "finish";
	}
	if (out.trim() === "") throw new Error(`模型没有返回内容（finish=${finishReason ?? "?"}）`);
	return out;
}

// ── 任务（异步蒸馏）─────────────────────────────────────────────────────────

const jobs = new Map();
const JOB_KEEP = 20;

function newJob(type, detail) {
	const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const job = { id, type, status: "running", phase: "start", detail: detail ?? {}, startedAt: Date.now(), finishedAt: null, error: null, result: null };
	jobs.set(id, job);
	while (jobs.size > JOB_KEEP) jobs.delete(jobs.keys().next().value);
	return job;
}

function jobView(job) {
	if (job === undefined) return null;
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		phase: job.phase,
		detail: job.detail,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		error: job.error,
		result: job.result,
	};
}

// ── 采样参数 ────────────────────────────────────────────────────────────────

function sampleOptions(config, override = {}) {
	return {
		scope: override.scope ?? config.scope,
		limit: num(override.limit, config.limit),
		maxSessions: num(override.maxSessions, config.maxSessions),
		minChars: num(override.minChars, config.minChars),
		maxAgeDays: num(override.maxAgeDays, config.maxAgeDays),
		maxCharsPerSample: num(override.maxCharsPerSample, config.maxCharsPerSample),
		maxTotalChars: num(override.maxTotalChars, config.maxTotalChars),
		cwd: process.cwd(),
	};
}

function num(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/** 取选中连接器的样本并合并（当前只有内置会话源，多源时按 id 顺序拼接）。 */
async function collectFromSources(ctx, registry, config, options) {
	const enabled = registry.enabled(config.enabledSources);
	const all = [];
	const perSource = [];
	for (const src of enabled) {
		try {
			const items = await src.list(options);
			perSource.push({ id: src.id, label: src.label, count: items.length });
			all.push(...items);
		} catch (error) {
			perSource.push({ id: src.id, label: src.label, count: 0, error: String(error?.message ?? error) });
		}
	}
	return { samples: all, perSource };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function reply(res, status, body) {
	const payload = JSON.stringify(body ?? {});
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
	});
	res.end(payload);
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > MAX_BODY) throw new Error("request body too large");
		chunks.push(c);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	return JSON.parse(text);
}

function createHandler(ctx, registry) {
	return async function handler(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const route = url.pathname.replace(/\/+$/, "") || ROUTE;
		const method = (req.method ?? "GET").toUpperCase();
		if (method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
				"Access-Control-Max-Age": "600",
			});
			res.end();
			return;
		}
		try {
			const config = await readConfig();

			// 探活
			if ((method === "GET" || method === "HEAD") && (route === ROUTE || route === `${ROUTE}/health`)) {
				reply(res, 200, {
					ok: true,
					name: "dsh-writing-style",
					version: VERSION,
					home: HOME,
					stateFile: CONFIG_FILE,
					endpoints: {
						status: `GET ${ROUTE}/status`,
						config: `POST ${ROUTE}/config`,
						preview: `POST ${ROUTE}/preview`,
						learn: `POST ${ROUTE}/learn`,
						jobs: `GET ${ROUTE}/jobs`,
						skills: `GET ${ROUTE}/skills`,
						skillDelete: `POST ${ROUTE}/skills/delete`,
						connectors: `GET ${ROUTE}/connectors`,
						connectorRegister: `POST ${ROUTE}/connectors/register`,
					},
				});
				return;
			}

			// 总状态
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/status`) {
				const sources = [];
				for (const s of registry.list()) {
					let status = { available: true };
					try {
						status = await s.status();
					} catch (error) {
						status = { available: false, detail: String(error?.message ?? error) };
					}
					sources.push({
						id: s.id,
						label: s.label,
						kind: s.kind,
						description: s.description,
						contexts: s.contexts,
						enabled: (config.enabledSources ?? []).includes(s.id),
						...status,
					});
				}
				let providers = [];
				try {
					providers = (ctx.llm?.listProviders?.() ?? []).map((p) => (typeof p === "string" ? { id: p } : { id: p.id ?? p.name, label: p.label ?? p.name }));
				} catch {
					providers = [];
				}
				let autoModel = null;
				try {
					autoModel = await findLastModelSelection(SESSIONS_DIR);
				} catch {
					autoModel = null;
				}
				const skills = await listSkills(config.skillsDir);
				reply(res, 200, {
					ok: true,
					version: VERSION,
					config,
					paths: { home: HOME, sessions: SESSIONS_DIR, skillsDir: config.skillsDir, state: STATE_DIR },
					sources,
					connectors: Object.entries(config.connectors ?? {}).map(([id, v]) => ({ id, ...v })),
					skills,
					llm: { providers, autoModel, effective: config.provider !== "" && config.model !== "" ? { provider: config.provider, model: config.model } : autoModel },
				});
				return;
			}

			// 写配置
			if (method === "POST" && route === `${ROUTE}/config`) {
				const body = await readBody(req);
				const allowed = {};
				for (const key of Object.keys(DEFAULT_CONFIG)) {
					if (body[key] !== undefined) allowed[key] = body[key];
				}
				if (typeof allowed.skillsDir === "string" && allowed.skillsDir !== "") {
					allowed.skillsDir = path.resolve(allowed.skillsDir.replace(/^~(?=\/|$)/, os.homedir()));
				}
				const next = await writeConfig(allowed);
				reply(res, 200, { ok: true, config: next });
				return;
			}

			// 采样预览
			if (method === "POST" && route === `${ROUTE}/preview`) {
				const body = await readBody(req);
				const options = sampleOptions(config, body);
				const { stats, head } = await (registry.get("dsh-sessions")?.preview?.(options) ??
					Promise.resolve({ stats: {}, head: [] }));
				reply(res, 200, {
					ok: true,
					stats,
					head: head.map((s) => ({
						time: s.time,
						title: s.title,
						chars: s.text.length,
						preview: s.text.slice(0, 160) + (s.text.length > 160 ? "…" : ""),
					})),
					options,
				});
				return;
			}

			// 开始学习
			if (method === "POST" && route === `${ROUTE}/learn`) {
				const body = await readBody(req);
				const options = sampleOptions(config, body);
				const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : config.label;
				const job = newJob("learn", { options, label });
				void runLearn(ctx, registry, config, options, label, job);
				reply(res, 202, { ok: true, job: jobView(job) });
				return;
			}

			// 任务
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/jobs`) {
				reply(res, 200, { ok: true, jobs: [...jobs.values()].map(jobView).reverse() });
				return;
			}
			if ((method === "GET" || method === "HEAD") && route.startsWith(`${ROUTE}/jobs/`)) {
				const id = route.slice(`${ROUTE}/jobs/`.length);
				const job = jobs.get(id);
				if (job === undefined) {
					reply(res, 404, { ok: false, error: `unknown job "${id}"` });
					return;
				}
				reply(res, 200, { ok: true, job: jobView(job) });
				return;
			}

			// 技能列表 / 删除
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/skills`) {
				reply(res, 200, { ok: true, skillsDir: config.skillsDir, skills: await listSkills(config.skillsDir) });
				return;
			}
			if (method === "POST" && route === `${ROUTE}/skills/delete`) {
				const body = await readBody(req);
				const slug = toSlug(body.slug ?? "", "x");
				const out = await removeSkill(config.skillsDir, slug);
				reply(res, 200, { ok: true, ...out });
				return;
			}

			// 连接器
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/connectors`) {
				reply(res, 200, {
					ok: true,
					registered: registry.list().map((s) => ({ id: s.id, label: s.label, kind: s.kind, description: s.description, contexts: s.contexts })),
					declarations: Object.entries(config.connectors ?? {}).map(([id, v]) => ({ id, ...v })),
					note: "外部连接器接口已预留：实现 StyleSource（id/label/list）后调用 ctx.writingStyle.registerSource()，或先在此登记声明。",
				});
				return;
			}
			if (method === "POST" && route === `${ROUTE}/connectors/register`) {
				const body = await readBody(req);
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (id === "") {
					reply(res, 400, { ok: false, error: "id required" });
					return;
				}
				const config2 = await readConfig();
				const connectors = {
					...config2.connectors,
					[id]: {
						label: typeof body.label === "string" ? body.label : id,
						description: typeof body.description === "string" ? body.description : "",
						enabled: body.enabled === true,
						config: body.config ?? {},
						registeredAt: Date.now(),
					},
				};
				const next = await writeConfig({ connectors });
				reply(res, 200, { ok: true, connectors: next.connectors });
				return;
			}

			reply(res, 404, { ok: false, error: `no route: ${method} ${route}` });
		} catch (error) {
			reply(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/** 一次"学习"：采样 → 蒸馏 → 落盘。全程更新 job 供 UI 轮询。 */
async function runLearn(ctx, registry, config, options, label, job) {
	try {
		job.phase = "sampling";
		const { samples, perSource } = await collectFromSources(ctx, registry, config, options);
		if (samples.length === 0) {
			throw new Error("没有采样到任何样本：换个范围（当前工作区 / 全部），或先多聊几句");
		}
		job.detail.sources = perSource;
		job.detail.sampleCount = samples.length;
		job.detail.sampleChars = samples.reduce((n, s) => n + s.text.length, 0);

		job.phase = "resolving-model";
		const { provider, model } = await resolveModel(ctx, config);
		job.detail.provider = provider;
		job.detail.model = model;

		job.phase = "distilling";
		const raw = await distill(ctx, samples, { provider, model, label });
		const profile = parseProfile(raw);

		job.phase = "writing";
		await ensureDir(config.skillsDir);
		const times = samples.map((s) => s.time).filter((t) => t > 0);
		const meta = {
			label,
			sourceLabel: perSource.map((s) => s.label).join(" + "),
			sampleCount: samples.length,
			sampleChars: job.detail.sampleChars,
			oldest: times.length > 0 ? Math.min(...times) : 0,
			newest: times.length > 0 ? Math.max(...times) : 0,
			generatedAt: Date.now(),
			provider,
			model,
			notes: options.scope === "cwd" ? "仅当前工作区" : "全部工作区",
		};
		const written = await writeSkill(config.skillsDir, profile, meta);

		job.status = "done";
		job.phase = "done";
		job.finishedAt = Date.now();
		job.result = {
			slug: written.slug,
			dir: written.dir,
			description: profile.description ?? "",
			overallVoice: profile.overallVoice ?? "",
			sampleCount: samples.length,
			sampleChars: meta.sampleChars,
			provider,
			model,
		};
		log(`learned "${written.slug}" from ${samples.length} samples -> ${written.dir}`);
	} catch (error) {
		job.status = "failed";
		job.phase = "failed";
		job.finishedAt = Date.now();
		job.error = String(error?.message ?? error);
		log("learn failed:", job.error);
	}
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
	const registry = createRegistry();
	registry.register(createSessionsSource({ collectSamples, sessionsRoot: SESSIONS_DIR }));

	// 对外扩展点：未来连接器插件（邮件 / 消息应用）实现 StyleSource 后注册进来。
	ctx.writingStyle = {
		version: VERSION,
		registerSource: (source) => registry.register(source),
		listSources: () => registry.list(),
		getSource: (id) => registry.get(id),
	};

	ctx.inject(["webServer"], (wctx) => {
		wctx.webServer.register({
			kind: "prefix",
			path: ROUTE,
			handler: createHandler(ctx, registry),
		});
		log(`host half mounted; route=${ROUTE} · sessions=${SESSIONS_DIR}`);
	});
}
