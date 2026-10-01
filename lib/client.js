// dsh-writing-style — client 半边（设置 → 插件 → 本插件 tab）
//
// 挂载点：slot `settings.plugins.tab`，**id 必须等于插件包名** —— 宿主在
// 「设置 → 插件」页按插件清单行的 id 用 { only: row.id } 过滤渲染 tab，
// 写成别的字符串会落在永远不会被渲染的行上（点开空白）。
//
// 页面做什么：
//   · 连接器区：内置「DSH 会话」源 + 外部连接器占位（接口已预留）
//   · 采样区：范围 / 条数 / 最短字数 / 只取最近 N 天
//   · 预览：先看采到多少条、多少字，再决定要不要蒸馏
//   · 学习：异步 job（采样 → 蒸馏 → 落盘），轮询进度
//   · 产物：已生成的写作风格技能（可打开目录、可删除）
//   · 蒸馏模型：留空 = 自动沿用最近一次会话的模型
//
// 所有请求都打相对路径 `/dsh-writing-style/*`：桌面外壳会把 dsh-app:// 下的
// 请求转发给 host，所以页面侧没有跨源、CSP、端口这些问题。

window.__ModuleLoader__.load({
	id: "dsh-writing-style",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useCallback, useRef } = React;

		const API = "/dsh-writing-style";
		const STYLE_ID = "dsh-writing-style-css";

		const fmtTime = (ms) => {
			if (!ms) return "—";
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		};
		const fmtDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

		async function api(method, suffix, body) {
			const res = await fetch(API + suffix, {
				method,
				headers: body === undefined ? undefined : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await res.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				throw new Error(`${method} ${suffix} → ${res.status}: ${text.slice(0, 200)}`);
			}
			if (!res.ok || json.ok === false) throw new Error(json.error ?? `${method} ${suffix} → ${res.status}`);
			return json;
		}

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = `
.dsws-wrap { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; font-size: 13px; }
.dsws-card { border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12)); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-elevated, transparent); }
.dsws-card > h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.dsws-desc { margin: 0 0 12px; opacity: .68; line-height: 1.6; }
.dsws-row { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: flex-end; }
.dsws-field { display: flex; flex-direction: column; gap: 4px; min-width: 132px; }
.dsws-field > label { font-size: 12px; opacity: .72; }
.dsws-field input, .dsws-field select { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.16)); background: transparent; color: inherit; font-size: 13px; }
.dsws-actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; align-items: center; }
.dsws-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.16)); background: transparent; color: inherit; cursor: pointer; font-size: 13px; }
.dsws-btn:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.08)); }
.dsws-btn[disabled] { opacity: .45; cursor: not-allowed; }
.dsws-btn-primary { background: var(--dsw-alias-button-primary-fill, #2c6ef2); border-color: transparent; color: #fff; }
.dsws-btn-primary:hover { filter: brightness(1.06); background: var(--dsw-alias-button-primary-fill, #2c6ef2); }
.dsws-src { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-top: 1px dashed var(--dsw-alias-border-secondary, rgba(0,0,0,.1)); }
.dsws-src:first-of-type { border-top: 0; }
.dsws-src > div { flex: 1; }
.dsws-src b { font-weight: 600; }
.dsws-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; margin-left: 6px; background: rgba(127,127,127,.14); }
.dsws-on { background: rgba(46,160,67,.18); }
.dsws-off { opacity: .6; }
.dsws-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin: 10px 0 4px; }
.dsws-stat { padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.08); }
.dsws-stat b { display: block; font-size: 17px; font-weight: 600; }
.dsws-stat span { font-size: 11px; opacity: .66; }
.dsws-list { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.dsws-item { padding: 9px 11px; border-radius: 8px; background: rgba(127,127,127,.07); display: flex; gap: 12px; align-items: flex-start; }
.dsws-item > div { flex: 1; min-width: 0; }
.dsws-item code { font-size: 12px; }
.dsws-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; opacity: .78; word-break: break-all; }
.dsws-note { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.6; }
.dsws-note-ok { background: rgba(46,160,67,.12); }
.dsws-note-err { background: rgba(207,34,46,.12); }
.dsws-note-info { background: rgba(127,127,127,.1); }
.dsws-progress { height: 6px; border-radius: 999px; background: rgba(127,127,127,.18); overflow: hidden; margin-top: 10px; }
.dsws-progress > i { display: block; height: 100%; background: var(--dsw-alias-button-primary-fill, #2c6ef2); transition: width .3s; }
		`;
			document.head.appendChild(el);
		}

		const PHASES = {
			start: 8,
			sampling: 25,
			"resolving-model": 40,
			distilling: 70,
			writing: 92,
			done: 100,
			failed: 100,
		};

		function Panel() {
			const [status, setStatus] = useState(null);
			const [form, setForm] = useState(null);
			const [preview, setPreview] = useState(null);
			const [job, setJob] = useState(null);
			const [note, setNote] = useState(null);
			const [busy, setBusy] = useState(false);
			const timer = useRef(null);

			const load = useCallback(async () => {
				const s = await api("GET", "/status");
				setStatus(s);
				setForm((prev) =>
					prev ?? {
						scope: s.config.scope,
						limit: s.config.limit,
						minChars: s.config.minChars,
						maxAgeDays: s.config.maxAgeDays,
						maxSessions: s.config.maxSessions,
						label: s.config.label,
						provider: s.config.provider,
						model: s.config.model,
						skillsDir: s.config.skillsDir,
					},
				);
				return s;
			}, []);

			useEffect(() => {
				ensureStyle();
				load().catch((e) => setNote({ kind: "err", text: String(e.message ?? e) }));
			}, [load]);

			useEffect(() => {
				if (timer.current !== null) {
					clearInterval(timer.current);
					timer.current = null;
				}
				if (job === null || job.status !== "running") return undefined;
				timer.current = setInterval(async () => {
					try {
						const { job: next } = await api("GET", `/jobs/${job.id}`);
						setJob(next);
						if (next.status !== "running") await load();
					} catch (e) {
						setNote({ kind: "err", text: String(e.message ?? e) });
					}
				}, 1500);
				return () => {
					if (timer.current !== null) clearInterval(timer.current);
				};
			}, [job, load]);

			const patch = (kv) => setForm((f) => ({ ...f, ...kv }));

			const saveConfig = async (extra) => {
				setBusy(true);
				try {
					const { config } = await api("POST", "/config", { ...form, ...(extra ?? {}) });
					setNote({ kind: "ok", text: `配置已保存（${config.skillsDir}）` });
					await load();
				} catch (e) {
					setNote({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			const doPreview = async () => {
				setBusy(true);
				setNote(null);
				try {
					const r = await api("POST", "/preview", form);
					setPreview(r);
				} catch (e) {
					setNote({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			const doLearn = async () => {
				setBusy(true);
				setNote(null);
				try {
					await saveConfig();
					const r = await api("POST", "/learn", form);
					setJob(r.job);
					setNote({ kind: "info", text: "已开始学习：采样 → 蒸馏 → 写入技能目录。可以留在本页看进度。" });
				} catch (e) {
					setNote({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			const removeSkill = async (slug) => {
				setBusy(true);
				try {
					await api("POST", "/skills/delete", { slug });
					await load();
					setNote({ kind: "ok", text: `已删除技能 ${slug}` });
				} catch (e) {
					setNote({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			if (status === null || form === null) {
				// 宿主半边没挂上时（apply 抛错 / 路由 404），错误 note 以前会被这个分支吞掉，
				// 面板就永远是「正在读取插件状态…」。这里把它显示出来。
				if (note?.kind === "err") {
					return h(
						"div",
						{ className: "dsws-wrap" },
						h("div", { className: "dsws-desc" }, "宿主半边未就绪，读取插件状态失败："),
						h("div", { className: "dsws-note dsws-note-err" }, note.text),
					);
				}
				return h("div", { className: "dsws-wrap" }, h("div", { className: "dsws-desc" }, "正在读取插件状态…"));
			}

			const sources = status.sources ?? [];
			const skills = status.skills ?? [];
			const llm = status.llm ?? {};

			return h(
				"div",
				{ className: "dsws-wrap" },

				// ── 说明 ──────────────────────────────────────────────
				h(
					"div",
					{ className: "dsws-card" },
					h("h3", null, "学习我的写作风格"),
					h(
						"div",
						{ className: "dsws-desc" },
						"采样你在 DSH 里",
						h("b", null, "亲自发送"),
						"的文本（不回读 AI 的回复、不含系统注入），蒸馏成一份写作风格技能，写进写作模式的技能目录。生成的技能只在创作模式可见，并被自动带上。",
					),
					h("div", { className: "dsws-mono" }, `技能目录：${status.config.skillsDir}`),
					h("div", { className: "dsws-mono" }, `会话目录：${status.paths.sessions}`),
				),

				// ── 连接器 ────────────────────────────────────────────
				h(
					"div",
					{ className: "dsws-card" },
					h("h3", null, "连接器"),
					h("div", { className: "dsws-desc" }, "样本来源。接口已预留：外部连接器（邮件 / 消息应用）实现 StyleSource 后调用 ctx.writingStyle.registerSource() 即可接入，采样与蒸馏管线不用改。"),
					...sources.map((s) =>
						h(
							"div",
							{ className: "dsws-src", key: s.id },
							h(
								"div",
								null,
								h("b", null, s.label),
								h("span", { className: `dsws-tag ${s.available ? "dsws-on" : "dsws-off"}` }, s.available ? "可用" : "不可用"),
								h("span", { className: "dsws-tag" }, s.kind === "builtin" ? "内置" : "连接器"),
								h("div", { className: "dsws-desc", style: { margin: "4px 0 0" } }, s.description),
								s.detail ? h("div", { className: "dsws-mono" }, s.detail) : null,
							),
						),
					),
					h(
						"div",
						{ className: "dsws-src" },
						h(
							"div",
							null,
							h("b", null, "外部连接器"),
							h("span", { className: "dsws-tag dsws-off" }, "未接入"),
							h(
								"div",
								{ className: "dsws-desc", style: { margin: "4px 0 0" } },
								"预留位：邮件 / 消息应用等来源。可用 POST ",
								h("code", null, `${API}/connectors/register`),
								" 先登记声明，等参考实现就绪后生效。",
							),
						),
					),
				),

				// ── 采样参数 ──────────────────────────────────────────
				h(
					"div",
					{ className: "dsws-card" },
					h("h3", null, "采样"),
					h("div", { className: "dsws-desc" }, "只统计你发送出去的文本；斜杠命令、纯链接、代码块、过短的消息会被自动剔除。"),
					h(
						"div",
						{ className: "dsws-row" },
						field("范围", h("select", { value: form.scope, onChange: (e) => patch({ scope: e.target.value }) },
							h("option", { value: "cwd" }, "当前工作区"),
							h("option", { value: "all" }, "全部工作区"),
						)),
						field("最多条数", h("input", { type: "number", min: 20, max: 5000, value: form.limit, onChange: (e) => patch({ limit: Number(e.target.value) }) })),
						field("最短字数", h("input", { type: "number", min: 1, max: 200, value: form.minChars, onChange: (e) => patch({ minChars: Number(e.target.value) }) })),
						field("最多会话数", h("input", { type: "number", min: 1, max: 500, value: form.maxSessions, onChange: (e) => patch({ maxSessions: Number(e.target.value) }) })),
						field("只看最近 N 天", h("input", { type: "number", min: 0, max: 3650, value: form.maxAgeDays, onChange: (e) => patch({ maxAgeDays: Number(e.target.value) }) })),
						field("写作上下文名", h("input", { type: "text", value: form.label, onChange: (e) => patch({ label: e.target.value }) })),
					),
					preview !== null
						? h(
								"div",
								null,
								h(
									"div",
									{ className: "dsws-stats" },
									stat(preview.stats.kept ?? 0, "条样本"),
									stat(preview.stats.chars ?? 0, "字"),
									stat(preview.stats.sessionsScanned ?? 0, "会话已扫"),
									stat(preview.stats.rawUserMessages ?? 0, "原始用户消息"),
									stat(preview.stats.workspaceCount ?? 0, "工作区"),
									stat(fmtDay(preview.stats.oldest) + " ~ " + fmtDay(preview.stats.newest), "时间范围"),
								),
								h(
									"ul",
									{ className: "dsws-list" },
									...(preview.head ?? []).map((s, i) =>
										h("li", { className: "dsws-item", key: i },
											h("div", null,
												h("div", { className: "dsws-mono" }, `${fmtTime(s.time)} · ${s.chars} 字 · ${s.title || "（无标题）"}`),
												h("div", { style: { marginTop: 4, lineHeight: 1.6 } }, s.preview),
											),
										),
									),
								),
							)
						: null,
					h(
						"div",
						{ className: "dsws-actions" },
						h("button", { className: "dsws-btn", disabled: busy, onClick: doPreview }, "预览采样"),
						h("button", { className: "dsws-btn", disabled: busy, onClick: () => saveConfig() }, "保存配置"),
					),
				),

				// ── 蒸馏 ──────────────────────────────────────────────
				h(
					"div",
					{ className: "dsws-card" },
					h("h3", null, "蒸馏"),
					h("div", { className: "dsws-desc" },
						"用模型把样本归纳成风格档案（Overall voice / Common patterns / Do and avoid）。留空则自动沿用你最近一次会话用过的模型。",
					),
					autoModelHint(llm),
					h(
						"div",
						{ className: "dsws-row" },
						field("provider", h("input", { type: "text", placeholder: "留空 = 自动", value: form.provider, onChange: (e) => patch({ provider: e.target.value }) })),
						field("model", h("input", { type: "text", placeholder: "留空 = 自动", value: form.model, onChange: (e) => patch({ model: e.target.value }) })),
						field("技能目录", h("input", { type: "text", style: { minWidth: 280 }, value: form.skillsDir, onChange: (e) => patch({ skillsDir: e.target.value }) })),
					),
					h(
						"div",
						{ className: "dsws-actions" },
						h("button", { className: "dsws-btn dsws-btn-primary", disabled: busy || (job !== null && job.status === "running"), onClick: doLearn }, "开始学习我的写作风格"),
					),
					job !== null ? progressBlock(job) : null,
				),

				// ── 产物 ──────────────────────────────────────────────
				h(
					"div",
					{ className: "dsws-card" },
					h("h3", null, `已生成的写作风格技能（${skills.length}）`),
					skills.length === 0
						? h("div", { className: "dsws-desc", style: { margin: 0 } }, "还没有。点上面的按钮做一次学习即可生成。")
						: h(
								"ul",
								{ className: "dsws-list" },
								...skills.map((s) =>
									h("li", { className: "dsws-item", key: s.slug },
										h("div", null,
											h("b", null, s.slug),
											h("div", { className: "dsws-mono", style: { marginTop: 3 } }, `${fmtTime(s.updatedAt)} · ${s.dir}`),
											s.description ? h("div", { style: { marginTop: 4, lineHeight: 1.6 } }, s.description) : null,
										),
										h("button", { className: "dsws-btn", disabled: busy, onClick: () => removeSkill(s.slug) }, "删除"),
									),
								),
							),
				),

				note !== null ? h("div", { className: `dsws-note dsws-note-${note.kind}` }, note.text) : null,
			);
		}

		function field(label, control) {
			return h("div", { className: "dsws-field" }, h("label", null, label), control);
		}
		function stat(value, label) {
			return h("div", { className: "dsws-stat" }, h("b", null, String(value)), h("span", null, label));
		}
		function autoModelHint(llm) {
			const eff = llm?.effective;
			const txt = eff?.provider && eff?.model ? `自动：${eff.provider} / ${eff.model}` : "自动：暂未探测到（跑过一次会话后可用）";
			const provs = (llm?.providers ?? []).map((p) => p.id).filter(Boolean);
			return h("div", { className: "dsws-mono", style: { marginTop: 6 } }, txt + (provs.length > 0 ? ` · 可用提供方：${provs.join(", ")}` : ""));
		}
		function progressBlock(job) {
			const pct = PHASES[job.phase] ?? (job.status === "done" ? 100 : 10);
			const d = job.detail ?? {};
			return h(
				"div",
				null,
				h("div", { className: "dsws-progress" }, h("i", { style: { width: `${pct}%` } })),
				h(
					"div",
					{ className: `dsws-note ${job.status === "failed" ? "dsws-note-err" : job.status === "done" ? "dsws-note-ok" : "dsws-note-info"}` },
					job.status === "running" ? `进行中：${job.phase}` : job.status === "done" ? "完成" : "失败",
					d.sampleCount ? ` · 样本 ${d.sampleCount} 条 / ${d.sampleChars ?? 0} 字` : "",
					d.provider ? ` · ${d.provider}/${d.model}` : "",
					job.error ? ` · ${job.error}` : "",
					job.result?.slug ? ` · 已写入 ${job.result.slug}` : "",
				),
				job.result !== null && job.result?.overallVoice
					? h("div", { className: "dsws-note dsws-note-info" }, job.result.overallVoice)
					: null,
			);
		}

		/** Browser half entry：挂到「设置 → 插件」本插件那一行的 tab 上。 */
		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("settings.plugins.tab", () =>
				ctx.slots.register(
					{
						name: "settings.plugins.tab",
						id: "dsh-writing-style",
						order: 20,
						label: () => "写作风格",
					},
					Panel,
				),
			);
		}

		exports.name = "dsh-writing-style";
		exports.inject = ["slots"];
		exports.apply = apply;

		return module.exports;
	},
});
