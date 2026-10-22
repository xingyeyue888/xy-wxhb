/**
 * api.js —— ComfyUI 本地客户端
 * 只依赖官方 HTTP 接口：/object_info /api/userdata /api/prompt /history /view /upload/image
 */

let BASE = "http://127.0.0.1:8188";

export const setBase = (u) => { BASE = (u || "").replace(/\/+$/, ""); };
export const getBase = () => BASE;

class ComfyError extends Error {
  constructor(msg, detail) { super(msg); this.detail = detail; this.name = "ComfyError"; }
}
export { ComfyError };

async function req(path, opts = {}, timeout = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new ComfyError(pickError(data) || `HTTP ${res.status}`, data);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new ComfyError("请求超时（ComfyUI 无响应）");
    if (e instanceof ComfyError) throw e;
    throw new ComfyError("连不上 ComfyUI：" + e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** 把 ComfyUI 的 node_errors 压成一句人话 */
function pickError(data) {
  if (!data || typeof data !== "object") return typeof data === "string" ? data.slice(0, 200) : "";
  const ne = data.node_errors || {};
  const first = Object.values(ne)[0];
  if (first?.errors?.length) {
    const e = first.errors[0];
    const ct = first.class_type ? `${first.class_type}：` : "";
    const info = e.extra_info || {};
    const extra = info.input_name ? `（${info.input_name}）` : "";
    return `${ct}${e.message}${extra}`;
  }
  if (data.error?.message) return data.error.message;
  return "";
}

/* ---------------- 基础 ---------------- */
export const systemStats = () => req("/system_stats", {}, 8000);
export const objectInfo = () => req("/object_info", {}, 120000);

/* ---------------- 工作流文件（user/default/workflows） ----------------
   ⚠️ 这几个接口一律 no-store + 时间戳：
   ComfyUI 的 /api/userdata 走 web.FileResponse，带着 Etag 和 Last-Modified，
   又没有 Cache-Control，浏览器会按「最后修改时间的 10%」做启发式缓存。
   结果就是：在 ComfyUI 里改完工作流（启用 LoRA、换素材），画布刷新还拿到老版本。
   这里的读写必须是磁盘上的真实内容，不能让浏览器插一脚。 */
const bust = (path) => path + (path.includes("?") ? "&" : "?") + "_=" + Date.now();
const wfPath = (relPath) => "/api/userdata/" + encodeURIComponent("workflows/" + relPath);

/** 列出 user/default/workflows 下的所有工作流文件 */
export async function listWorkflows() {
  const files = await req(bust("/api/userdata?dir=workflows&recurse=true"), { cache: "no-store" }, 20000);
  return (Array.isArray(files) ? files : []).filter(f => /\.json$/i.test(f));
}

export const getWorkflow = (relPath) =>
  req(bust(wfPath(relPath)), { cache: "no-store" }, 30000);

/** 只取文件头：最后修改时间 + Etag，用来判断 ComfyUI 那边有没有更新 */
export async function getWorkflowMeta(relPath) {
  const res = await fetch(BASE + bust(wfPath(relPath)), { method: "HEAD", cache: "no-store" });
  if (!res.ok) throw new ComfyError(`HTTP ${res.status}`);
  const lm = res.headers.get("Last-Modified") || "";
  const t = lm ? Date.parse(lm) : NaN;
  return { mtime: Number.isFinite(t) ? t : 0, etag: res.headers.get("Etag") || "" };
}

/**
 * 写回工作流文件（把画布上的启停 / LoRA 参数同步给 ComfyUI）。
 * 排版跟 ComfyUI 自己存的一致：单行紧凑 JSON，不缩进。
 * 以前这里用 2 空格缩进，同一个文件被画布存一次就 84 KB → 144 KB、
 * ComfyUI 存一次又缩回去，两边来回跳（内容等价，只是排版打架）。
 */
export async function saveWorkflow(relPath, obj) {
  return req(wfPath(relPath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
    cache: "no-store",
  }, 30000);
}

/** 往 user/default 下任意位置写一个文本文件（备份用） */
export async function putUserFile(relPath, text) {
  return req("/api/userdata/" + encodeURIComponent(relPath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
    cache: "no-store",
  }, 30000);
}

/* ---------------- 执行 ---------------- */
export async function submit(prompt, clientId = "xy-wxhb") {
  const r = await req("/api/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: clientId }),
  }, 60000);
  return r.prompt_id;
}

export const queueState = () => req("/api/queue", {}, 8000);

/**
 * 中断执行。带上 prompt_id 时只打这一个（新版 ComfyUI 支持；
 * 老版本会忽略这个字段，退回「中断当前正在跑的」）
 */
export async function interrupt(promptId = "") {
  const body = promptId ? { prompt_id: promptId } : {};
  try { await req("/api/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 8000); } catch { }
}

/** 从排队里撤掉一个还没开始的 prompt（提交完立刻点停止时走这条） */
export async function deleteQueued(promptId) {
  if (!promptId) return;
  try {
    await req("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    }, 8000);
  } catch { }
}

/** 轮询一次历史；返回 null 表示还没跑完 */
export async function pollHistory(promptId) {
  const h = await req(`/history/${promptId}`, {}, 15000);
  const rec = h?.[promptId];
  if (!rec) return null;
  const status = rec.status || {};
  if (status.status_str === "error" || status.completed === false && status.status_str === "error") {
    return { done: true, error: status.messages?.find(m => m[0] === "execution_error")?.[1]?.exception_message || "执行失败", raw: rec };
  }
  return { done: true, error: null, raw: rec, outputs: rec.outputs || {} };
}

/**
 * 等一个任务跑完。onTick 用来刷新进度提示。
 * 返回 {images:[{filename,subfolder,type}], videos:[...], gifs:[...], texts:[...], raw}
 */
export function waitFor(promptId, { interval = 900, onTick, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const stop = () => { stopped = true; };
    if (signal) signal.addEventListener("abort", () => { stop(); reject(new ComfyError("已取消")); });
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await pollHistory(promptId);
        if (r?.done) {
          if (r.error) return reject(new ComfyError(r.error, r.raw));
          return resolve(collect(r.outputs));
        }
        onTick?.("运行中…");
      } catch (e) {
        /* 历史还没写入时 404/空都当没完成，继续等 */
        if (e instanceof ComfyError && /404|not found/i.test(e.message)) { /* ignore */ }
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** 从 history.outputs 里抽取所有可展示的产出 */
export function collect(outputs) {
  const images = [], videos = [], gifs = [], texts = [];
  for (const [nodeId, out] of Object.entries(outputs || {})) {
    for (const key of ["images", "gifs", "videos"]) {
      const arr = out?.[key];
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        if (!f?.filename) continue;
        const item = { node: nodeId, filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" };
        if (/\.(mp4|webm|mkv|mov)$/i.test(f.filename)) videos.push(item);
        else if (/\.gif$/i.test(f.filename)) gifs.push(item);
        else images.push(item);
      }
    }
    if (typeof out?.text === "string") texts.push({ node: nodeId, text: out.text });
    if (Array.isArray(out?.text)) for (const t of out.text) if (typeof t === "string") texts.push({ node: nodeId, text: t });
  }
  return { images, videos, gifs, texts };
}

/** 组装可直接给 <img>/<video> 用的地址 */
export function viewUrl({ filename, subfolder = "", type = "output" }) {
  const q = new URLSearchParams({ filename, subfolder, type });
  return `${BASE}/view?${q.toString()}`;
}

/** 把 ComfyUI 产出里的一个文件取成 Blob（连线时要把上游结果再传回 input） */
export async function fetchBlob(item) {
  const res = await fetch(viewUrl(item));
  if (!res.ok) throw new ComfyError(`取上游图失败 HTTP ${res.status}`);
  return await res.blob();
}

/* ---------------- 上传 ---------------- */
/** 把本地图片传进 ComfyUI 的 input 目录，返回 ComfyUI 端的文件名 */
export async function uploadImage(file, subfolder = "") {
  const fd = new FormData();
  fd.append("image", file, file.name);
  fd.append("overwrite", "true");
  if (subfolder) fd.append("subfolder", subfolder);
  const r = await req("/upload/image", { method: "POST", body: fd }, 120000);
  return r?.name || file.name;
}

/** 让 ComfyUI 扫一遍 input 目录（上传后确保 LoadImage 能看到新文件） */
export async function refreshCombo() {
  try { await req("/object_info", {}, 60000); } catch { }
}
