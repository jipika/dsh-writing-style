// dsh-writing-style — 会话采样（host 半边内部模块）
//
// 采样目标：**你亲自发送出去**的文本，用来蒸馏写作风格。
//
// 会话落盘格式（0.2.0-rc.2 实测）：
//   $DSH_HOME/sessions/--<cwd 斜杠转横杠>--/<sessionId>/session.v4.jsonl.zstd
// 文件是**多帧 zstd 追加**（每个 flush 一帧，实测一个 1MB 文件有 507 帧），
// 所以不能整体解压：必须扫 zstd magic `28 B5 2F FD` 切帧、逐帧解压再拼接，
// 否则只拿到第一帧（症状是"会话看起来是空的"）。
//
// 为什么用 `data.source.kind === "user"` 而不是只看 type：
//   `user/message` 这条记录**所有**来源都复用（真人输入 / 系统注入 / 子代理回填
//   / 工具结果转述），source.kind 才是宿主区分来源的字段。不加这个判断，插件和
//   系统写进去的文本会被当成你的文风。
//
// content 是块数组，只取 `type === "text"`：图片、附件、引用块都不是写作样本。

const fs = process.getBuiltinModule("node:fs");
const fsp = process.getBuiltinModule("node:fs/promises");
const path = process.getBuiltinModule("node:path");
const zlib = process.getBuiltinModule("node:zlib");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 单文件读取上限：会话可能很大，采样不需要全量。 */
const MAX_FILE_BYTES = 24 * 1024 * 1024;

/**
 * cwd → 会话目录名。DSH 的编码规则（实测）：
 *   · 开头去掉前导 `/`，`/` 一律换 `-`，两端再各补一个 `-`；
 *   · 非 ASCII 字符逐个转成 `~XXXX`（UTF-16 码元、大写 hex、补足 4 位）。
 * 例：`/Users/lixiongwei/Documents/AI小说-井坑`
 *     → `--Users-lixiongwei-Documents-AI~5C0F~8BF4-~4E95~7070--`
 */
export function encodeCwd(cwd) {
	const trimmed = String(cwd).replace(/^\/+/, "");
	let out = "";
	for (const ch of trimmed) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "/") out += "-";
		else if (code < 0x20 || code > 0x7e) {
			for (let i = 0; i < ch.length; i++) out += "~" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
		} else out += ch;
	}
	return "--" + out + "--";
}

/** 把一个 session.v4.jsonl.zstd 解成事件数组（切帧 + 逐帧解压 + 拼 JSONL）。 */
export function readSessionEvents(file) {
	let buf;
	try {
		const st = fs.statSync(file);
		if (st.size > MAX_FILE_BYTES) return [];
		buf = fs.readFileSync(file);
	} catch {
		return [];
	}
	const offsets = [];
	let i = 0;
	while (true) {
		const k = buf.indexOf(ZSTD_MAGIC, i);
		if (k < 0) break;
		offsets.push(k);
		i = k + 4;
	}
	let text = "";
	for (let j = 0; j < offsets.length; j++) {
		const seg = buf.subarray(offsets[j], j + 1 < offsets.length ? offsets[j + 1] : buf.length);
		try {
			text += zlib.zstdDecompressSync(seg).toString("utf8");
		} catch {
			// 单帧坏掉不该让整会话作废（切帧靠 magic 猜测，偶有伪命中）。
		}
	}
	const out = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// 半行（正在写入的最后一帧）直接跳过。
		}
	}
	return out;
}

/**
 * 从事件里抽出「用户亲自发送」的文本块。
 * @returns {{ texts: Array<{time:number,text:string}>, skippedInternal: number }}
 */
export function extractUserTexts(events) {
	const texts = [];
	let skippedInternal = 0;
	for (const ev of events) {
		if (ev?.type !== "user/message") continue;
		if (ev?.data?.source?.kind !== "user") continue;
		const src = ev.data.source;
		// 真人从客户端发来的消息带 rpcId（旧格式至少带 clientTimeZone）；
		// 子代理的提示词也记成 `source.kind === "user"`，但 source 里**只有 kind**。
		// 不排掉它，主代理写给子代理的指令会被当成"你的文风"（实测 20 个会话里有 5 条）。
		if (!src.rpcId && !src.clientTimeZone) {
			skippedInternal++;
			continue;
		}
		const parts = [];
		for (const block of ev.data?.content ?? []) {
			if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		const text = parts.join("\n").trim();
		if (text !== "") texts.push({ time: Number(ev.time) || 0, text });
	}
	return { texts, skippedInternal };
}

/** 从事件里读最近一次的模型选择（给蒸馏做默认 provider/model）。 */
export function extractModelSelection(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.type !== "model/selection") continue;
		const d = ev.data ?? {};
		const provider = d.provider ?? d.providerId ?? d.route;
		const model = d.model ?? d.modelId;
		if (typeof provider === "string" && typeof model === "string") return { provider, model };
	}
	return null;
}

/** 会话标题（有 `session/title` 记录就用它，方便在 UI 里展示样本来源）。 */
export function extractTitle(events) {
	let title = "";
	for (const ev of events) {
		if (ev?.type !== "session/title") continue;
		const t = ev?.data?.title ?? ev?.data?.text;
		if (typeof t === "string" && t.trim() !== "") title = t.trim();
	}
	return title;
}

/** 列出会话文件。scope: "cwd"（只当前工作区）| "all"。 */
export async function listSessionFiles(sessionsRoot, { scope = "cwd", cwd = process.cwd() } = {}) {
	let dirs = [];
	try {
		dirs = await fsp.readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const wanted = encodeCwd(cwd);
	const files = [];
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		if (scope === "cwd" && d.name !== wanted) continue;
		const sessionDir = path.join(sessionsRoot, d.name);
		let subs = [];
		try {
			subs = await fsp.readdir(sessionDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const s of subs) {
			if (!s.isDirectory()) continue;
			const base = path.join(sessionDir, s.name);
			for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"]) {
				const f = path.join(base, name);
				try {
					const st = await fsp.stat(f);
					files.push({ file: f, mtime: st.mtimeMs, size: st.size, sessionId: s.name, workspace: d.name });
					break;
				} catch {
					// 换下一个候选名
				}
			}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	return files;
}

/** 清洗单条样本：剥代码块/行内代码/多余空白，并给出"是否值得当写作样本"的判断。 */
export function cleanText(raw, opts = {}) {
	const minChars = Number.isFinite(opts.minChars) ? opts.minChars : 12;
	let t = String(raw ?? "");
	// 去掉围栏代码块（写代码的文本不反映"写作风格"，而且会污染风格描述）。
	t = t.replace(/```[\s\S]*?```/g, " ");
	// 去掉行内代码与 URL（URL 不是文风）。
	t = t.replace(/`[^`]*`/g, " ");
	t = t.replace(/https?:\/\/\S+/g, " ");
	t = t.replace(/\s+/g, " ").trim();
	if (t === "") return null;
	// 斜杠命令（/compact 之类）是操作不是写作。
	if (t.startsWith("/")) return null;
	// 纯符号 / 纯 emoji。
	if (!/[\p{L}\p{N}]/u.test(t)) return null;
	if (t.length < minChars) return null;
	// 附件占位、系统回显。
	if (/^\[(image|attachment|file)/i.test(t)) return null;
	return t;
}

/**
 * 采集样本。
 * @returns {Promise<{samples: Array, stats: object}>}
 */
export async function collectSamples(sessionsRoot, options = {}) {
	const scope = options.scope === "all" ? "all" : "cwd";
	const limit = Number.isFinite(options.limit) ? options.limit : 400;
	const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : 40;
	const minChars = Number.isFinite(options.minChars) ? options.minChars : 12;
	const maxCharsPerSample = Number.isFinite(options.maxCharsPerSample) ? options.maxCharsPerSample : 1200;
	const maxTotalChars = Number.isFinite(options.maxTotalChars) ? options.maxTotalChars : 120000;
	const maxAgeDays = Number.isFinite(options.maxAgeDays) && options.maxAgeDays > 0 ? options.maxAgeDays : 0;

	const files = (await listSessionFiles(sessionsRoot, { scope, cwd: options.cwd })).slice(0, maxSessions);
	const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0;
	const seen = new Set();
	const samples = [];
	const stats = {
		sessions: files.length,
		sessionsScanned: 0,
		rawUserMessages: 0,
		skippedInternal: 0,
		kept: 0,
		chars: 0,
		workspaces: new Set(),
		oldest: 0,
		newest: 0,
	};

	for (const f of files) {
		stats.sessionsScanned++;
		const events = readSessionEvents(f.file);
		if (events.length === 0) continue;
		stats.workspaces.add(f.workspace);
		const title = extractTitle(events);
		const { texts, skippedInternal } = extractUserTexts(events);
		stats.skippedInternal += skippedInternal;
		for (const s of texts) {
			stats.rawUserMessages++;
			if (cutoff > 0 && s.time > 0 && s.time < cutoff) continue;
			let text = cleanText(s.text, { minChars });
			if (text === null) continue;
			if (text.length > maxCharsPerSample) text = text.slice(0, maxCharsPerSample);
			const key = text.slice(0, 160);
			if (seen.has(key)) continue;
			seen.add(key);
			samples.push({ text, time: s.time, sessionId: f.sessionId, title });
			stats.kept++;
			stats.chars += text.length;
			if (s.time > 0) {
				if (stats.oldest === 0 || s.time < stats.oldest) stats.oldest = s.time;
				if (s.time > stats.newest) stats.newest = s.time;
			}
			if (samples.length >= limit || stats.chars >= maxTotalChars) break;
		}
		if (samples.length >= limit || stats.chars >= maxTotalChars) break;
	}

	// 时间倒序里混着各会话：按时间排一遍，最老的在前（蒸馏时顺序不影响结论，但便于人看）。
	samples.sort((a, b) => a.time - b.time);
	stats.workspaceCount = stats.workspaces.size;
	delete stats.workspaces;
	return { samples, stats };
}

/** 找最近一个会话的模型选择（蒸馏默认值）。 */
export async function findLastModelSelection(sessionsRoot) {
	const files = await listSessionFiles(sessionsRoot, { scope: "all" });
	for (const f of files.slice(0, 12)) {
		const sel = extractModelSelection(readSessionEvents(f.file));
		if (sel !== null) return sel;
	}
	return null;
}
