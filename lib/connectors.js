// dsh-writing-style — 连接器层（StyleSource 契约 + 注册表）
//
// 对标 ChatGPT 桌面版「参考我的写作风格」里的 connected apps：那边由模型调
// `request_plugin_install` 装连接器插件，再从各 app 采样。这里把同一层抽象
// 先留出来 —— 当前只内置一个源（DSH 会话本身），外部连接器（邮件 / 消息应用）
// 以后按同一契约注册即可，采样与蒸馏管线不用改。
//
// 契约（StyleSource）：
//   {
//     id: string,              // 稳定 id：'dsh-sessions' / 'gmail' / 'slack' …
//     label: string,           // UI 显示名
//     kind: 'builtin' | 'connector',
//     description?: string,
//     contexts?: string[],     // 该源覆盖的写作上下文：'chat' | 'email' | 'message'
//     status?: () => Promise<{ available: boolean, detail?: string }>,
//     list: (opts) => Promise<Array<{ text: string, time?: number, id?: string, meta?: object }>>
//   }
//
// 两个注册通道：
//   ① 同进程插件：ctx.writingStyle.registerSource(source)（推荐，能力完整）
//   ② 外部程序 / 未来的 MCP 连接器：POST /dsh-writing-style/connectors/register
//      —— 只登记声明（id/label/description/enabled），取数仍要有 list() 实现，
//      所以真正的连接器最终都要走 ① 或由本插件内置一个取数适配器。

/** 建一个连接器注册表。内置源由 index.js 注册进来。 */
export function createRegistry() {
	/** @type {Map<string, any>} */
	const sources = new Map();
	return {
		register(source) {
			if (source === null || typeof source !== "object") throw new Error("source must be an object");
			if (typeof source.id !== "string" || source.id === "") throw new Error("source.id required");
			if (typeof source.list !== "function") throw new Error(`source "${source.id}": list() required`);
			const normalized = {
				kind: "connector",
				contexts: ["chat"],
				description: "",
				async status() {
					return { available: true };
				},
				...source,
			};
			sources.set(normalized.id, normalized);
			return normalized.id;
		},
		get(id) {
			return sources.get(id);
		},
		list() {
			return [...sources.values()];
		},
		/** 只保留启用的源（enabledIds 为 null 时全部启用）。 */
		enabled(enabledIds) {
			const all = [...sources.values()];
			if (!Array.isArray(enabledIds)) return all;
			return all.filter((s) => enabledIds.includes(s.id));
		},
	};
}

/**
 * 内置源：DSH 会话本身。
 * `list()` 走 sessions.js 的采样管线（切帧解压 + 只取真人发送的文本）。
 */
export function createSessionsSource({ collectSamples, sessionsRoot }) {
	return {
		id: "dsh-sessions",
		label: "DSH 会话",
		kind: "builtin",
		contexts: ["chat"],
		description: "从你在这台机器上的 DSH 会话里，抽取你亲自发送的消息作为写作样本。",
		async status() {
			return { available: true, detail: sessionsRoot };
		},
		async list(options = {}) {
			const { samples } = await collectSamples(sessionsRoot, options);
			return samples;
		},
		/** 采样统计（UI 预览用，比 list() 便宜，且不返回正文）。 */
		async preview(options = {}) {
			const { samples, stats } = await collectSamples(sessionsRoot, options);
			return { stats, head: samples.slice(0, 5) };
		},
	};
}
