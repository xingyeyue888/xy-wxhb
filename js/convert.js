/**
 * convert.js —— ComfyUI「UI 工作流」→「API prompt」转换器
 *
 * 纯函数、零依赖，浏览器与 node 都能跑。
 * 原则：
 *   1. 只依赖 /object_info，不猜；
 *   2. 认不出/断链一律记 warnings，绝不静默产出半截 prompt；
 *   3. 值优先级：widgets_values_named > widgets_values 数组 > object_info 默认值；
 *   4. 特殊链路全部解析：Reroute 透传、SetNode/GetNode 变量、Primitive* 常量、
 *      bypass(mode=4) 输入→输出透传。
 */

/* UI 里存在、但不是真实计算节点的类型 */
const UI_ONLY = new Set([
  "Note", "MarkdownNote", "Reroute", "PrimitiveNode",
  "Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)",
  "Label (rgthree)", "Bookmark (rgthree)", "Note Plus (mtb)",
  "Image Comparer (rgthree)", "孤海注释", "SetNode", "GetNode",
]);

/* object_info 里没有、但确实只用来提供一个常量的节点 */
const VALUE_NODE = /^(PrimitiveNode|PrimitiveInt|PrimitiveFloat|PrimitiveString|PrimitiveBoolean|PrimitiveBoundingBox|PrimitiveText)$/;

const SCALAR_WIDGET = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/* ComfyUI 新版动态下拉：spec 形如
   ["COMFY_DYNAMICCOMBO_V3", {options:[{key:"png", inputs:{required:{bit_depth:["COMBO",…]}}}]}]
   选中某个 key 后，它的子输入会以「format.bit_depth」这种扁平点号键进 API。 */
const DYNAMIC_COMBO = /^COMFY_.*COMBO/i;

/**
 * COMBO 值归一化：ComfyUI 会把下拉项显示成「值 — 中文说明」并存进 widgets_values，
 * 而服务端只认纯值。这里按「分隔符前缀 → 严格前缀」两级回退，认不出就原样返回。
 */
export function normalizeCombo(v, choices) {
  if (typeof v !== "string" || !Array.isArray(choices) || !choices.length) return v;
  const opts = choices.map(c => (c && typeof c === "object") ? (c.value ?? c.name ?? c) : c)
    .filter(c => typeof c === "string");
  if (!opts.length) return v;
  if (opts.includes(v)) return v;
  const head = v.split(/\s*[—–\-|｜:：]\s*/)[0].trim();
  if (opts.includes(head)) return head;
  const starts = opts.filter(c => v.startsWith(c)).sort((a, b) => b.length - a.length);
  return starts[0] ?? v;
}

const isWidgetSpec = (spec) => {
  if (!Array.isArray(spec) || spec.length === 0) return false;
  const t = spec[0];
  if (Array.isArray(t)) return true;
  return SCALAR_WIDGET.has(String(t));
};

/** 按 ComfyUI 前端顺序列出 widget 输入 */
export function listWidgets(info) {
  const out = [];
  const inp = info?.input || {};
  const order = info?.input_order || {};
  for (const section of ["required", "optional"]) {
    const sec = inp[section];
    if (!sec) continue;
    const names = order[section]?.length ? order[section] : Object.keys(sec);
    for (const name of names) {
      const spec = sec[name];
      if (!spec) continue;
      const type0 = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);

      /* ---- 动态下拉：自身是一个下拉，另外带一组跟随选项变化的子输入 ---- */
      if (DYNAMIC_COMBO.test(type0)) {
        const opts = (spec[1] && typeof spec[1] === "object") ? spec[1] : {};
        const options = Array.isArray(opts.options) ? opts.options : [];
        const subs = {};
        const keys = [];
        for (const o of options) {
          const key = o?.key ?? o?.name;
          if (key == null) continue;
          keys.push(String(key));
          const list = [];
          for (const s2 of ["required", "optional"]) {
            const m = o?.inputs?.[s2] || {};
            const ord = o?.inputs?.input_order?.[s2];
            const nms = (Array.isArray(ord) && ord.length) ? ord : Object.keys(m);
            for (const nm of nms) {
              const sp = m[nm];
              if (!Array.isArray(sp) || !sp.length) continue;
              const so = (sp[1] && typeof sp[1] === "object") ? sp[1] : {};
              list.push({
                name: nm,
                choices: Array.isArray(sp[0]) ? sp[0] : (Array.isArray(so.options) ? so.options : null),
                default: so.default,
              });
            }
          }
          subs[String(key)] = list;
        }
        out.push({
          name, type: "COMBO", opts, extraAfter: false, dynamic: true,
          default: opts.default, choices: keys, subs,
        });
        continue;
      }

      if (!isWidgetSpec(spec)) continue;
      const opts = (spec.length > 1 && spec[1] && typeof spec[1] === "object") ? spec[1] : {};
      out.push({
        name, type: type0, opts,
        extraAfter: Object.prototype.hasOwnProperty.call(opts, "control_after_generate"),
        default: opts.default,
        min: opts.min, max: opts.max, step: opts.step,
        choices: Array.isArray(spec[0]) ? spec[0]
          : (Array.isArray(opts.options) ? opts.options : null),
      });
    }
  }
  return out;
}

/** 连接型输入（参数面板要过滤掉这些） */
export function listLinks(info) {
  const out = [];
  const inp = info?.input || {};
  for (const section of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(inp[section] || {})) {
      const t = Array.isArray(spec?.[0]) ? "COMBO" : String(spec?.[0] ?? "");
      if (DYNAMIC_COMBO.test(t)) continue;         // 动态下拉是 widget，不是连线
      if (!isWidgetSpec(spec)) out.push({ name, type: t });
    }
  }
  return out;
}

/**
 * 主转换
 * @returns {{prompt:object, warnings:string[], missingNodes:string[], stats:object}}
 */
export function convertWorkflow(ui, objectInfo) {
  const warnings = [];
  const missingNodes = [];
  if (!ui || !Array.isArray(ui.nodes)) throw new Error("不是有效的 UI 格式工作流（缺少 nodes）");

  const nodeById = new Map(ui.nodes.map(n => [String(n.id), n]));
  const linkSrc = new Map();
  for (const l of ui.links || []) {
    if (Array.isArray(l) && l.length >= 5) linkSrc.set(l[0], [String(l[1]), l[2]]);
  }

  /* 子图：暂不支持，但要说清楚 */
  const subgraphs = ui?.definitions?.subgraphs;
  if (Array.isArray(subgraphs) && subgraphs.length) {
    const used = ui.nodes.filter(n => subgraphs.some(s => String(s.id) === String(n.type)));
    if (used.length) warnings.push(`含 ${used.length} 个子图(subgraph)节点，暂不支持，已跳过`);
  }

  /* SetNode/GetNode：变量赋值与取值 */
  const setMap = new Map();
  for (const n of ui.nodes) {
    if (n.type !== "SetNode") continue;
    const name = (n.widgets_values || [])[0];
    const link = (n.inputs || [])[0]?.link;
    if (name != null) setMap.set(name, link);
  }

  const isBypass = (n) => n.mode === 4;
  const isMute = (n) => n.mode === 2;

  /** 把「某个输出槽」解析成最终的 [节点id, 槽位] 或 {value}，沿途穿透 Reroute/GetNode/bypass/Primitive */
  const resolveOut = (nodeId, slot, guard = 0) => {
    if (guard > 128) return null;
    const n = nodeById.get(String(nodeId));
    if (!n) return null;

    if (VALUE_NODE.test(n.type)) {
      const v = Array.isArray(n.widgets_values) ? n.widgets_values[0] : n.widgets_values;
      return { value: v };
    }
    if (n.type === "Reroute") {
      const lk = (n.inputs || [])[0]?.link;
      const s = lk != null ? linkSrc.get(lk) : null;
      return s ? resolveOut(s[0], s[1], guard + 1) : null;
    }
    if (n.type === "GetNode") {
      const name = (n.widgets_values || [])[0];
      const lk = setMap.get(name);
      const s = lk != null ? linkSrc.get(lk) : null;
      return s ? resolveOut(s[0], s[1], guard + 1) : null;
    }
    if (isMute(n)) return { disabled: true };
    if (isBypass(n)) {
      /* bypass：同类型输入直接透传到输出；若本身是源节点（如被禁用的 LoadImage），输出即不存在 */
      const outType = n.outputs?.[slot]?.type;
      const cand = (n.inputs || []).find(s => {
        if (s.link == null) return false;
        if (!outType) return true;
        return s.type === outType || s.type === "*" || outType === "*";
      }) || (n.inputs || []).find(s => s.link != null);
      if (!cand) return { disabled: true };
      const s = linkSrc.get(cand.link);
      return s ? resolveOut(s[0], s[1], guard + 1) : { disabled: true };
    }
    return [String(n.id), slot];
  };

  const prompt = {};
  let bypassed = 0, muted = 0, danglingInputs = 0;

  for (const n of ui.nodes) {
    const type = n?.type;
    if (!type) continue;
    if (isMute(n)) { muted++; continue; }
    if (isBypass(n)) { bypassed++; continue; }        // 不作为计算节点提交，但输出已可被下游穿透解析
    if (UI_ONLY.has(type)) continue;
    if (VALUE_NODE.test(type)) continue;

    const info = objectInfo?.[type];
    if (!info) { missingNodes.push(type); continue; }

    const inputs = {};

    /* ---- widget 值 ----
       两套数据二选一，绝不混用下标：
       有 widgets_values_named 就全按名字取（缺的用默认值），
       否则才按数组 + 递增下标（含 control_after_generate 的占位）。
       注：少数节点（VHS_LoadAudioUpload 之类）直接把 widgets_values 存成
       {字段名: 值} 对象，这种形态等价于 named，也走按名取。 */
    const namedRaw = (n.widgets_values_named && typeof n.widgets_values_named === "object") ? n.widgets_values_named : null;
    const objRaw = (!Array.isArray(n.widgets_values) && n.widgets_values && typeof n.widgets_values === "object") ? n.widgets_values : null;
    const named = namedRaw || objRaw;
    const arr = Array.isArray(n.widgets_values) ? n.widgets_values : null;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    let idx = 0;
    for (const w of listWidgets(info)) {
      let v;
      if (named) {
        v = has(named, w.name) ? named[w.name] : undefined;
      } else if (arr) {
        v = arr[idx];
        idx += 1 + (w.extraAfter ? 1 : 0);
      }
      if (v === undefined) v = w.default;
      if (v !== undefined) inputs[w.name] = (w.type === "COMBO") ? normalizeCombo(v, w.choices) : v;

      /* 动态下拉的子输入（format.bit_depth 等）：在 API 侧就是扁平点号键 */
      if (!w.subs) continue;
      const subs = w.subs[String(v)] || w.subs[String(w.default)] || [];
      for (const s of subs) {
        const fk = w.name + "." + s.name;
        let sv;
        if (named) sv = has(named, fk) ? named[fk] : undefined;
        else if (arr) { sv = arr[idx]; idx += 1; }
        if (sv === undefined) sv = s.default;
        if (sv !== undefined) inputs[fk] = s.choices ? normalizeCombo(sv, s.choices) : sv;
      }
    }

    /* 非 widget 的必填项若自带默认值（如 BDGROUP 分组），也要带上，否则校验必挂 */
    for (const section of ["required", "optional"]) {
      for (const [name, spec] of Object.entries(info.input?.[section] || {})) {
        if (Object.prototype.hasOwnProperty.call(inputs, name)) continue;
        if (isWidgetSpec(spec)) continue;
        const opts = (Array.isArray(spec) && spec[1] && typeof spec[1] === "object") ? spec[1] : {};
        if (opts.default !== undefined) inputs[name] = opts.default;
      }
    }

    /* ---- 连线输入 ---- */
    const specOf = (nm) => info?.input?.required?.[nm] || info?.input?.optional?.[nm] || null;
    for (const slot of n.inputs || []) {
      if (slot?.link == null) continue;
      const rawName = slot.name;
      if (!rawName) continue;
      const raw = linkSrc.get(slot.link);
      if (!raw) { danglingInputs++; continue; }
      const res = resolveOut(raw[0], raw[1]);
      if (res == null) {
        danglingInputs++;
        warnings.push(`「${n.title || type}」的输入 ${rawName} 链路断开`);
        continue;
      }
      if (res.disabled) continue;                        // 上游被用户 bypass/mute，属预期，不告警
      const val = (typeof res === "object" && "value" in res) ? res.value : [res[0], res[1]];
      /* 键名一律用 UI 里的原名：autogrow 输入（values.a）与动态多输入（images.image_1）
         在 API 侧就是扁平点号键，实测 ComfyUI 只认这种形态 */
      inputs[rawName] = val;
    }

    prompt[String(n.id)] = { class_type: type, inputs, _meta: { title: n.title || type } };
  }

  if (missingNodes.length) {
    warnings.push(`本机未安装这些节点，已跳过：${[...new Set(missingNodes)].join("、")}`);
  }
  return {
    prompt,
    warnings,
    missingNodes: [...new Set(missingNodes)],
    stats: {
      total: ui.nodes.length,
      converted: Object.keys(prompt).length,
      bypassed, muted, danglingInputs,
    },
  };
}

/** 找「产出型」节点，用于把结果挂回画布 */
export function findOutputs(prompt) {
  const out = [];
  for (const [id, node] of Object.entries(prompt)) {
    const ct = node.class_type || "";
    if (/^(SaveImage|PreviewImage|SaveImageAdvanced|PreviewAny|VHS_VideoCombine)$/.test(ct)) out.push([id, ct]);
  }
  return out;
}

/* ==================================================================
   文件名 token 展开
   ComfyUI 前端在提交前会把 filename_prefix 里的 token 换成实值，
   后端不认这些 token。不展开就会出现：
     [WinError 267] 目录名称无效 …\图片\Qwen2.1\%date:yyyy-MM-dd%
   （`:` 在 Windows 路径里非法）
   支持 %date:格式% 与 %节点标题.字段名%
================================================================== */
function formatDate(fmt, d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return String(fmt)
    .replace(/yyyy/g, d.getFullYear())
    .replace(/yy/g, String(d.getFullYear()).slice(2))
    .replace(/MM/g, p2(d.getMonth() + 1))
    .replace(/dd/g, p2(d.getDate()))
    .replace(/HH/g, p2(d.getHours()))
    .replace(/mm/g, p2(d.getMinutes()))
    .replace(/ss/g, p2(d.getSeconds()));
}

export function expandTokens(s, prompt) {
  if (typeof s !== "string" || s.indexOf("%") < 0) return s;
  let out = s.replace(/%date:([^%]+)%/g, (_, f) => formatDate(f));
  if (prompt) {
    out = out.replace(/%([^%%.]+)\.([A-Za-z0-9_.]+)%/g, (m, title, field) => {
      const hit = Object.values(prompt).find(n => (n._meta?.title || n.class_type) === title);
      const v = hit?.inputs?.[field];
      return (v === undefined || v === null || typeof v === "object") ? m : String(v);
    });
  }
  return out;
}

/** 提交前跑一遍，把 prompt 里所有字符串参数上的 token 展开 */
export function expandPromptTokens(prompt) {
  for (const nd of Object.values(prompt || {})) {
    for (const [k, v] of Object.entries(nd.inputs || {})) {
      if (typeof v === "string" && v.includes("%")) nd.inputs[k] = expandTokens(v, prompt);
    }
  }
  return prompt;
}
