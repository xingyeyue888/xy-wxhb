/**
 * app.js —— 本地无限画布主程序
 */
import * as api from "./api.js";
import { convertWorkflow, listWidgets, normalizeCombo, expandPromptTokens } from "./convert.js";
import { CanvasView } from "./canvas.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const LS_KEY = "xy-wxhb:v1";

const S = {
  base: localStorage.getItem("xy-wxhb.base") || "http://127.0.0.1:8188",
  oi: null,
  workflows: [],
  nodes: [],                    // 运行时节点对象
  edges: [],                    // [{from,to,key}] key=null 表示「整节点流向内容节点」
  seq: 1,
  kindFilter: "all",
  search: "",
  restoring: false,             // 正在从 localStorage 恢复节点
  /* 参数格 / 模型格的排列顺序：{ 工作流文件名: { param: [字段key…], model: […] } }。
     按文件记而不是按节点记 —— 同一个工作流删掉再加回来，排好的顺序还在 */
  orders: {},
  lib: {                        // 素材库
    tab: localStorage.getItem("xy-wxhb.tab") || "wf",
    kind: localStorage.getItem("xy-wxhb.libkind") || "input",
    project: "",
    projects: [],
    items: [],
    root: null,
    sel: new Set(),             // 勾选中的素材（key = 子目录|文件名）
  },
};

let view;                       // CanvasView 实例

/* 任何没接住的异常都摆到界面上，别让它静默坏掉 */
function showFatal(msg) {
  const tip = document.getElementById("empty-tip");
  if (tip) {
    tip.classList.remove("hide");
    tip.innerHTML = `<div class="empty-icon">⚠</div><p>出错了：${String(msg).slice(0, 300)}</p>
      <p class="dim">按 F12 看控制台，或把这行发给薇拉</p>`;
  }
}
window.addEventListener("error", (e) => showFatal(e.message || e.error));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || e.reason));

/* ==================================================================
   工具
================================================================== */
const uid = () => "n" + (S.seq++) + "_" + Math.random().toString(36).slice(2, 6);

function toast(msg, type = "", ms = 3200) {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("#toast-wrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .2s"; setTimeout(() => el.remove(), 220); }, ms);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* 工作流归「生图 / 视频」只看名字：h3 那套（文生视频 / 双采样 / 导演台 / 动作迁移）
   清一色是跑视频的，名字里不一定带「视频」，所以模型名也算进去 */
function isVideoName(n) {
  return /视频|video|数字人|对口型|动作迁移|跳舞|短剧|ltx|wan|hunyuan|animate|svd|h3|minimax/i.test(n || "");
}

/* ==================================================================
   启动
   ⚠️ init() 必须放在文件最后调用：模块顶层的 let（saveTimer 等）在
   声明行执行前处于暂时性死区，提前 init 会让 scheduleSave 抛
   ReferenceError，并且被 restore 的 catch 吞掉，表现为「刷新后画布空了」。
================================================================== */

function init() {
  $("#comfy-url").value = S.base;
  api.setBase(S.base);

  view = new CanvasView({
    stage: $("#stage"),
    world: $("#world"),
    nodesEl: $("#nodes"),
    edgesEl: $("#edges"),
    /* 选中数量变了 → 底部批量操作条跟着显隐 */
    onSelect: (sel) => updateSelBar(sel),
    /* 注意：CanvasView 构造期间就会回调 onChange，此时 view 还没赋值 */
    onChange: () => {
      if (!view) return;
      S.view = view.view;
      scheduleSave();
    },
    /* 拖右下角改大小 → 让提示词框跟着长（拖的每一帧都来一次，所以只看尺寸不算别的） */
    onResize: (id) => fitTextBoxes(S.nodes.find(n => n.id === id)),
  });

  view.setEdges(S.edges);

  bindUI();
  /* 恢复界面级背景设置：日间标志在 localStorage；背景图在 IndexedDB（异步） */
  applyDay(localStorage.getItem("xy-wxhb.day") === "1");
  /* 老版本把背景图存进过 localStorage，爆过配额——见到就清掉，把空间还给画布存档 */
  localStorage.removeItem("xy-wxhb.bgimg");
  bgIdb("get").then(bg => { if (bg) applyBgImg(bg); }).catch(() => { });
  restore();             // 先恢复画布
  connect();             // 再连 ComfyUI（连上后刷新工作流列表 + 恢复节点）
  /* 每 20 秒问一次工作流文件的修改时间：在 ComfyUI 里改了东西（启用 LoRA 之类），
     画布自己读回来跟上，不用整页刷新，也不用再点 ⟳ */
  startStaleWatch();
  document.addEventListener("visibilitychange", () => {
    /* 切去别的标签页 → 攒着的改动立刻落地，别等停手 3 秒 */
    if (document.hidden) flushPendingPushes();
    else checkWorkflowStale();
  });
  window.addEventListener("pagehide", () => flushPendingPushes());
  bindAutoPushOnClickAway();
}

/* ==================================================================
   素材节点：文本 / 图像 / 视频 / 音频
   这四类节点是「源」，产出可以拖线喂给工作流节点。
================================================================== */
const IN_KINDS = {
  text:  { label: "文本输入", short: "文", ico: "📝", accept: "",        otype: "text",  desc: "写提示词 / 台词" },
  image: { label: "图像输入", short: "图", ico: "🖼", accept: "image/*", otype: "image", desc: "png / jpg / webp" },
  video: { label: "视频输入", short: "视", ico: "🎬", accept: "video/*", otype: "video", desc: "mp4 / webm / mov" },
  audio: { label: "音频输入", short: "音", ico: "🎵", accept: "audio/*", otype: "audio", desc: "mp3 / wav / flac" },
};

/* ==================================================================
   UI 绑定
================================================================== */
function bindUI() {
  /* 侧栏折叠 */
  const appEl = $(".app");
  const setSide = (collapsed) => {
    appEl.classList.toggle("side-collapsed", collapsed);
    const b = $("#btn-toggle-side");
    b.textContent = collapsed ? "»" : "«";
    b.title = (collapsed ? "展开" : "折叠") + "侧栏 (Ctrl+B)";
    localStorage.setItem("xy-wxhb.side", collapsed ? "1" : "0");
    /* 侧栏宽度变了，画布可视区跟着变，线要重算 */
    requestAnimationFrame(() => view.scheduleEdges());
  };
  $("#btn-toggle-side").onclick = () => setSide(!appEl.classList.contains("side-collapsed"));
  appEl.addEventListener("transitionend", (e) => {
    if (e.propertyName === "grid-template-columns") view.scheduleEdges();
  });
  setSide(localStorage.getItem("xy-wxhb.side") === "1");

  /* 侧栏页签：工作流 / 素材库 */
  const setTab = (tab) => {
    S.lib.tab = tab;
    localStorage.setItem("xy-wxhb.tab", tab);
    $$(".side-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    $("#pane-wf").classList.toggle("hide", tab !== "wf");
    $("#pane-lib").classList.toggle("hide", tab !== "lib");
    if (tab === "lib" && !S.lib.root?.ok) libInit();
  };
  $$(".side-tab").forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
  $$("#lib-kinds .chip").forEach(c => c.classList.toggle("active", c.dataset.libkind === S.lib.kind));
  $("#lib-kinds").onclick = (e) => {
    const b = e.target.closest("[data-libkind]");
    if (!b) return;
    S.lib.kind = b.dataset.libkind;
    localStorage.setItem("xy-wxhb.libkind", S.lib.kind);
    S.lib.project = "";
    S.lib.sel.clear();
    $$("#lib-kinds .chip").forEach(c => c.classList.toggle("active", c === b));
    if (!S.lib.root?.ok) libInit(); else libLoadProjects();
  };
  $("#btn-lib-refresh").onclick = () => (S.lib.root?.ok ? libLoadProjects() : libInit());
  $("#btn-lib-upload").onclick = libUpload;
  $("#btn-lib-newproj").onclick = libNewProject;

  /* 批量删除：全选 / 反选 / 删 / 取消 */
  $("#lib-sel-all").onclick = () => { for (const it of S.lib.items) S.lib.sel.add(libKey(it)); renderLibItems(); };
  $("#lib-sel-inv").onclick = () => {
    for (const it of S.lib.items) {
      const k = libKey(it);
      if (S.lib.sel.has(k)) S.lib.sel.delete(k); else S.lib.sel.add(k);
    }
    renderLibItems();
  };
  $("#lib-sel-del").onclick = libDeleteMany;
  $("#lib-sel-cancel").onclick = () => { S.lib.sel.clear(); renderLibItems(); };
  setTab(S.lib.tab);

  /* 素材节点入口 */
  $$(".add-btn").forEach(b => {
    b.onclick = () => addInputNode(b.dataset.inkind, null);
  });

  $("#btn-connect").onclick = () => {
    S.base = $("#comfy-url").value.trim() || "http://127.0.0.1:8188";
    api.setBase(S.base);
    localStorage.setItem("xy-wxhb.base", S.base);
    connect();
  };
  $("#comfy-url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-connect").click(); });

  $("#btn-fit").onclick = () => view.fitToContent();
  $("#btn-day").onclick = () => applyDay(!document.body.classList.contains("day"));
  $("#btn-bgimg").onclick = () => {
    const el = $("#bgimg");
    if (el.classList.contains("hide")) pickBgImg();
    else if (confirm("清除自定义背景图，回到网格底色？")) applyBgImg(null);
  };
  $("#btn-clear").onclick = () => {
    if (!confirm("清空画布上的所有节点？（不影响 ComfyUI 里的工作流文件）")) return;
    S.nodes = [];
    S.edges = [];
    S.restoring = false;
    view.setEdges(S.edges);
    view.clear();
    $("#empty-tip").classList.remove("hide");
    save();
  };
  $("#btn-export").onclick = exportCanvas;
  $("#btn-import").onclick = () => $("#file-import").click();
  $("#file-import").onchange = importCanvas;

  $("#wf-search").oninput = (e) => { S.search = e.target.value.trim().toLowerCase(); renderWorkflowList(); };
  $("#wf-filter").onclick = (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    $$("#wf-filter .chip").forEach(c => c.classList.toggle("active", c === b));
    S.kindFilter = b.dataset.kind;
    renderWorkflowList();
  };
  $("#btn-refresh-wf").onclick = () => loadWorkflows(true);

  $$(".hud-btn").forEach(b => b.onclick = () => {
    const r = $("#stage").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (b.dataset.zoom === "in") view.zoomAt(1.2, cx, cy);
    else if (b.dataset.zoom === "out") view.zoomAt(1 / 1.2, cx, cy);
    else view.setView({ k: 1 });
  });

  /* 快捷键 */
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      $("#btn-toggle-side").click();
      return;
    }
    if (e.target.matches?.("input, textarea, select, [contenteditable]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "c") {
      if (view.selected.size) { e.preventDefault(); copySelection(); }
      return;
    }
    if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClip(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); return; }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      view.selectMany(S.nodes.map(n => n.id));
      return;
    }
    if (e.key === "Escape") { view.clearSelection(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (!view.selected.size) return;
      e.preventDefault();
      const n = removeNodes([...view.selected]);
      if (n > 1) toast(`已删除 ${n} 个节点`, "ok");
    }
    if (e.key === "f" || e.key === "F") view.fitToContent();
  });

  /* 批量操作条 */
  $("#sel-copy").onclick = () => copySelection();
  $("#sel-dup").onclick = () => duplicateSelection();
  $("#sel-del").onclick = () => {
    const n = removeNodes([...view.selected]);
    if (n) toast(`已删除 ${n} 个节点`, "ok");
  };
  $("#sel-close").onclick = () => view.clearSelection();

  /* 拖文件到画布 → 建素材节点；从素材库拖进来 → 直接建内容节点 */
  $("#stage").addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  $("#stage").addEventListener("drop", (e) => {
    e.preventDefault();
    const raw = e.dataTransfer?.getData("application/x-xy-lib");
    if (raw) {
      try { addLibNode(JSON.parse(raw), e.clientX, e.clientY); return; } catch { }
    }
    const f = e.dataTransfer?.files?.[0];
    if (f) addMediaFileNode(f, e.clientX, e.clientY);
  });

  /* 向前连线：从「那一格」自己的输入口往外拖 —— 素材卡 / 提示词字段都算
     松手在别的输出口上 = 直接把那条线接过来
     松手在空白处   = 就在松手的位置建一个对应类型的素材节点并接上 */
  document.addEventListener("pointerdown", (e) => {
    if (view._spaceDown) return;              // 空格按着 = 框选，别抢去拉线
    const p = e.target.closest('.port[data-kind="in"]');
    if (!p) return;
    /* 内容节点 / 素材节点左边缘那个「接收产出」的口：点它是断开，不是往前拉素材 */
    if (p.classList.contains("in-edge")) return;
    const itype = p.dataset.itype || "";
    if (!IN_KINDS[itype]) return;                 // media 口（内容节点的展示口）不参与
    const rest = (p.dataset.port || "").slice(3); // <nodeId>:<key>
    const i = rest.indexOf(":");
    if (i < 0) return;
    const toId = rest.slice(0, i), key = rest.slice(i + 1);
    const target = S.nodes.find(n => n.id === toId);
    if (!target) return;

    /* 已接线的格子也能往外拉：拖出去 = 换一个来源（没拖动的那一下不动它） */
    e.preventDefault();
    e.stopPropagation();
    document.body.style.cursor = "crosshair";
    view.showTempEdge(p, e.clientX, e.clientY);

    const outs = [...document.querySelectorAll('.port[data-kind="out"]')];
    const fits = (x) => x.dataset.otype === itype || x.dataset.otype === "media";
    outs.forEach(x => x.classList.add(fits(x) ? "connectable" : "dim"));
    const sx = e.clientX, sy = e.clientY;

    const move = (ev) => {
      view.showTempEdge(p, ev.clientX, ev.clientY);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port[data-kind="out"]');
      outs.forEach(x => x.classList.toggle("port-drop", x === over && fits(x)));
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      outs.forEach(x => x.classList.remove("connectable", "dim", "port-drop"));
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port[data-kind="out"]');
      if (over) {
        if (!fits(over)) { toast("类型对不上：这条线接不进这一格", "err"); view.scheduleEdges(); return; }
        const fromId = over.dataset.port.slice(4);
        if (fromId === toId) { toast("不能连到自己", "err"); view.scheduleEdges(); return; }
        connectEdge(fromId, target, key, itype);
        return;
      }
      /* 只是点了一下（没拖动）：别凭空造出一个节点来 */
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) { view.scheduleEdges(); return; }
      /* 空白处松手 → 往前接一个新素材节点 */
      createPulledInput(target, key, itype, ev.clientX, ev.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  /* 拖线：从输出端口拖到能接这种数据类型的输入口 */
  document.addEventListener("pointerdown", (e) => {
    if (view._spaceDown) return;              // 空格按着 = 框选，别抢去拉线
    const p = e.target.closest(".port");
    if (!p || p.dataset.kind !== "out") return;
    e.preventDefault();
    e.stopPropagation();
    const fromId = p.dataset.port.slice(4);
    const otype = p.dataset.otype || "image";
    /* 不能在拖动中展开折叠面板：布局一挪，目标端口就跑了，松手必然落空。
       面板默认是展开的，用户自己折了才需要提示一句。 */
    const hidden = document.querySelectorAll(`#nodes details:not([open]) .port[data-kind="in"][data-itype="${otype}"]`).length;
    if (hidden) toast(`有 ${hidden} 个输入口在折叠的面板里，先展开那个节点才能连上`, "", 3000);
    const ins = [...document.querySelectorAll('.port[data-kind="in"]')];
    /* 精确分流：生图流的输出口只亮图片输入口、视频流只亮视频输入口；
       工作流产出的类型判不了（标了 media）时才万能试，
       连到具体类型的素材节点上时，跑完真对不上会提示，不会硬塞 */
    const fits = (x) => otype === "media" || x.dataset.itype === otype || x.dataset.itype === "media";
    const okIns = ins.filter(fits);
    ins.forEach(x => x.classList.add(fits(x) ? "connectable" : "dim"));
    /* 没有匹配的口不拦着：精确类型拖到空白处会列出「能吃这种素材」的工作流
       （一个都没有才退回「落一个素材节点」）；
       只有「类型判不了（media）」时才提示，那种拖空白也建不了 */
    if (!okIns.length && otype === "media") toast("画布上没有能接产出的输入口；这个工作流产出的类型判不了，请连到具体素材节点", "", 3200);
    document.body.style.cursor = "crosshair";
    view.showTempEdge(p, e.clientX, e.clientY);
    const sx = e.clientX, sy = e.clientY;

    const move = (ev) => {
      view.showTempEdge(p, ev.clientX, ev.clientY);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port[data-kind="in"]');
      ins.forEach(x => x.classList.toggle("port-drop", x === over && fits(x)));
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      ins.forEach(x => x.classList.remove("connectable", "dim", "port-drop"));
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port[data-kind="in"]');
      if (!target) {
        /* 只是点了一下（没拖动）：别凭空造出一个节点来 */
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) { view.scheduleEdges(); return; }
        if (otype === "media") {
          toast("这个工作流的产出类型判不了，把线拖到具体的素材节点上", "");
          view.scheduleEdges();
          return;
        }
        /* 空白处松手 → 不再塞一个「素材接素材」的空节点，
           而是列出「能吃这种素材」的工作流让人挑，挑中就把素材接到它的空槽上 */
        view.setEdges(S.edges);            // 先把拖拽的临时线擦掉，再弹清单
        const w = view.screenToWorld(ev.clientX, ev.clientY);
        openWfPicker({
          kind: otype, fromId, at: { x: w.x, y: w.y }, sx: ev.clientX, sy: ev.clientY,
          fallback: () => pullIntoInputNode(fromId, otype, w),
        });
        return;
      }
      if (!fits(target)) {
        toast(`类型对不上：这里是「${IN_KINDS[target.dataset.itype]?.label?.replace("输入", "") || target.dataset.itype}」输入`, "err");
        view.scheduleEdges();
        return;
      }
      const rest = target.dataset.port.slice(3);          // <nodeId>:<key> 或 <nodeId>
      const i = rest.indexOf(":");
      const toId = i < 0 ? rest : rest.slice(0, i);
      const key = i < 0 ? null : rest.slice(i + 1);
      if (toId === fromId) { toast("不能连到自己", "err"); view.scheduleEdges(); return; }
      S.edges = S.edges.filter(x => !(x.to === toId && x.key === key));   // 一个输入只接一条
      S.edges.push({ from: fromId, to: toId, key, type: otype });
      view.setEdges(S.edges);
      const to = S.nodes.find(n => n.id === toId);
      if (to) renderNode(to);        // 输入框换成「来自 X」
      save();
      const recv = to && (to.kind === "content" || to.kind === "input");
      toast(recv
        ? `已连线：跑完「${nodeName(fromId)}」的产出会显示在「${to.name}」里`
        : `已连线：运行「${to?.name || "下游"}」时会自动用上「${nodeName(fromId)}」`, "ok");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/* ==================================================================
   连接 ComfyUI
================================================================== */
async function connect() {
  setConn("off", "连接中…");
  try {
    const st = await api.systemStats();
    const dev = st.devices?.[0] || {};
    const ver = st.system?.comfyui_version || "?";
    setConn("on", "已连接 v" + ver);
    const mem = dev.vram_total ? `${(dev.vram_free / 1024 ** 3).toFixed(1)}/${(dev.vram_total / 1024 ** 3).toFixed(1)}G 空闲` : "";
    $("#gpu-info").textContent = [dev.name?.replace(/^cuda:\d+\s*/, ""), mem].filter(Boolean).join(" · ");
    await loadObjectInfo();
    await loadWorkflows();
    await resumeNodes();
    if (S.lib.tab === "lib") await libInit();
  } catch (e) {
    setConn("err", "连接失败");
    $("#gpu-info").textContent = "";
    toast(e.message, "err", 5000);
  }
}

function setConn(cls, text) {
  const el = $("#conn-state");
  el.className = "conn " + cls;
  el.textContent = text;
}

async function loadObjectInfo() {
  if (S.oi) return S.oi;
  setConn("on", "读取节点定义…");
  S.oi = await api.objectInfo();
  const v = $("#conn-state").textContent;
  setConn("on", v.replace("读取节点定义…", "已连接").replace("已连接 v", "已连接 v"));
  return S.oi;
}

/* ==================================================================
   工作流列表
================================================================== */
async function loadWorkflows(manual = false) {
  try {
    const files = await api.listWorkflows();
    S.workflows = files.map(f => ({
      file: f,
      name: f.replace(/\.json$/i, ""),
      kind: isVideoName(f) ? "video" : "image",
    }));
    resetWfIntake();               // 工作流列表变了：重扫「谁能接什么」
    $("#wf-count").textContent = `${S.workflows.length} 个工作流`;
    renderWorkflowList();
    if (manual) toast(`已扫描到 ${S.workflows.length} 个工作流`, "ok");
  } catch (e) {
    $("#wf-list").innerHTML = `<div class="hint">${esc(e.message)}</div>`;
  }
}

function renderWorkflowList() {
  const box = $("#wf-list");
  const kw = S.search;
  const list = S.workflows.filter(w => {
    if (S.kindFilter === "video" && w.kind !== "video") return false;
    if (S.kindFilter === "image" && w.kind === "video") return false;
    if (S.kindFilter === "other" && w.kind !== "other") return false;
    return !kw || w.name.toLowerCase().includes(kw);
  });
  if (!list.length) { box.innerHTML = `<div class="hint">没有匹配的工作流</div>`; return; }
  box.innerHTML = "";
  for (const w of list) {
    const el = document.createElement("div");
    el.className = "wf-item";
    el.title = w.file;
    el.innerHTML = `
      <span class="wf-ico">${w.kind === "video" ? "🎬" : "🖼"}</span>
      <span class="wf-meta"><span class="wf-name">${esc(w.name)}</span></span>
      <span class="wf-tag ${w.kind === "video" ? "video" : ""}">${w.kind === "video" ? "视频" : "生图"}</span>`;
    el.onclick = () => addWorkflowNode(w, null, null);
    box.appendChild(el);
  }
}

/* ==================================================================
   节点：工作流
================================================================== */
async function addWorkflowNode(wf, at, autoRun = false) {
  if (!S.oi) { toast("还没连上 ComfyUI", "err"); return; }
  const p = at || centerScreen();
  const toastEl = toast(`正在载入「${wf.name}」…`);
  try {
    const uiWf = await api.getWorkflow(wf.file);
    const { prompt, warnings, missingNodes } = convertWorkflow(uiWf, S.oi);
    if (!Object.keys(prompt).length) throw new Error("这个工作流没有可执行的节点" + (missingNodes.length ? `（缺 ${missingNodes.length} 种节点）` : ""));

    const node = {
      id: uid(), kind: "workflow",
      file: wf.file, name: wf.name, wfKind: wf.kind,
      x: p.x, y: p.y,
      uiWf, prompt, params: {},
      wfSig: wfDigest(uiWf), syncAt: Date.now(), fileMtime: 0,
      status: "idle", error: "", notes: warnings, result: null,
    };
    rememberModes(node);
    /* 文件最后修改时间单独问一次 HEAD（不影响出节点，失败就算了） */
    api.getWorkflowMeta(wf.file).then(m => { node.fileMtime = m.mtime; }).catch(() => { });
    S.nodes.push(node);
    mountNode(node);
    view.select(node.id);
    ensureNodeVisible(node);
    $("#empty-tip").classList.add("hide");
    save();
    if (warnings.length) toast(warnings[0], "", 4200);
    if (autoRun) runNode(node);
    return node;
  } catch (e) {
    toast(e.message, "err", 5000);
    return null;
  }
}

/* ==================================================================
   与 ComfyUI 的工作流文件双向同步
   ──────────────────────────────────────────────────────────────────
   以前画布上的「不启用」只在提交副本里把那个素材摘掉：ComfyUI 侧的工作流
   文件原封不动，只要从 ComfyUI 界面直接跑，那个素材照样参与，于是报错。
   现在两边打通：

     · 读：刷新 / 点 ⟳ 一律读磁盘上的 <workflows>/xxx.json（api 层已禁用
           浏览器缓存），在 ComfyUI 里启用/停用 LoRA、改参数，画布能跟上；
     · 写：「不启用 / 启用」素材会把节点的 bypass(mode=4) / 正常(mode=0)
           写回那个工作流文件，写之前先备份到 user/default/xy-wxhb-backup/。

   ⚠️ 双向同步的固有坑：ComfyUI 网页里正在编辑、还没按 Ctrl+S 的那一份
      不归我们管。写回磁盘后，那边再保存会把这次改动盖回去 —— 所以界面上
      给 ⚠ 提示，别在两个窗口里同时改同一个工作流。
================================================================== */
const SYNC_PUSH_KEY = "xy-wxhb.pushmodes";
const syncCfg = { push: localStorage.getItem(SYNC_PUSH_KEY) !== "0" };

/** 结构指纹：节点 id + 类型 + 启停模式，用来判断 ComfyUI 那边有没有变结构 */
function wfDigest(uiWf) {
  if (!uiWf) return "";
  const parts = (uiWf.nodes || []).map(n => `${n.id}:${n.type}:${n.mode ?? 0}`).sort();
  const s = parts.join("|") + "#" + (uiWf.links || []).length;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + "." + s.length.toString(36);
}

const sameVal = (a, b) => a === b
  || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);

/**
 * 画布上改过的参数 vs ComfyUI 的新文件：谁能留下
 * · 文件里没有这个字段了（节点被删 / 被连线顶掉）→ 丢掉画布值
 * · 文件里也变了（用户在 ComfyUI 里改过）→ 以 ComfyUI 为准
 * · 其余原样保留
 */
function mergeParams(oldPrompt, oldParams, newPrompt) {
  const params = {}, conflicts = [], dropped = [];
  for (const [k, mine] of Object.entries(oldParams || {})) {
    const bar = k.indexOf("|");
    if (bar < 0) { dropped.push(k); continue; }
    const nid = k.slice(0, bar), field = k.slice(bar + 1);
    const inputs = newPrompt[nid]?.inputs;
    if (!inputs || !(field in inputs) || Array.isArray(inputs[field])) { dropped.push(k); continue; }
    const now = inputs[field];
    const was = oldPrompt?.[nid]?.inputs?.[field];
    if (was !== undefined && !sameVal(was, now) && !sameVal(mine, now)) {
      conflicts.push({ key: k, was: mine, now });
      continue;
    }
    params[k] = mine;
  }
  return { params, conflicts, dropped };
}

/**
 * 把一份新的工作流快照装进节点：重建 prompt，同时保住画布上的
 * 参数、素材槽、启用/停用名单（这些不在工作流文件里，重来一次会丢）
 */
function adoptWorkflow(node, uiWf, meta) {
  const { prompt, warnings, missingNodes } = convertWorkflow(uiWf, S.oi);
  if (!Object.keys(prompt).length) {
    throw new Error("这个工作流没有可执行的节点" + (missingNodes.length ? `（缺 ${missingNodes.length} 种节点）` : ""));
  }
  const oldPrompt = node.prompt || {};
  const added = Object.keys(prompt).filter(id => !oldPrompt[id]).length;
  const removed = Object.keys(oldPrompt).filter(id => !prompt[id]).length;

  node.uiWf = uiWf;
  node.prompt = prompt;
  /* 画布补出来的加载节点（xy_*）不在工作流文件里，先按记录重建，再合并参数 */
  restoreExtraSlots(node);
  const { params, conflicts, dropped } = mergeParams(oldPrompt, node.params || {}, node.prompt);
  node.params = params;
  if (dropped.length) {
    for (const k of dropped) delete node.params[k];
  }
  node.notes = warnings || [];
  node.wfSig = wfDigest(uiWf);
  if (meta?.mtime) node.fileMtime = meta.mtime;
  node.syncAt = Date.now();
  node.stale = false;

  /* 画布上点过的启停，以画布为准，别让文件把它悄悄改回去：
     · 画布说停用、文件里也是旁路 → 一致
     · 画布说停用、文件里是启用   → 保留，只标成「没写回」（LoRA 段会亮按钮，点一下补写）
     以前这里遇到第二种会把画布的状态丢掉「跟着文件走」——问题是 ComfyUI 那边
     自动保存会把我们写的 mode 盖回去，画布跟着一丢，就成了「点了不启用，过一会儿又自己亮了」。
     画布补出来的加载节点（xy_*）不在文件里，原样留着。 */
  const modes = new Map((uiWf.nodes || []).map(n => [String(n.id), n.mode ?? 0]));
  const prev = node.wfModes || null;
  const ext = new Set((node.extraSlots || []).map(e => e.id));
  const alive = (id) => ext.has(id) || modes.has(id);
  if (node.assetOff) node.assetOff = node.assetOff.filter(alive);
  if (node.assetOn) node.assetOn = node.assetOn.filter(alive);

  wireAssetSlots(node);
  rememberModes(node);       // 记下最终 mode（wireAssetSlots 可能把某个节点救回 0）
  /* 画布上点过启停、文件里却对不上：先记下来，LoRA 段标题上会亮个「没写回」的按钮，
     不用等下次点一次才发现没同步 */
  markUnsynced(node, new Map((node.uiWf.nodes || []).map(n => [String(n.id), n.mode ?? 0])));
  return { added, removed, conflicts, dropped, legacy: !prev };}

/** 记下这次见到的各节点 mode，下次同步时用来判断「是谁改的」 */
function rememberModes(node) {
  const m = {};
  for (const n of node.uiWf?.nodes || []) m[String(n.id)] = n.mode ?? 0;
  node.wfModes = m;
}

/** 点 ⟳ / 刷新恢复时用：从 ComfyUI 重新读一份，装进节点 */
async function syncFromComfy(node, { silent = false } = {}) {
  if (!node || node.kind !== "workflow" || !node.file) return false;
  const name = node.name || node.file;
  try {
    const [uiWf, meta] = await Promise.all([
      api.getWorkflow(node.file),
      api.getWorkflowMeta(node.file).catch(() => null),
    ]);
    const r = adoptWorkflow(node, uiWf, meta);
    renderNode(node);
    save();
    if (!silent) {
      const bits = [];
      if (r.added) bits.push(`新增 ${r.added} 个节点`);
      if (r.removed) bits.push(`移除 ${r.removed} 个节点`);
      if (r.conflicts.length) bits.push(`${r.conflicts.length} 个参数按 ComfyUI 更新`);
      toast(`「${name}」已同步 ComfyUI${bits.length ? "：" + bits.join("，") : "（和上次一样）"}`, "ok", 4200);
    }
    return true;
  } catch (e) {
    if (!silent) toast(`读不到「${name}」的工作流文件：${e.message}`, "err", 5000);
    return false;
  }
}

/* 每次会话每个工作流只备份一次，免得改十次攒十个文件 */
const backedUp = new Set();
async function backupWorkflowOnce(node, snapshot) {
  if (backedUp.has(node.file)) return;
  const safe = String(node.file).replace(/\.json$/i, "").replace(/[\\/:*?"<>|]/g, "_");
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  /* 备份也用紧凑 JSON：跟 ComfyUI 自己存的排版一致，回滚时格式不打架 */
  await api.putUserFile(`xy-wxhb-backup/${safe}.${stamp}.json`, JSON.stringify(snapshot));
  backedUp.add(node.file);
}

/**
 * 把画布上的启用 / 停用写回 ComfyUI 的工作流文件
 * 停用 = 节点设成 bypass（mode 4），ComfyUI 里看是紫色旁路，跟手点 bypass 一样
 *
 * ⚠️ 写完必须回读一遍再算数：ComfyUI 里要是正开着这份工作流，它浏览器里那份内存副本
 * 迟早会把自己的版本存回去（Ctrl+S / 自动保存），我们写的 mode 就被抹掉。
 * 之前只写字不校验，画布上照样弹「已写回」，实际一点没改 —— 这就是「不同步」的来源。
 */
const LORA_CLOSE_MODE = (m) => m === 4 || m === 2;
async function pushModesToComfy(node, { quiet = false } = {}) {
  if (!node?.uiWf || node.kind !== "workflow" || !node.file) return { changed: 0 };
  const want = new Map();
  for (const id of node.assetOn || []) want.set(String(id), 0);
  for (const id of node.assetOff || []) want.set(String(id), 4);
  if (!want.size) { node.unsynced = []; return { changed: 0, why: "没有改动" }; }

  /* 只改 0 / 2 / 4 这几种开关模式，别碰「永远不执行」之类的 */
  const applyTo = (wf) => {
    let k = 0;
    for (const n of wf?.nodes || []) {
      const m = want.get(String(n.id));
      if (m === undefined) continue;
      const cur = n.mode ?? 0;
      if (cur === m) continue;
      if (cur !== 0 && cur !== 2 && cur !== 4) continue;
      n.mode = m;
      k++;
    }
    return k;
  };
  /* 回读磁盘：还差哪几个口没落到文件里（文件里本来就没这个节点的跳过，它写不进去） */
  const readBack = async () => {
    const wf = await api.getWorkflow(node.file).catch(() => null);
    if (!wf) return { wf: null, left: [] };
    const left = [...want.entries()]
      .filter(([id, m]) => {
        const x = (wf.nodes || []).find(n => String(n.id) === id);
        return x && (x.mode ?? 0) !== m;
      })
      .map(([id]) => id);
    return { wf, left };
  };

  const snapshot = JSON.parse(JSON.stringify(node.uiWf));
  const ids = new Set((node.uiWf.nodes || []).map(n => String(n.id)));
  const notInFile = [...want.keys()].filter(id => !ids.has(id)).length;
  const changed = applyTo(node.uiWf);

  /* 内存里已经一致了也别急着说「好了」—— 磁盘上未必，顺手核一下 */
  if (!changed) {
    const { wf, left } = await readBack();
    if (!left.length) {
      node.unsynced = [];
      if (!quiet) toast(notInFile
        ? "这个节点是画布补出来的，工作流文件里没有它，没什么可同步"
        : "ComfyUI 那边的文件已经是这个状态了", "");
      return { changed: 0, notInFile, why: "已一致" };
    }
    /* 磁盘没跟上：接着往下写，以磁盘那份为底，别把别人这期间改的别的东西抹掉 */
    if (wf) node.uiWf = { ...wf, nodes: wf.nodes.map(n => {
      const m = want.get(String(n.id));
      return m !== undefined && [0, 2, 4].includes(n.mode ?? 0) ? { ...n, mode: m } : n;
    }) };
  }

  try {
    await backupWorkflowOnce(node, snapshot);
    await api.saveWorkflow(node.file, node.uiWf);
    let { left } = await readBack();
    let retried = false;
    if (left.length) {
      /* 被挤掉了 → 再补写一次（多半是 ComfyUI 那一页开着，存了自己的版本回去） */
      retried = true;
      await api.saveWorkflow(node.file, node.uiWf);
      left = (await readBack()).left;
    }
    node.wfSig = wfDigest(node.uiWf);
    rememberModes(node);
    const meta = await api.getWorkflowMeta(node.file).catch(() => null);
    if (meta?.mtime) node.fileMtime = meta.mtime;
    node.stale = false;
    markUnsynced(node, new Map((node.uiWf.nodes || []).map(n => [String(n.id), n.mode ?? 0])));
    if (left.length) {
      /* 磁盘就是不听话：说清楚，别让画布顶着「已写回」骗人 */
      node.unsynced = left;
      const msg = "写回被挤掉了：ComfyUI 里要是正开着这份工作流，它会把内存里那份存回来盖掉。"
        + "关掉 ComfyUI 那一页（或先别在那儿保存）再点一次。";
      toast(msg, "err", 8000);
      renderNode(node); paintStatus(node);
      return { changed, notInFile, error: msg, left, retried };
    }
    if (!quiet) {
      const n = changed || want.size;
      toast(`已写回 ComfyUI：「${node.name}」${n} 个节点启停已更新${retried ? "（被挤掉后补写了一次）" : ""}`, "ok", 4200);
    }
    renderNode(node); paintStatus(node);
    return { changed: changed || want.size, notInFile, retried };
  } catch (e) {
    /* 写盘失败：把内存里改过的 mode 还原，别让画布以为已经同步了 */
    const byId = new Map((snapshot.nodes || []).map(n => [String(n.id), n]));
    for (const n of node.uiWf.nodes || []) {
      const old = byId.get(String(n.id));
      if (old && (old.mode ?? 0) !== (n.mode ?? 0)) n.mode = old.mode ?? 0;
    }
    toast(`写回 ComfyUI 失败：${e.message}`, "err", 6000);
    node.unsynced = [...want.keys()];
    renderNode(node); paintStatus(node);          // 让 LoRA 段亮出「没写回」，别静悄悄
    return { changed: 0, error: e.message };
  }
}

/* ---------------- 参数写回：画布上改的每一格都同步进工作流文件 ----------------
   以前只有「启停」和 LoRA 段会写回，其余一律只活在画布内存和提交体里：
   在画布上把步数从 20 改成 8、把提示词重写一遍、换一张参考图，回 ComfyUI 打开
   同一份工作流还是旧值 —— 同一份工作流两个版本，跑出来当然对不上。
   现在画布上能改的（参数、采样器、模型、LoRA、素材文件、提示词）全都往回写。

   四条规矩：
   · 按节点攒批一起写 —— 拖 spinner、连着敲提示词时不会每一下都落盘
   · 打字类（数字框 / 文本 / 提示词）停手 3 秒自动写，连打不断也不超过 3 秒；
     下拉、勾选这类一次到位的控件 0.7 秒就写
   · 点输入框以外的地方、切走窗口、按回车 —— 一律立刻写，不用等那 3 秒
   · 以磁盘那份为底再改字段 —— ComfyUI 那页可能刚存过，拿内存里的旧版整个盖回去
     会把人家的改动吃掉
   · 写完回读校验，被盖掉就补写一次；还不对就把话说明白，不假装成功
================================================================== */
const PUSH_DEBOUNCE = 700;         // 下拉 / 勾选 / 换素材：一次到位，短攒一下就写
const PUSH_TYPING_MS = 3000;       // 打字：停手 3 秒自动写回
const PUSH_TYPING_MAX = 3000;      // 一直打个不停时，从这轮第一下算起最多憋 3 秒
const pushFirstAt = new Map();     // 画布节点 id → 这一轮第一下改动的时间
const pushQueue = new Map();       // 画布节点 id → Map("nodeId|field" → {nid, field, value})
const pushTimers = new Map();

/** 某个 widget 在 widgets_values 数组里的位置（跟 listWidgets 的排法一致） */
function widgetIndexOfField(cls, field) {
  const info = S.oi?.[cls];
  if (!info) return -1;
  let idx = 0;
  for (const w of listWidgets(info)) {
    if (w.name === field) return idx;
    idx += 1 + (w.extraAfter ? 1 : 0);
  }
  return -1;
}

/** 读工作流节点里某个参数现在存的值（named 优先，其次按 widget 顺序找数组位） */
function readUiWidget(nd, cls, field) {
  if (!nd) return undefined;
  const named = (nd.widgets_values_named && typeof nd.widgets_values_named === "object") ? nd.widgets_values_named
    : (!Array.isArray(nd.widgets_values) && nd.widgets_values && typeof nd.widgets_values === "object") ? nd.widgets_values
      : null;
  if (named && field in named) return named[field];
  const arr = Array.isArray(nd.widgets_values) ? nd.widgets_values : null;
  if (!arr) return undefined;
  const i = widgetIndexOfField(cls, field);
  return i >= 0 && i < arr.length ? arr[i] : undefined;
}

/** 数组位是按 object_info 的 widget 顺序推出来的，写之前核一下类型：
    本来是数字的口别塞字符串进去 —— 宁可不写，也别把隔壁参数串了 */
function typeFits(old, v) {
  if (old === undefined) return true;
  if (typeof old === "number") return typeof v === "number" && Number.isFinite(v);
  if (typeof old === "boolean") return typeof v === "boolean";
  if (typeof old === "string") return typeof v === "string";
  return false;
}

/** 下拉值在文件里可能存成「值 — 中文说明」（task_type 就是这样），
    比较前先归一化 —— 否则每次改别的参数都会把它无谓地重写一遍 */
function normWidget(cls, field, v) {
  if (typeof v !== "string") return v;
  const w = listWidgets(S.oi?.[cls] || {}).find(x => x.name === field);
  return w ? normalizeCombo(v, w.choices) : v;
}

/** 把 UI 工作流里某个节点的某个参数改成新值（named / 数组两种存法都改） */
function setUiWidget(nd, cls, field, value) {
  let hit = false;
  const named = (nd.widgets_values_named && typeof nd.widgets_values_named === "object") ? nd.widgets_values_named
    : (!Array.isArray(nd.widgets_values) && nd.widgets_values && typeof nd.widgets_values === "object") ? nd.widgets_values
      : null;
  if (named && field in named) { named[field] = value; hit = true; }
  const arr = Array.isArray(nd.widgets_values) ? nd.widgets_values : null;
  const i = widgetIndexOfField(cls, field);
  if (arr && i >= 0 && i < arr.length && typeFits(arr[i], value)) { arr[i] = value; hit = true; }
  return hit;
}

/* ==================================================================
   这一格在文件里是「接线」，而不是「节点自带的那个值」
   ──────────────────────────────────────────────────────────────────
   h3 长视频的时长就是这样：消费它的节点（ComfyMathExpression）里，
   inputs["values.a"] 指到一个 PrimitiveFloat（标题就是 Float (duration)），
   节点自己的 widgets_values 里根本没有这一格。
   以前 setUiWidget 按 widget 顺序找不到位置就返回 false，调用方直接 continue ——
   于是画布上把时长从 10.1 改成 15，文件里纹丝不动，还一句错都不报。
   现在顺着那条线摸到真正的常量节点，把值写进它自己的 widgets_values。
================================================================== */
const PRIM_VALUE_NODE = /^Primitive(Node|Int|Float|String|Boolean|BoundingBox|Text)$/;

/** UI 工作流里的 links 表统一成 Map（老格式是数组，新格式是对象） */
function linkMapOf(wf) {
  const m = new Map();
  for (const l of (wf?.links || [])) {
    if (Array.isArray(l)) {
      m.set(String(l[0]), { src: String(l[1]), srcSlot: l[2], dst: String(l[3]), dstSlot: l[4], type: l[5] });
    } else if (l && l.id != null) {
      const src = l.origin_id ?? l.source ?? l.source_id;
      const dst = l.target_id ?? l.target ?? l.target_id;
      m.set(String(l.id), {
        src: String(src), srcSlot: l.origin_slot ?? l.source_slot,
        dst: String(dst), dstSlot: l.target_slot, type: l.type,
      });
    }
  }
  return m;
}

/** 顺着「这一格是接线」摸到真正存值的常量节点；不是接线 / 途中经过算子就返回 null */
function constSlotOf(wf, nid, field) {
  const nodes = wf?.nodes || [];
  const nd = nodes.find(n => String(n.id) === String(nid));
  if (!nd) return null;
  const inp = (nd.inputs || []).find(i => i.name === field);
  if (!inp || inp.link == null) return null;
  const links = linkMapOf(wf);
  let lk = links.get(String(inp.link));
  for (let g = 0; lk && g < 32; g++) {
    const sn = nodes.find(n => String(n.id) === String(lk.src));
    if (!sn) return null;
    if (PRIM_VALUE_NODE.test(String(sn.type))) {
      const named = (sn.widgets_values_named && typeof sn.widgets_values_named === "object") ? sn.widgets_values_named : null;
      return { node: sn, named };
    }
    if (sn.type === "Reroute") {           /* 透传节点：接着往上摸 */
      const l2 = (sn.inputs || [])[0]?.link;
      lk = l2 != null ? links.get(String(l2)) : null;
      continue;
    }
    return null;                            /* 经过表达式 / 采样节点：那里没有「一个数」可写 */
  }
  return null;
}

/** 读这个常量节点现在存的值 */
function readConstSlot(cs) {
  if (!cs) return undefined;
  if (cs.named && "value" in cs.named) return cs.named.value;
  const arr = Array.isArray(cs.node.widgets_values) ? cs.node.widgets_values : null;
  if (arr) return arr.length ? arr[0] : undefined;
  return cs.node.widgets_values === undefined ? undefined : cs.node.widgets_values;
}

/** 把值写进这个常量节点（named / 数组两种存法都改；类型不符宁可不写） */
function writeConstSlot(cs, value) {
  if (!cs) return false;
  let hit = false;
  if (cs.named && "value" in cs.named && typeFits(cs.named.value, value)) {
    cs.named.value = value; hit = true;
  }
  if (Array.isArray(cs.node.widgets_values)) {
    const arr = cs.node.widgets_values;
    if (!arr.length) { arr[0] = value; hit = true; }
    else if (typeFits(arr[0], value)) { arr[0] = value; hit = true; }
  } else {
    cs.node.widgets_values = [value]; hit = true;
  }
  return hit;
}

/** 这一格现在实际是什么值：接线驱动的先看源头常量，其次才看节点自带的值 */
function readFieldValue(wf, nid, field) {
  const cs = constSlotOf(wf, nid, field);
  if (cs) {
    const cv = readConstSlot(cs);
    if (cv !== undefined) return cv;
  }
  const nd = (wf?.nodes || []).find(n => String(n.id) === String(nid));
  return nd ? readUiWidget(nd, nd.type, field) : undefined;
}

/** 写这一格：接线驱动的写源头那个常量，自带的值写节点自己 */
function writeFieldValue(wf, nid, field, value) {
  const nd = (wf?.nodes || []).find(n => String(n.id) === String(nid));
  if (!nd) return false;
  const cs = constSlotOf(wf, nid, field);
  if (cs && writeConstSlot(cs, value)) return true;
  return setUiWidget(nd, nd.type, field, value);
}

/** 同一个节点连着改好几格，提示别刷屏 */
const pushToastAt = new Map();
function pushToast(node, text, kind) {
  const now = Date.now();
  if (now - (pushToastAt.get(node.id) || 0) < 2500) return;
  pushToastAt.set(node.id, now);
  toast(text, kind, 2600);
}

/** 记一笔「画布上改了，待写回」。打字类停手 3 秒写，其它控件 0.7 秒写。
 *  typing=true 表示这是「正在打字」的改动（数字框每敲一下、文本框每输一个字） */
function queueParamPush(node, nid, field, value, typing) {
  if (!syncCfg.push || node?.kind !== "workflow" || !node.file) return;
  if (nid === undefined || nid === null || !field || value === undefined) return;
  const k = String(nid) + "|" + field;
  let q = pushQueue.get(node.id);
  if (!q) { q = new Map(); pushQueue.set(node.id, q); }
  q.set(k, { nid: String(nid), field, value });

  const now = Date.now();
  let wait = typing ? PUSH_TYPING_MS : PUSH_DEBOUNCE;
  if (typing) {
    /* 连着打不停的话，看这一轮第一下是什么时候 —— 保证 3 秒内一定写一次 */
    const first = pushFirstAt.get(node.id) || now;
    pushFirstAt.set(node.id, first);
    wait = Math.max(0, Math.min(wait, PUSH_TYPING_MAX - (now - first)));
  }
  clearTimeout(pushTimers.get(node.id));
  pushTimers.set(node.id, setTimeout(() => {
    pushTimers.delete(node.id);
    pushFirstAt.delete(node.id);
    flushParamPush(node).catch(() => { });
  }, wait));
}

/** 不等攒批，马上把这个节点攒着的改动写掉（回车、失焦、点别处都走这里） */
function flushNodePush(node) {
  if (!node) return;
  clearTimeout(pushTimers.get(node.id));
  pushTimers.delete(node.id);
  pushFirstAt.delete(node.id);
  flushParamPush(node).catch(() => { });
}

/** 所有节点攒着的改动一起写（点空白、切走窗口、开始运行之前） */
function flushPendingPushes() {
  for (const id of [...pushQueue.keys()]) {
    clearTimeout(pushTimers.get(id));
    pushTimers.delete(id);
    pushFirstAt.delete(id);
    const n = S.nodes.find(x => x.id === id);
    if (n) flushParamPush(n).catch(() => { });
  }
}

/* 点到输入框以外的地方就写回。
   光靠 blur / change 是不够的 —— 画布按下空白处会 preventDefault（为了拖动画布），
   焦点压根没挪走，change 事件也就不会来，于是「非得敲回车才同步」。
   这里先手动失焦让 change 落地，再把攒着的改动一次写掉。 */
let _clickAwayBound = false;
function bindAutoPushOnClickAway() {
  if (_clickAwayBound) return;
  _clickAwayBound = true;
  document.addEventListener("pointerdown", (e) => {
    const t = e.target;
    const inField = !!t?.closest?.("input, textarea, select, [contenteditable]");
    if (inField) return;                       // 点到另一个格子上：让它的 blur 自己收尾
    const ae = document.activeElement;
    if (ae && ae !== t && ae.matches?.("input, textarea, select, [contenteditable]")) ae.blur();
    flushPendingPushes();
  }, true);
}

/**
 * 把攒下的改动写进工作流文件。
 * 底稿是磁盘上那份，不是内存里的 —— 反过来的话，ComfyUI 那页刚存的改动会被整份盖掉。
 */
async function flushParamPush(node) {
  if (node?._pushing) { node._pushAgain = true; return { skipped: 1 }; }   // 正写着：等它写完再来一轮
  const q = pushQueue.get(node.id);
  if (!q || !q.size) return { skipped: 1 };
  const items = [...q.values()];
  q.clear();
  if (!node?.uiWf || node.kind !== "workflow" || !node.file) return { skipped: 1 };
  node._pushing = true;
  try {
    return await flushParamPushInner(node, items);
  } catch (e) {
    /* 以前这里一路 catch(()=>{})，出错等于没发生：用户改了参数、文件没动、屏幕上也没一句话。
       写不进去必须说出来。 */
    pushToast(node, `写回 ComfyUI 出错：${e.message || e}`, "err");
    console.error("flushParamPush", e);
    return { error: 1 };
  } finally {
    node._pushing = false;
    if (node._pushAgain) {
      node._pushAgain = false;
      if (pushQueue.get(node.id)?.size) flushParamPush(node).catch(() => { });
    }
  }
}

async function flushParamPushInner(node, items) {
  /* 写到磁盘之后，画布内存也跟上，别让两边各执一份 */
  const applyMemory = () => {
    for (const it of items) {
      writeFieldValue(node.uiWf, it.nid, it.field, it.value);
      /* 跑的时候用的是 node.prompt（内联过的），不是 uiWf。
         只改 uiWf 的话，文件里已经是新时长，刚从画布跑一遍却还是旧帧数 */
      const pn = node.prompt?.[it.nid];
      if (pn && pn.inputs && Object.prototype.hasOwnProperty.call(pn.inputs, it.field)) {
        pn.inputs[it.field] = it.value;
      }
    }
  };

  const disk = await api.getWorkflow(node.file).catch(() => null);
  if (!disk) return { skipped: 1 };
  const snapshot = JSON.parse(JSON.stringify(disk));

  const applied = [];
  for (const it of items) {
    const nd = (disk.nodes || []).find(n => String(n.id) === it.nid);
    if (!nd) continue;                                                      // 画布补出来的节点，文件里没有
    const cur = readFieldValue(disk, it.nid, it.field);
    if (sameVal(cur, it.value) || sameVal(normWidget(nd.type, it.field, cur), it.value)) continue;  // 文件里已经是这个值
    if (!writeFieldValue(disk, it.nid, it.field, it.value)) continue;       // 这一格没存在文件里（也不是接线常量）
    /* 导演台的分段模式：时间线 JSON 里的 taskType 优先级更高，只改 widget 等于没改 */
    if (RE_MODE.test(it.field) && DIRECTOR_CLS.test(String(nd.type || ""))) {
      const tl = readUiWidget(nd, nd.type, "timeline_data");
      const next = patchTimeline(tl, (o) => { (o.global = o.global || {}).taskType = it.value; });
      if (next && next !== tl) setUiWidget(nd, nd.type, "timeline_data", next);
    }
    applied.push(it);
  }
  if (!applied.length) { applyMemory(); return { skipped: 1 }; }

  const readBack = async () => {
    const wf = await api.getWorkflow(node.file).catch(() => null);
    if (!wf) return { ok: false, miss: applied.map(a => a.field) };
    const miss = applied.filter(it => {
      const nd = (wf.nodes || []).find(n => String(n.id) === it.nid);
      if (!nd) return true;
      const got = readFieldValue(wf, it.nid, it.field);
      return !(sameVal(got, it.value) || sameVal(normWidget(nd.type, it.field, got), it.value));
    }).map(it => it.field);
    return { ok: !miss.length, miss };
  };

  try {
    await backupWorkflowOnce(node, snapshot);
    await api.saveWorkflow(node.file, disk);
    let r = await readBack();
    if (!r.ok) {
      /* 被 ComfyUI 那一页盖掉了 → 补写一次再算数 */
      await api.saveWorkflow(node.file, disk);
      r = await readBack();
    }
    applyMemory();
    node.wfSig = wfDigest(node.uiWf);
    const meta = await api.getWorkflowMeta(node.file).catch(() => null);
    if (meta?.mtime) node.fileMtime = meta.mtime;
    node.stale = false;
    if (!r.ok) {
      pushToast(node, `没写回 ComfyUI：${r.miss.slice(0, 3).join("、")}`
        + " —— ComfyUI 那边是不是正开着这份工作流？关掉那一页再改一次", "err");
      return { error: 1, miss: r.miss };
    }
    const names = applied.map(a => node._cn?.[a.nid + "|" + a.field] || a.field);
    pushToast(node, names.length === 1
      ? `已写回 ComfyUI：「${names[0]}」`
      : `已写回 ComfyUI：${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 项` : ""}`, "ok");
    watchOverwrite(node, applied);
    return { ok: 1, count: names.length };
  } catch (e) {
    pushToast(node, `写回 ComfyUI 失败：${e.message}`, "err");
    return { error: 1 };
  }
}

/* ==================================================================
   写进去了，但被 ComfyUI 自己盖回来
   ──────────────────────────────────────────────────────────────────
   ComfyUI 的设置里有一条 Comfy.Workflow.AutoSave（默认 "after delay"、3 秒）：
   那一页开着这份工作流时，它会把**内存里那份整图**写回文件。画布刚写进去的值
   就这么被它内存里的旧值盖掉 —— 用户看到的是「改了没反应」，其实写进去过。

   所以写完 5 秒后复查一次：这一格还是我写的那个值就没事；被打回旧值就直说原因，
   别让人一趟趟重试。画布上要是又改过了，就当我们自己后写的，不算被盖。
================================================================== */
function watchOverwrite(node, applied) {
  setTimeout(async () => {
    try {
      const wf = await api.getWorkflow(node.file).catch(() => null);
      if (!wf) return;
      const lost = applied.filter(it => {
        const k = it.nid + "|" + it.field;
        /* 画布上后来又改过这一格 → 以画布为准，不报 */
        if (node.params && Object.prototype.hasOwnProperty.call(node.params, k)
          && !sameVal(node.params[k], it.value)) return false;
        const nd = (wf.nodes || []).find(n => String(n.id) === it.nid);
        if (!nd) return false;
        const got = readFieldValue(wf, it.nid, it.field);
        return !(sameVal(got, it.value) || sameVal(normWidget(nd.type, it.field, got), it.value));
      });
      if (!lost.length) return;
      const who = lost.map(it => node._cn?.[it.nid + "|" + it.field] || it.field).slice(0, 3).join("、");
      toast(`「${who}」写进去后被 ComfyUI 的自动保存盖回旧值了 —— 在 ComfyUI 里重新打开这份工作流（或关掉它的自动保存），再改一次`, "err", 9000);
    } catch { }
  }, 5200);
}

/** 文本节点的内容 → 它连着的那些工作流输入口（提示词就是这么同步进 ComfyUI 的） */
function queueTextPush(node, typing) {
  if (!syncCfg.push || node?.kind !== "input" || node.inKind !== "text") return;
  const text = node.value ?? "";
  for (const e of S.edges || []) {
    if (e.from !== node.id || !e.key) continue;
    const t = S.nodes.find(n => n.id === e.to);
    if (!t || t.kind !== "workflow") continue;
    const bar = String(e.key).lastIndexOf("|");
    if (bar < 0) continue;
    queueParamPush(t, e.key.slice(0, bar), e.key.slice(bar + 1), text, typing);
  }
}

/** 画布上明确点过启停的口，跟文件里实际的对不上 → 记进 node.unsynced，LoRA 段会亮「没写回」 */
function markUnsynced(node, modes) {
  const bad = [];
  for (const id of node.assetOff || []) {
    const m = modes.get(String(id));
    if (m !== undefined && !LORA_CLOSE_MODE(m)) bad.push(String(id));
  }
  for (const id of node.assetOn || []) {
    const m = modes.get(String(id));
    if (m !== undefined && LORA_CLOSE_MODE(m)) bad.push(String(id));
  }
  node.unsynced = bad;
  return bad;
}

/** 定时问一下文件头：ComfyUI 那边改了，就在节点头上亮个黄点 */
let staleTimer = null;
function startStaleWatch() {
  clearInterval(staleTimer);
  staleTimer = setInterval(checkWorkflowStale, 20000);
}
async function checkWorkflowStale() {
  if (document.hidden || !S.oi) return;
  const nodes = S.nodes.filter(n => n.kind === "workflow" && n.file && n.status !== "running");
  if (!nodes.length) return;
  await Promise.all(nodes.map(async (n) => {
    try {
      const m = await api.getWorkflowMeta(n.file);
      if (!m.mtime) return;
      if (!n.fileMtime) { n.fileMtime = m.mtime; return; }
      if (m.mtime <= n.fileMtime + 1200) return;
      /* 文件被改过了：读回来跟画布上的比一比，真变了就跟上。
         以前这里只亮个黄点等人点 ⟳ —— 在 ComfyUI 里启停个 LoRA，
         画布一直显示旧的，看着就像「没同步」 */
      await followComfyChanges(n);
    } catch { }
  }));
}

/** LoRA 节点在提示里怎么称呼（文件名去掉后缀 / 自定义标题） */
function loraNameOf(n) {
  const v = Array.isArray(n?.widgets_values) ? n.widgets_values[0]
    : n?.widgets_values_named?.lora_name;
  const clean = typeof v === "string" ? v.replace(/\.[^.\\/]+$/, "").split(/[\\/]/).pop() : "";
  return n?.title || clean || String(n?.type || "LoRA");
}

/**
 * ComfyUI 那边动过这个工作流（启停 LoRA / 改参数 / 增删节点）→ 读回来照着变。
 * 正在这个节点上打字就只亮黄点，别把人手里的输入框冲掉。
 */
async function followComfyChanges(node) {
  const el = nodeEl(node);
  if (el && el.contains(document.activeElement)) { node.stale = true; paintStatus(node); return false; }
  let uiWf, meta;
  try {
    [uiWf, meta] = await Promise.all([
      api.getWorkflow(node.file),
      api.getWorkflowMeta(node.file).catch(() => null),
    ]);
  } catch { return false; }
  if (meta?.mtime) node.fileMtime = meta.mtime;      // 读成功了才记，失败下次轮询接着试
  if (wfDigest(uiWf) === node.wfSig) { node.stale = false; paintStatus(node); return false; }

  /* 先看出是哪几个 LoRA 被启停过 —— 这才是最想说清的一件事 */
  const prevModes = node.wfModes || {};
  const loraBits = [];
  for (const n of uiWf.nodes || []) {
    if (!/lora/i.test(String(n.type || ""))) continue;
    const id = String(n.id);
    const before = prevModes[id];
    const now = n.mode ?? 0;
    if (before === undefined || before === now) continue;
    loraBits.push(`${loraNameOf(n)} ${LORA_CLOSE_MODE(now) ? "已停用" : "已启用"}`);
  }

  let r;
  try { r = adoptWorkflow(node, uiWf, meta); } catch { return false; }
  renderNode(node);
  save();

  const bits = [];
  if (loraBits.length) {
    bits.push(loraBits.slice(0, 2).join("、") + (loraBits.length > 2 ? ` 等 ${loraBits.length} 个 LoRA` : ""));
  }
  if (r.added) bits.push(`+${r.added} 节点`);
  if (r.removed) bits.push(`-${r.removed} 节点`);
  if (r.conflicts.length) bits.push(`${r.conflicts.length} 个参数按 ComfyUI 更新`);
  if (node.unsynced?.length) bits.push(`${node.unsynced.length} 项画布状态还没写进 ComfyUI`);
  toast(`「${node.name}」已跟上 ComfyUI${bits.length ? "：" + bits.join("，") : ""}`, "ok", 5200);
  return true;
}

/** 节点上最终生效的参数值 = 工作流原值 + 用户在面板上改过的 */
function effInputs(node, nid, nd) {
  const eff = { ...(nd.inputs || {}) };
  const pre = nid + "|";
  for (const [k, v] of Object.entries(node.params || {})) {
    if (k.startsWith(pre)) eff[k.slice(pre.length)] = v;
  }
  return eff;
}

/** 把 prompt 里所有可编辑的 widget 摊平成字段表 */
function buildFields(node) {
  const out = [];
  for (const [nodeId, nd] of Object.entries(node.prompt)) {
    const info = S.oi?.[nd.class_type];
    if (!info) continue;
    const locks = lockMapOf(nd.class_type, effInputs(node, nodeId, nd));
    const title = nd._meta?.title || nd.class_type;
    const inlined = nd._meta?.inlined || {};
    /* 内联常量原本是什么类型（PrimitiveFloat / PrimitiveInt…）。
       没有它就是「不是内联常量」，按宽松浮点处理 —— 宁可让用户输 12.2，
       也不要因为值恰好是整数就把他后来的小数吞掉 */
    const inlType = nd._meta?.inlinedType || {};
    /* object_info 里声明过的输入名；widget 名单独留一份 —— autogrow 容器（values / ref_images）
       本身是声明过的，但它底下的 values.a 才是真正能改的那个数 */
    const widgets = listWidgets(info);
    const widgetNames = new Set(widgets.map(w => w.name));
    const declared = new Set([...Object.keys(info.input?.required || {}), ...Object.keys(info.input?.optional || {})]);
    for (const w of widgets) {
      const v = nd.inputs?.[w.name];
      if (v === undefined) continue;
      const f = {
        key: nodeId + "|" + w.name,
        nodeId, name: w.name, type: w.type,
        choices: w.choices, value: v,
        title, cls: nd.class_type,
        min: w.min, max: w.max, step: w.step,
        locked: locks[w.name] || "",
      };
      if (Array.isArray(v)) {
        /* 这一格被上游连线驱动（时长就是典型：length 由表达式节点算出，
           常数写在 PrimitiveFloat 里）。这类口必须露出来 —— 藏掉它，
           面板上看着就像「这个工作流根本没有时长设置」 */
        if (!RE_DURATION.test(semName(f))) continue;
        f.driven = String(v[0]);
        f.value = null;
        out.push(f);
        continue;
      }
      out.push(f);
    }

    /* 声明之外的实值口：autogrow 变量（ComfyMathExpression 的 a）、
       被内联进来的常量（时长 10.1 就藏在这儿，源节点标题是 Float (duration)）。
       以前这些口一律被丢掉，于是「时长设置」在面板上凭空消失 */
    for (const [k, v] of Object.entries(nd.inputs || {})) {
      if (!k || k.startsWith("_")) continue;
      if (declared.has(k)) continue;
      const parent = k.includes(".") ? k.split(".")[0] : "";
      if (parent && widgetNames.has(parent)) continue;   // 动态下拉的子格，主格已经管着它
      if (Array.isArray(v) || (v !== null && typeof v === "object")) continue;
      if (v === "" || v === null || v === undefined) continue;
      const t = inlined[k] || title;
      /* 数学节点的 a / b 操作数：标题里认不出含义的，摆出来只会误导 */
      if (/^[a-z]$/i.test(k) && semName({ name: k, title: t, fromPrim: !!inlined[k] }) === k) continue;
      /* 数值型：只有当源节点明确是「整数」时才当 INT，其余一律按浮点。
         以前是 Number.isInteger(v) ? INT : FLOAT —— 时长 15 看着像整数，
         这一格就成了 INT，输入框里敲 12.2 被 parseInt 砍成 12 */
      const srcTy = String(inlType[k] || "");
      const numTy = (srcTy === "INT" || /PrimitiveInt\b/i.test(srcTy)) ? "INT" : "FLOAT";
      out.push({
        key: nodeId + "|" + k, nodeId, name: k,
        type: typeof v === "number" ? numTy
          : typeof v === "boolean" ? "BOOLEAN" : "STRING",
        choices: null, value: v,
        /* 这类口的值不是节点自己声明的 widget，别拿 INT 的规矩去截它的小数 */
        loose: typeof v === "number",
        title: t, cls: nd.class_type,
        locked: locks[k] || "",
        fromPrim: !!inlined[k],
        /* 内联常量没有标题可认名字了，就从算式反推它是什么单位 */
        sem: inlined[k] ? operandSem(node.prompt, nodeId, k) : "",
      });
    }
  }
  return applyFieldPlan(node, out);
}

/* ==================================================================
   面板字段顶替（按工作流定制）
   ──────────────────────────────────────────────────────────────────
   节点自带的一些参数在画布上根本没有意义 —— TextGenerate 的 max_length
   固定 4096（提示词就一两百字，谁也不会去改），放大器的 aspect_policy
   固定 preserve_source（画幅由上游决定，改成别的反而出错）。它们各占一格，
   而真正要动手的那一格（提示词增强开关、一采噪声种子）却埋在「更多参数」里。

   这里登记「谁让位、谁顶上来、顶上来叫什么」：

     wf     只在这些工作流里生效（按文件名匹配，同款节点在别的流里不受影响）
     drop   让位的那一格：从面板上摘掉，不再显示
     take   顶替它的那一格：站到 drop 原来的位置，归类也跟着 drop 走
     label  顶替之后在面板上显示的名字

   顶替只动「怎么显示」：take 的 nodeId / name / key 一个字没改，
   所以写回照旧走 queueParamPush —— 协议与其它参数完全一样。
   要加新的顶替，往这个表里再添一条即可。
================================================================== */
const FIELD_PLAN = [
  {
    /* MOSS 文生图（主人 2026-10-24 指定）：提示词增强的真假开关顶掉「最大长度 4096」 */
    wf: /MOSS.*文生图/i,
    drop: { cls: /^TextGenerate$/, field: "max_length" },
    take: { cls: /^ComfySwitchNode$/, field: "switch" },
    label: "提示词增强",
  },
  {
    /* h3 长视频（主人 2026-10-24 指定）：一采的噪声种子顶掉放大器的「画幅策略」。
       画幅策略恒为 preserve_source，摆着只会让人以为改得动 */
    wf: /h3.*长视频/i,
    drop: { cls: /LearnedLatentUpscale/i, field: "aspect_policy" },
    take: { cls: /^RandomNoise$/, field: "noise_seed" },
    label: "一采噪声种子",
  },
];

function applyFieldPlan(node, out) {
  const file = String(node?.file || "");
  if (!file || !out.length) return out;
  for (const p of FIELD_PLAN) {
    if (p.wf && !p.wf.test(file)) continue;
    /* 工作流里根本没有 take 那个节点（换了版本 / 换了流）就整条跳过 ——
       宁可不顶替，也不能把人唯一能改的那一格白白藏掉 */
    const take = out.find(f => p.take.cls.test(f.cls) && f.name === p.take.field);
    if (!take) continue;
    if (p.label) take.label = p.label;
    /* 这一格要顶到面板正面来，就不能再挂着「画布不提供编辑」的锁 */
    take.locked = "";
    const di = out.findIndex(f => p.drop.cls.test(f.cls) && f.name === p.drop.field);
    if (di < 0) continue;                 // 没有让位的，take 留在原处，只是换了个名字
    /* 顶替谁就站进谁的堆里（尺寸 / 画幅 / 采样…）：位置与归类一起接过来 */
    take._grp = classify(out[di]);
    out.splice(out.indexOf(take), 1);     // 先把 take 从原位置摘掉，免得插重
    const si = out.findIndex(f => p.drop.cls.test(f.cls) && f.name === p.drop.field);
    if (si >= 0) out.splice(si, 1, take);
    else out.push(take);
  }
  return out;
}

const RE_PROMPT = /^(prompt|text|positive|negative_prompt|negative|instruction|description|value|system_prompt|string)$/i;
const RE_SIZE = /(width|height|size|length|duration|frame|megapixel|resolution)/i;
const RE_SAMPLE = /(seed|steps|cfg|sampler|scheduler|denoise|strength|guidance|shift)/i;
/* 模型 / 权重类下拉：这些是「本机装了没装」的问题，跟素材分开摆 */
const RE_MODEL = /(ckpt|checkpoint|lora|vae|clip_name|clip_vision|unet|control_net|gligen|upscale_model|style_model|model_name|^model$|_model$|ipadapter|embedding|hypernetwork|gguf)/i;
/* 收进「更多参数」的：批量张数、重绘幅度 —— 这两个不常改，摆在前排白占地方 */
const RE_MORE = /^(batch_size|batch_count|denoise|denoise_strength)$/i;
/* 提到最前面的：画幅比例、时长（含帧数这类「这条要跑多久」的口）。
   这两格一改，宽度高度、帧数、步数都得跟着重调，埋在尺寸堆里找不到 */
const RE_ASPECT = /^(aspect_ratio|aspect|ratio|image_aspect|aspect_policy)$/i;
const RE_DURATION = /^(duration|video_duration|duration_seconds|seconds|length|num_frames|total_frames|video_length)$/i;
/* 模式切换（导演台的「分段模式」t2v / i2v / v2v / r2v…）：这一格决定整条流吃哪种素材，
   接视频时画布还会自动把它切到 v2v —— 埋在参数堆里等于让人自己去猜 */
const RE_MODE = /^(task_type|segment_mode|分段模式|task_mode|edit_mode|work_mode)$/i;

/* 泛名 widget：PrimitiveFloat / PrimitiveInt / 常量节点上的参数就叫 value / int，
   真正的含义只写在节点标题里（Float (duration)）。名字取不出来就只剩一个 value，
   面板上等于没写，好端端的时长参数被埋进「更多参数」里找不着 */
const GENERIC_W = /^(value|val|int|float|number|num|string|text_value)$/i;
const TITLE_SEM = [
  [/duration|seconds?|\bsec\b|时长|秒/i, "duration"],
  [/frames?|帧数/i, "num_frames"],
  [/batch|张数|数量/i, "batch_size"],
  [/seed|种子/i, "seed"],
  [/steps?|步数/i, "steps"],
];
/** 参数在这个面板上「叫什么」：泛名 widget 用节点标题里的词顶上，其余用原名 */
function semName(f) {
  /* 已经从算式里推出来的语义最准（a * 24 → 秒），压过标题与原名 */
  if (f?.sem) return f.sem;
  const n = String(f?.name ?? "");
  /* 单字母（ComfyMathExpression 的 a / b）和内联常量也靠标题认：
     它们的名字本来就没有含义，含义只写在原节点标题里 */
  if (!GENERIC_W.test(n) && !/^[a-z]$/i.test(n) && !f?.fromPrim) return n;
  const t = String(f?.title || "");
  for (const [re, name] of TITLE_SEM) if (re.test(t)) return name;
  return n;
}

/* ==================================================================
   数学表达式里的操作数到底代表什么
   ──────────────────────────────────────────────────────────────────
   换成官方 PrimitiveFloat 之后，那个常量节点没有标题了（以前第三方节点
   自带「Float (duration)」），标题这条路彻底断掉，面板上只剩一个 values.a。

   但算式本身把单位写在里头：
       length = max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
   `a * 24` 里的 24 正好是工作流里 CreateVideo 的 fps，而这一路输出接的是
   frames 类的输入（length / num_frames）—— 两条一对上，a 的单位就是「秒」。

   只在两条证据同时成立时才下结论；认不出返回空串，宁可叫 values.a，
   也不凭空编一个名字出来。
================================================================== */
const RE_FRAMES_IN = /^(length|num_frames|total_frames|frame_count|frames|video_length)$/i;

function operandSem(prompt, nid, field) {
  const m = /^values\.([a-z])$/i.exec(String(field || ""));
  if (!m) return "";
  const letter = m[1].toLowerCase();
  const nd = prompt?.[String(nid)];
  const expr = String(nd?.inputs?.expression ?? "");
  if (!expr) return "";

  /* ① 这个字母乘过一个常数（a * 24 / round(a*24) / a * 24.0 都算） */
  let scale = 0;
  const re = new RegExp("(?:^|[^a-z0-9_])" + letter + "\\s*\\*\\s*(\\d+(?:\\.\\d+)?)", "gi");
  let hit;
  while ((hit = re.exec(expr))) scale = Number(hit[1]);
  if (!scale) return "";

  /* ② 这个数学节点的某一路输出，接在了「帧数」类的输入上 */
  let feedsFrames = false;
  for (const [pid, pn] of Object.entries(prompt || {})) {
    if (String(pid) === String(nid)) continue;
    for (const [k, v] of Object.entries(pn?.inputs || {})) {
      if (!Array.isArray(v) || String(v[0]) !== String(nid)) continue;
      if (RE_FRAMES_IN.test(k)) { feedsFrames = true; break; }
    }
    if (feedsFrames) break;
  }
  if (!feedsFrames) return "";

  /* ③ 乘数就是工作流里的帧率 → 这一格是秒 */
  for (const pn of Object.values(prompt || {})) {
    if (typeof pn?.inputs?.fps === "number" && pn.inputs.fps === scale) return "duration";
  }
  return "";
}

/* ==================================================================
   参数名 → 中文
   ──────────────────────────────────────────────────────────────────
   工作流里的 widget 名全是英文（seed / steps / strength_model …），
   摊在画面上认不出来。三级兜底：
     1. PARAM_CN 整名精确命中；
     2. 按 _ 拆词，全部认识就拼起来（frame_load_cap → 帧·载入·上限）；
     3. 还是不认识就留英文原名（小字仍然显示英文，方便对照工作流）。
================================================================== */
const PARAM_CN = {
  /* 采样 */
  seed: "随机种子", noise_seed: "噪声种子", steps: "采样步数", cfg: "提示词引导 (CFG)",
  sampler_name: "采样器", sampler: "采样器", scheduler: "噪声调度器", denoise: "重绘幅度",
  sigmas: "Sigma 序列", guidance: "引导强度",
  shift_video: "视频偏移", shift_audio: "音频偏移", shift: "偏移",
  extra_steps: "额外步数", refine_steps: "精修步数", base_steps: "基础步数", coarse_steps: "粗采步数",
  restart_steps: "重启步数", restart_seed: "重启种子", restart_video_sigma: "重启视频 Sigma",
  start_at_sigma: "起始 Sigma", end_at_sigma: "结束 Sigma", spacing: "间隔策略",
  step: "切分步号", start_percent: "起始占比", end_percent: "结束占比",
  transition_step: "切换步", lowres_scale: "低清缩放", rho: "rho", w_min: "最小权重", w_max: "最大权重",
  /* 尺寸 / 时长 */
  width: "宽度", height: "高度", batch_size: "批量张数", length: "帧数", duration: "时长（秒）",
  frame_rate: "帧率", fps: "帧率", megapixels: "总像素（百万）", aspect_ratio: "画幅比例",
  resolution: "分辨率", resolution_steps: "分辨率档位数", multiple: "对齐倍数", size: "尺寸",
  target_width: "目标宽度", target_height: "目标高度", target_megapixels: "目标像素（百万）",
  num_frames: "帧数", custom_width: "自定义宽度", custom_height: "自定义高度",
  start_index: "起始帧", batch_index: "批次序号", frame_load_cap: "最多载入帧数",
  total_frames: "总帧数", trim_audio: "裁剪音频",
  seed_mode: "种子模式", ref_max_size: "参考最大尺寸", cache_frames_codec: "缓存帧编码",
  skip_first_frames: "跳过开头帧", select_every_nth: "抽帧间隔", force_rate: "强制帧率",
  trim_frames: "裁掉帧数", context_length: "上下文长度",
  /* 模型 / LoRA */
  lora_name: "LoRA 模型", strength_model: "强度（模型）", strength_clip: "强度（CLIP）",
  unet_name: "UNET 模型", clip_name: "CLIP 模型", vae_name: "VAE 模型",
  ckpt_name: "底模 (Checkpoint)", weight_dtype: "权重精度", model: "模型", model_name: "模型文件",
  model_file: "模型文件", model_bundle: "模型组合", upscale_model: "放大模型",
  upscaler_model: "放大模型", tiny_vae: "预览用 VAE", adapter: "增强适配器",
  upscale_method: "放大算法", scale: "缩放倍数", scale_by: "缩放倍数",
  /* 提示词 / 文本 */
  prompt: "提示词", negative_prompt: "负向提示词", text: "文本", positive: "正向提示词",
  negative: "负向提示词", system_prompt: "系统提示词", custom_prompt: "自定义提示词",
  preset_prompt: "预设提示词", value: "数值", values: "数值列表", expression: "表达式",
  filename_prefix: "文件名前缀", save_path: "保存路径", string_a: "字符串 A", string_b: "字符串 B",
  delimiter: "分隔符", input_text: "输入文本", edited_from_text: "编辑自",
  use_edited_text: "使用编辑后文本", 保存文件名: "保存文件名", 保存提示词: "保存提示词",
  /* 素材槽 */
  image: "图片文件", video: "视频文件", audio: "音频文件", images: "参考图片",
  ref_images: "参考图片", ref_videos: "参考视频", ref_audios: "参考音频",
  ref_video_audios: "参考视频音轨", ref_image_size: "参考图尺寸策略",
  local_video: "本地视频", upload_image: "上传图片",
  /* 输出 / 编码 */
  format: "封装格式", codec: "编码器", bit_depth: "位深", color_space: "色彩空间",
  save_output: "保存到 output", loop_count: "循环次数", pingpong: "往返播放",
  quality_profile: "质量档位", jpeg_quality: "JPEG 质量", max_resolution: "预览最大边长",
  preview_frames: "预览帧数", preview_fps: "预览帧率", suppress_default_preview: "关闭默认预览",
  /* 运行环境 / 加速 */
  device: "运行设备", precision: "精度", dtype: "数据类型", type: "类型", mode: "模式",
  attention: "注意力后端", membership: "成员", tile_size: "分块尺寸", tile_overlap: "分块重叠",
  tile_strategy: "分块策略", overlap: "重叠", temporal_size: "时序块尺寸",
  temporal_overlap: "时序块重叠", verbose: "输出详细日志", enabled: "启用", enable: "启用",
  chunks: "分块数", seq_threshold: "序列阈值", tau: "tau 温度", tau_profile: "tau 配置",
  morton: "莫顿排序", morton_curve: "莫顿曲线", centroid_tail: "尾部质心",
  routed_cap_percent: "路由上限 (%)", reuse_qkv_memory: "复用 QKV 显存",
  dense_blocks: "稠密块", min_tokens: "最少 token", extra_tokens: "额外 token",
  sink_conditioning: "汇聚条件", selection: "选择", memory_policy: "显存策略",
  torch_compile: "torch 编译", vae_encode_amp: "VAE 编码混合精度", reserved: "预留显存",
  auto_max_reserved: "自动最大预留", clean_gpu_before: "运行前清显存",
  start_percent_x: "起始占比", cache_threshold: "缓存阈值", cache_refresh: "缓存刷新间隔",
  temporal_cache: "时序缓存", frame_batch: "帧批次", image_batch: "图像批次",
  dino_batch: "DINO 批次", color_alignment: "色彩对齐", vae_tile_size: "VAE 分块尺寸",
  vae_tile_overlap: "VAE 分块重叠", blocks_to_swap: "换出块数", sage_preset: "Sage 预设",
  /* H3 / 导演台 */
  task_type: "分段模式", audio_mode: "音频模式", audio_denoise_strength: "音频重绘幅度",
  reference_video_policy: "参考视频策略", strict_prompt_tags: "严格提示词标签",
  add_source_as_reference: "把源加入参考", prompt_primary_audio_ordinal: "主音频序号",
  allow_above_reference_area: "允许超出参考区", auto_length_from_audio: "按音频自动定时长",
  media_state: "素材状态", alpha: "增强强度", magnitude_match: "幅度匹配",
  aspect_policy: "画幅策略", size_mode: "尺寸模式", align: "对齐", release_policy: "释放策略",
  enable_temporal_chunking: "启用时序分块", force_unload: "强制卸载",
  refine_foreground: "前景细化", ref_boost: "参考增强", ref_boost_a: "参考增强 A",
  fit_mode: "适配方式", fit: "适配方式",
  /* 图像处理 */
  color: "颜色", x: "X 偏移", y: "Y 偏移", left: "左扩边", top: "上扩边", right: "右扩边",
  bottom: "下扩边", feathering: "边缘羽化", crop: "裁剪方式", opacity: "不透明度",
  brightness: "亮度", contrast: "对比度", saturation: "饱和度", sharpness: "锐度",
  sharpen: "锐化", red: "红", green: "绿", blue: "蓝", channel: "通道",
  sensitivity: "灵敏度", process_res: "处理分辨率", mask_blur: "蒙版模糊",
  mask_offset: "蒙版偏移", invert_output: "反相输出", background: "背景",
  background_color: "背景色", canvas_color: "画布颜色",
  /* 杂项 */
  method: "方法", operation: "运算", a: "A", b: "B", ratio: "比例", quality: "质量",
  interval: "间隔", index: "序号", max_objects: "最多目标数", detection_threshold: "检测阈值",
  threshold: "阈值", class_name: "类别", max_detections: "最多检测数",
  interpolation_mode: "插值方式", proportional_width: "宽占比", proportional_height: "高占比",
  round_to_multiple: "按倍数取整", scale_to_side: "对齐到边", scale_to_length: "对齐长度",
  inputcount: "输入数量", match_image_size: "匹配图像尺寸", match_tail: "匹配尾部",
  direction: "方向", window: "窗口", fov: "视场角 (FOV)",
  /* 导演台 / 双采样面板里被锁住的那批，也得有个中文名 */
  global_prompt: "全局提示词", timeline_data: "时间线数据", total_frames: "总帧数",
  ref_max_size: "参考最大尺寸", export_source_images: "导出源图",
  export_pre_face_refine: "导出脸部精修前", first_pass_cache_status: "一采缓存状态",
  passes: "采样轮数", skip_fl2v: "跳过首尾帧视频", confirm_first_pass: "确认一采再继续",
  enable_latent_chunking: "启用潜空间分块", enable_tiling: "启用分块处理",
  head_chunks: "首部块数", latent_upscale_model: "潜空间放大模型", tile_count: "分块数量",
  clear_vram_between_segments: "段间清显存", clear_vram_before_refine: "二采前清显存",
  clear_vram_before_face_refine: "脸部精修前清显存",
  second_pass_audio_source: "二采音频来源", second_pass_audio_strength: "二采音频强度",
  enable_model_time_bias: "启用时间偏置", bias: "偏置",
  bias_start_progress: "偏置起始占比", bias_end_progress: "偏置结束占比", bias_domain: "偏置作用域",
  enable_stg: "启用 STG", stg_scale: "STG 强度", stg_double_blocks: "STG 双流块",
  stg_start_progress: "STG 起始占比", stg_end_progress: "STG 结束占比",
  enable_restart: "启用重启", token_scope: "token 作用域", chunk_tokens: "分块 token",
  per_layer_weights: "逐层权重", multiplier: "倍率", renormalize: "重新归一化",
  max_anisotropy: "最大各向异性", reference_latents_method: "参考潜空间方式",
  grounding_px: "对齐像素", painted_data: "绘制数据", created_data: "生成数据",
  /* 通用杂项 */
  api_key: "API 密钥", api_base_url: "API 地址", switch: "开关", op: "运算",
  timeout_s: "超时（秒）", poll_interval_s: "轮询间隔（秒）", seconds: "秒数",
  temperature: "温度", auto_resize: "自动缩放", vl_size: "视觉模型边长",
  comparison: "对比图", frame_idx: "帧序号", snapshot: "快照", kv_cache: "KV 缓存",
  noise_radius: "噪声半径", preserve_edges: "保留边缘", fit_to: "适配到",
  invert: "反相", gamma: "伽马", indexes: "索引",
  err_if_missing: "缺文件时报错", err_if_empty: "空值时报错", detect_interval: "检测间隔",
  image1_strength: "图 1 强度", image2_strength: "图 2 强度", image3_strength: "图 3 强度",
  processing_control_value: "处理控制值", processing_percent_1: "处理占比 1",
  processing_percent_2: "处理占比 2",
};

/* 逐词兜底：这些都是参数名里反复出现的词根 */
const WORD_CN = {
  width: "宽度", height: "高度", size: "尺寸", length: "长度", count: "数量", num: "数量",
  mode: "模式", rate: "率", fps: "帧率", seed: "种子", steps: "步数", step: "步", cfg: "CFG",
  scale: "缩放", sampler: "采样器", scheduler: "调度器", denoise: "重绘", noise: "噪声",
  strength: "强度", sigma: "Sigma", sigmas: "Sigma", shift: "偏移", extra: "额外",
  refine: "精修", base: "基础", coarse: "粗采", start: "起始", end: "结束", stop: "停止",
  frame: "帧", frames: "帧", rate_x: "率", video: "视频", audio: "音频", image: "图像",
  images: "图像", text: "文本", prompt: "提示词", negative: "负向", positive: "正向",
  model: "模型", lora: "LoRA", vae: "VAE", clip: "CLIP", unet: "UNET", ckpt: "底模",
  name: "名称", file: "文件", path: "路径", prefix: "前缀", type: "类型", format: "格式",
  quality: "质量", level: "级别", device: "设备", precision: "精度", block: "块",
  batch: "批量", cache: "缓存", threshold: "阈值", max: "最大", min: "最小", auto: "自动",
  enable: "启用", enabled: "启用", use: "使用", force: "强制", skip: "跳过", preview: "预览",
  save: "保存", output: "输出", input: "输入", load: "载入", cap: "上限", custom: "自定义",
  tile: "分块", overlap: "重叠", temporal: "时序", latent: "潜空间", mask: "蒙版",
  color: "颜色", space: "空间", depth: "深度", bit: "位", codec: "编码", loop: "循环",
  index: "序号", interval: "间隔", window: "窗口", direction: "方向", method: "方法",
  policy: "策略", preset: "预设", row: "行", col: "列", left: "左", right: "右",
  top: "上", bottom: "下", x: "X", y: "Y", size_x: "尺寸", ref: "参考", source: "来源",
  multi: "多", select: "选择", every: "每", nth: "第 N", first: "首", last: "末",
  tail: "尾", curve: "曲线", reuse: "复用", memory: "显存", attention: "注意力",  backend: "后端", chunks: "分块", tokens: "token", token: "token", seq: "序列",
  percent: "占比", ratio: "比例", spacing: "间隔", mix: "混合", detail: "细节",
  strength_x: "强度", upscale: "放大", upscaler: "放大器", resolution: "分辨率",
  megapixels: "百万像素", aspect: "画幅", align: "对齐", multiple: "倍数", total: "总",
};

const PARAM_CN_LOWER = new Map(Object.entries(PARAM_CN).map(([k, v]) => [k.toLowerCase(), v]));

/** 参数名 → 中文（认不出来就原样返回英文） */
function cnName(f) {
  /* FIELD_PLAN 指定过显示名的（提示词增强 / 一采噪声种子），直接用那个名字，
     不再走「英文拆词翻译」那套 —— switch 翻不出人话 */
  if (f?.label) return f.label;
  /* 泛名 widget 先按节点标题换成有含义的名字（value + 「Float (duration)」→ duration） */
  const raw = String(semName(f) ?? "");
  const key = raw.toLowerCase();
  if (PARAM_CN_LOWER.has(key)) return PARAM_CN_LOWER.get(key);
  /* 中文 widget 名（部分插件自己就是中文）直接用 */
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  const words = raw.split(/[_\s]+/).filter(Boolean);
  if (!words.length || words.length > 4) return raw;
  const cn = [];
  for (const w of words) {
    const c = WORD_CN[w.toLowerCase()];
    if (!c) return raw;                     // 有一个词不认识就整体放弃，别硬凑出怪名字
    cn.push(c);
  }
  return cn.join("");
}

/* 参数归属的节点名：一眼看出这堆参数是谁的
   工作流里作者写的节点标题最好用；没写就按类名给个中文短名 */
const NODE_CN = {
  MiniMaxH3Director: "导演台", MiniMaxH3DirectorRefine: "导演台 · 精修",
  MiniMaxH3SigmaShift: "偏移调节", MiniMaxH3Unified: "H3 统一编码",
  RandomNoise: "噪声", KSamplerSelect: "采样器", BasicScheduler: "调度",
  BasicGuider: "引导", SplitSigmas: "Sigma 切分", H3SigmaRefiner: "Sigma 精修",
  ManualSigmas: "手写 Sigma", ResolutionSelector: "分辨率",
  SamplerCustomAdvanced: "自定义采样", MiniMaxH3DualClockSamplerT8: "双时钟采样",
  SelfLiftH3Sampler: "自举采样", EmptyLatentImage: "空潜空间", EmptySD3LatentImage: "空潜空间",
  ImageScale: "图像缩放", MinimaxH3LatentUpscaler3D: "潜空间放大",
  MiniMaxH3AudioConditioningT8: "H3 音频/参考编码", MiniMaxH3ReferenceToVideo: "H3 参考生视频",
  MiniMaxH3ImageToVideo: "H3 图生视频",
  ModelPreviewOverrideKJ: "预览覆盖", UNETLoader: "UNET", CLIPLoader: "CLIP", VAELoader: "VAE",
  KSampler: "采样器", KSamplerAdvanced: "采样器（高级）", TextEncodeQwenImage21: "Qwen 文本编码",
  CLIPTextEncode: "文本编码", EmptyImage: "空图", CreateVideo: "合成视频", SaveVideo: "保存视频",
  SaveImage: "保存图片", ImageFromBatch: "批内取帧", ImageScaleToTotalPixels: "按总像素缩放",
  /* 双采样工作流里那些一长串类名，不翻成中文小标题会撑爆一行 */
  MiniMaxH3LearnedTwoPassParityPlanT8Advanced: "两采步数规划",
  MiniMaxH3TwoPassLatentReconcileT8Advanced: "两采潜空间对齐",
  MiniMaxH3TwoPassDetailMixerT8Advanced: "两采细节混合",
  MiniMaxH3SemanticBridgeConfigT8: "语义桥接",
  MiniMaxH3ChunkFeedForwardT8Advanced: "分块前馈",
  MiniMaxH3MemoryEfficientSageAttentionPatch: "SageAttention 补丁",
  MiniMaxH3LearnedLatentUpscaleT8Advanced: "学习式放大",
  MiniMaxH3LearnedLatentUpscaleT8: "学习式放大",
  MelBandRoFormerModelLoader: "音频分离模型",
  MelBandRoFormerSampler: "音频分离",
  LoraLoaderBypassModelOnly: "LoRA（旁路开关）",
};

/* ==================================================================
   ComfyUI 里改不了的参数
   ──────────────────────────────────────────────────────────────────
   有些节点在前端把一批 widget 藏起来（computeSize 压成 0，用自己的面板顶替），
   还有些值本来就是别的参数算出来的（画幅 + 总像素 → 宽高）。
   这些参数在 ComfyUI 面板里根本点不到，画布却给了输入框 ——
   改了不生效，还会让工作流里出现自相矛盾的两个值（宽高 vs 画幅、步数 vs 时间线），
   跑起来必然出错。名单取自各插件前端 JS 里显式隐藏的那批 widget。
================================================================== */
const HIDDEN_WIDGETS = {
  MiniMaxH3Director: {
    timeline_data: "由时间线面板接管",
    total_frames: "由时间线面板接管",
    width: "由时间线面板按画幅算出",
    height: "由时间线面板按画幅算出",
    ref_max_size: "由时间线面板接管",
    global_prompt: "由时间线面板接管",
    frame_rate: "由时间线面板接管",
    cfg: "由时间线面板接管",
    export_source_images: "由时间线面板接管",
    export_pre_face_refine: "由时间线面板接管",
  },
  MiniMaxH3DirectorRefine: {
    schedule: "由精修面板接管",
    denoise: "由精修面板接管",
    steps: "由精修面板接管",
    sigmas_text: "由精修面板接管",
    sigmas: "由精修面板接管",
    h3_latent_model: "由精修面板接管",
    upscale_model: "由精修面板接管",
    aspect_ratio: "跟随导演台（这里改不动）",
    width: "跟随导演台的画幅",
    height: "跟随导演台的画幅",
    target_width: "跟随导演台",
    target_height: "跟随导演台",
    first_pass_cache_status: "由精修面板接管",
  },
};

/** 导演台派生出来的节点（SelfLift / SemanticBridge / Pack）共用同一套面板 */
const DIRECTOR_PANEL_HIDDEN = {
  timeline_data: "由时间线面板接管", total_frames: "由时间线面板接管",
  width: "由时间线面板按画幅算出", height: "由时间线面板按画幅算出",
  ref_max_size: "由时间线面板接管", global_prompt: "由时间线面板接管",
  frame_rate: "由时间线面板接管",
  cfg: "由时间线面板接管", export_source_images: "由时间线面板接管",
  export_pre_face_refine: "由时间线面板接管",
};

/** 一个节点里哪些参数在画布上不该给控件 → { 参数名: 原因 } */
function lockMapOf(cls, inputs) {
  const o = {};
  const c = String(cls || "");
  const t = HIDDEN_WIDGETS[c];
  if (t) Object.assign(o, t);
  else if (/^MiniMaxH3Director/.test(c)) Object.assign(o, DIRECTOR_PANEL_HIDDEN);

  /* 尺寸模式驱动的宽高：只有 size_mode = target_dimensions 时宽高才算数，
     换成 scale_by / target_megapixels 之后填了也是白填，还会让人以为改成功了 */
  const sm = inputs?.size_mode;
  if (typeof sm === "string" && sm) {
    const custom = /target_dimensions|target_size|custom|manual/i.test(sm);
    if (!custom) {
      for (const n of ["target_width", "target_height", "width", "height"]) {
        if (!o[n]) o[n] = `当前尺寸模式（${sm}）不用宽高`;
      }
    }
  }
  return o;
}

function nodeLabel(node, nid) {
  const nd = node.prompt?.[nid] || {};
  const cls = String(nd.class_type || "");
  const t = String(nd._meta?.title || "").trim();
  if (t && t !== cls && t.length <= 20) return t;
  if (NODE_CN[cls]) return NODE_CN[cls];
  const short = cls.replace(/^(MiniMaxH3|MinimaxH3|MiniMax|Comfy)/i, "").replace(/^[_:]+/, "");
  return short || cls || nid;
}

/** 参数分组：asset=素材 · main=主提示词 · size/sample=参数 · model=模型 · lora=LoRA · other=其余
 *  顺序由 renderNode 决定：① 素材 → ② 参数设置 → ③ LoRA → ④ 模型选择 */
function classify(f) {
  /* 被 FIELD_PLAN 顶替上来的那一格：跟着让位的字段归类，
     这样它才真的站在原来的位置，而不是又沉回「更多参数」里 */
  if (f?._grp) return f._grp;
  if (isLoraField(f)) return "lora";
  if (f.type === "STRING" && RE_PROMPT.test(f.name)) return "main";
  const tt = targetType(f);
  if (tt === "text") return "main";
  if (tt) return "asset";
  /* 泛名 widget 按节点标题认（Float (duration) 的 value → duration） */
  const sn = semName(f);
  if (RE_MORE.test(sn)) return "other";
  if (RE_MODE.test(sn)) return "mode";
  if (RE_ASPECT.test(sn)) return "front";
  if (RE_DURATION.test(sn)) return f.driven ? "other" : "when";
  if (RE_SIZE.test(sn)) return "size";
  if (RE_SAMPLE.test(sn)) return "sample";
  if (f.type === "COMBO" && RE_MODEL.test(f.name)) return "model";
  return "other";
}

/** 这个字段属于一个 LoRA 加载节点（名字 + 它自己的强度） */
function isLoraField(f) {
  return /LoraLoader/i.test(f.cls || "") || /^lora_name$/i.test(f.name);
}

/* ==================================================================
   一采 / 二采
   ──────────────────────────────────────────────────────────────────
   双采样工作流里「步数」「种子」「强度」在两道上各有一份，名字完全一样，
   摊在一起根本分不清改的是哪一道。分道**只看采样器在图里的先后**：

     · 先把采样器按执行顺序排好：第一个采样器（含它自己）之前的节点 = 一采，
       第二个采样器（含它自己）之前、且没被前一采认领的 = 二采，再往后依次类推；
     · 两采都要用的节点（模型链、文本编码）算一采；
     · 采样器下游的解码 / 合成 / 保存节点，跟着它上游最后那个采样器走；
     · 只数**真跑采样**的节点：会产出 LATENT/画面 的才算。双时钟、步数规划、
       细节混合这类只出 MODEL/SAMPLER/SIGMAS 的「采样契约」节点不算一道，
       它们连同参数一起落进它所在的那道（真实一采之前 → 一采）。

   特例：导演台的「精修」是挂在导演台的 refine 口上的，图上它排在导演台前面，
   照连线会被判成一采 —— 语义上它是第二采，所以这条边反着记。
================================================================== */
const PASS_CN = { 0: "共用", 1: "一采", 2: "二采", 3: "三采", 4: "四采" };

/** 真正的采样执行节点（KSamplerSelect / BasicScheduler 只是参数，不算） */
function isSamplerClass(cls) {
  const c = String(cls || "");
  if (!c) return false;
  if (/Select$|Scheduler$/i.test(c)) return false;
  return /Sampler|Director/i.test(c);
}

/** 会产出画面数据的输出类型。真采样器至少得有一个：
    LATENT（KSampler / SamplerCustomAdvanced / SelfLift）、IMAGE（导演台整台）、
    MMX_DIR_REFINE（导演台·精修，画面藏在精修句柄里）。 */
const PICTURE_OUT = /^(LATENT|IMAGE|VIDEO|MMX_DIR_[A-Z]+)$/i;

/** 名字里带 Sampler 不等于真跑采样。双时钟（MiniMaxH3DualClockSamplerT8）只出
    MODEL/SAMPLER/SIGMAS 的「采样契约」，步数规划只出 SIGMAS，细节混合只出
    model/sampler/sigmas —— 这些是采样之前/之间的配置，算进道次会把一采二采数错
    （h3长视频因此被数成三采）。音频分离器同理，跟画面分道无关。 */
function isPictureSampler(cls, oi) {
  if (!isSamplerClass(cls)) return false;
  const c = String(cls || "");
  if (/Mel|Audio|Vocal|Separat/i.test(c)) return false;
  const outs = (oi || S.oi)?.[c]?.output;
  if (!Array.isArray(outs) || !outs.length) return true;   // 不认识这个类，保守当采样器
  if (outs.every(t => /AUDIO/i.test(String(t)))) return false;
  return outs.some(t => PICTURE_OUT.test(String(t)));
}

const _stageCache = new WeakMap();

/** prompt → Map(nodeId → 道次)，0 = 与采样无关 */
function computeStages(prompt, oi) {
  const hit = _stageCache.get(prompt);
  if (hit) return hit;

  const ids = Object.keys(prompt || {});
  const up = new Map(ids.map(i => [i, new Set()]));
  for (const id of ids) {
    for (const [k, v] of Object.entries(prompt[id].inputs || {})) {
      if (!Array.isArray(v) || typeof v[0] !== "string") continue;
      const src = v[0];
      if (!prompt[src]) continue;
      /* refine 口喂进来的不是数据，是「第二采」本身 —— 反过来记成 上游→下游 */
      if (/refine/i.test(k)
        && isPictureSampler(prompt[src].class_type, oi)
        && isPictureSampler(prompt[id].class_type, oi)) {
        up.get(src).add(id);
        continue;
      }
      up.get(id).add(src);
    }
  }

  /* 上游闭包（含自身），顺带挡住环 */
  const ancCache = new Map();
  const ancOf = (id) => {
    let s = ancCache.get(id);
    if (s) return s;
    s = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of up.get(cur) || []) {
        if (!s.has(p)) { s.add(p); stack.push(p); }
      }
    }
    ancCache.set(id, s);
    return s;
  };

  const out = new Map();
  const samplers = ids.filter(i => isPictureSampler(prompt[i].class_type, oi));
  if (!samplers.length) {
    for (const id of ids) out.set(id, 0);
    _stageCache.set(prompt, out);
    return out;
  }

  /* 图深度：只用来给「互不依赖的两个采样器」定先后 */
  const depth = new Map();
  const calc = (id, stack) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    let d = 0;
    for (const p of up.get(id) || []) d = Math.max(d, calc(p, stack) + 1);
    stack.delete(id);
    depth.set(id, d);
    return d;
  };

  /* 采样器排序：谁在谁上游就先跑；同层的按图深度，再同按节点号 */
  const pool = new Set(samplers);
  const done = new Set();
  const order = [];
  while (order.length < samplers.length) {
    let ready = samplers.filter(s => !done.has(s)
      && [...(up.get(s) || [])].every(p => !pool.has(p) || done.has(p)));
    if (!ready.length) ready = samplers.filter(s => !done.has(s));   // 有环就按深度硬排
    ready.sort((a, b) => calc(a, new Set()) - calc(b, new Set())
      || String(a).localeCompare(String(b), undefined, { numeric: true }));
    const pick = ready[0];
    done.add(pick);
    order.push(pick);
  }

  const selfIdx = new Map(order.map((s, i) => [s, i]));
  for (const id of ids) {
    const si = selfIdx.get(id);
    if (si != null) { out.set(id, si + 1); continue; }
    /* 上游方向：最早把它包进去的那个采样器（两采共用 → 算一采） */
    let first = 0;
    for (let i = 0; i < order.length; i++) {
      if (ancOf(order[i]).has(id)) { first = i + 1; break; }
    }
    if (first) { out.set(id, first); continue; }
    /* 采样器下游的节点：跟最后那个采样器走；连这都沾不上的（音频分离器之类）
       按「共用算一采」并进第一道，免得冒出一个孤零零的「共用」块 */
    const a = ancOf(id);
    let last = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      if (a.has(order[i])) { last = i + 1; break; }
    }
    out.set(id, last || 1);
  }

  _stageCache.set(prompt, out);
  return out;
}

/** 素材类字段：值不在候选项里 = 本机没有这个文件 */
function isMissing(f) {
  if (!Array.isArray(f.choices) || !f.choices.length) return false;
  const opts = f.choices.map(c => c && typeof c === "object" ? (c.value ?? c.name ?? c) : c);
  return typeof f.value === "string" && !opts.includes(f.value);
}

/** 只读参数块：值照摆，但不给控件 —— 这几格在 ComfyUI 里也点不到 */
function lockedBox(list, node) {
  const d = document.createElement("details");
  d.className = "locked-box";
  const sum = document.createElement("summary");
  sum.innerHTML = `<span class="lk-lock">🔒</span>`
    + `<span>ComfyUI 里改不了的参数 (${list.length})</span>`;
  d.appendChild(sum);

  const tip = document.createElement("div");
  tip.className = "lk-tip";
  tip.textContent = "这几格被节点自己的面板接管了（画幅/像素算出的宽高、时间线里的值），ComfyUI 面板里也点不到。"
    + "画布只显示、不提供修改：填了也没用，还会让工作流里出现两个互相打架的值。";
  d.appendChild(tip);

  /* 导演台和它的精修各有一份「宽度 / 高度」，不写清是谁的又分不出来 */
  const seen = new Map();
  for (const f of list) seen.set(cnName(f), (seen.get(cnName(f)) || 0) + 1);
  const dup = [...seen.values()].some(v => v > 1);
  let lastNid = null;
  const capSeen = new Map();

  for (const f of list) {
    if (dup && f.nodeId !== lastNid) {
      lastNid = f.nodeId;
      const cap = document.createElement("div");
      cap.className = "lk-cap";
      let nm = nodeLabel(node, f.nodeId);
      const cnt = (capSeen.get(nm) || 0) + 1;
      capSeen.set(nm, cnt);
      if (cnt > 1) nm += ` ${cnt}`;
      cap.textContent = nm;
      cap.title = `${f.cls} · 节点 ${f.nodeId}`;
      d.appendChild(cap);
    }
    const row = document.createElement("div");
    row.className = "lk-row";
    row.title = `${f.locked}｜${f.cls}.${f.name}｜节点 ${f.nodeId}`;
    const raw = typeof f.value === "number" && !Number.isInteger(f.value)
      ? String(parseFloat(f.value.toFixed(6)))
      : String(f.value ?? "");
    row.innerHTML = `<span class="lk-n">${esc(cnName(f))}</span>`
      + `<span class="lk-v">${esc(raw.length > 42 ? raw.slice(0, 42) + "…" : raw)}</span>`;
    d.appendChild(row);
  }
  return d;
}

function fieldControl(f, node, opt) {
  const cur = node.params[f.key] !== undefined ? node.params[f.key] : f.value;
  const cls = classify(f);
  const miss = missOf(f, cur);
  const wrap = document.createElement("div");
  wrap.className = "field" + (miss ? " missing" : "");
  wrap.dataset.key = f.key;

  const label = document.createElement("label");
  /* 参数名一律摆中文，英文原名缩成右侧小字（方便回头对工作流）；
     分了一采二采的节点，标签前面再挂一个小道次标记 */
  const cn = cnName(f);
  /* 角标已经写了道次，名称里就别再重复（second_pass_audio_strength 会翻成
     「二采音频强度」，配着角标就成了「二采 二采音频强度」） */
  const pcn = PASS_CN[f._pass] || "";
  const cnBody = pcn && cn.startsWith(pcn) ? cn.slice(pcn.length).trim() || cn : cn;
  /* 记一笔「这一格叫什么中文」：写回成功的提示要用它，
     不然 toast 里蹦出来的是 values.a 这种内部字段名 */
  if (node) (node._cn || (node._cn = {}))[f.key] = cnBody;
  /* 一采 / 二采用小色块分色：格子固定 200 宽，光靠两个字分不出来，
     分色之后一眼就能看出这一片属于哪一道 */
  const tag = f._pass ? `<em class="pass-mini p${f._pass}">${pcn}</em>` : "";
  /* 右边要挂节点角标时就不摆英文原名了 —— 一行里塞三个东西谁也看不清，
     何况角标里本来就是节点的英文类名 */
  const hasNodeTag = !!(opt && opt.tag);
  label.innerHTML = `<span class="lbl-cn">${tag}${esc(cnBody)}</span>`
    + (!hasNodeTag && cnBody !== f.name ? `<span class="lbl-en">${esc(f.fromPrim ? f.title : f.name)}</span>` : "");
  /* 200 宽装不下长名字（「参考图尺寸策略」这类），截断了就得能悬停看全名 */
  label.title = cnBody;

  const head = document.createElement("div");
  head.className = "field-head";
  head.appendChild(label);
  /* 单字段节点不再单独占一个小标题行 —— 名字缩成角标挂在标签右边，
     几个这种节点就能并排一行，底下不会留半格空白 */
  if (opt && opt.tag) {
    const t = document.createElement("em");
    t.className = "node-tag";
    t.textContent = opt.tag;
    t.title = "这一格属于「" + opt.tag + "」节点";
    head.appendChild(t);
  }
  /* 标签这一行就是拖动把手：整格可拖的话，点选输入框里的字会被当成拖拽 */
  head.draggable = true;
  head.title = head.title || "按住拖动，可以在本区内换位置";
  wrap.appendChild(head);
  /* 帧数换算的提示缩成一个 ⓘ：格子固定 50 高，再占一行就装不下了 */
  if (f._durHint) {
    const h = document.createElement("i");
    h.className = "hint-i";
    h.textContent = "ⓘ";
    h.title = "帧数由这一格自动换算";
    head.appendChild(h);
  }
  const tt = targetType(f);
  if (tt) {
    const p = document.createElement("span");
    p.className = "port in";
    p.dataset.port = `in:${node.id}:${f.key}`;
    p.dataset.kind = "in";
    p.dataset.itype = tt;
    p.title = `把「${IN_KINDS[tt].label}」节点的输出线拖到这里`;
    wrap.appendChild(p);
  }

  /* 这一格由上游算出（时长等）：不给输入框，只说明「谁在给它」，改要改上游那一格 */
  if (f.driven) {
    const w = document.createElement("div");
    w.className = "wired";
    w.title = "这一格是上游算出来的，跟着上游变 · 改上游那一格即可";
    w.innerHTML = `<span class="wired-dot"></span><span class="wired-t">由「${esc(nodeLabel(node, f.driven))}」算出</span>`;
    wrap.appendChild(w);
    return wrap;
  }

  /* 这个输入已经接了线：不显示下拉，只显示「来自谁」 */
  const inc = tt ? incomingEdge(node, f.key) : null;
  if (inc) {
    const w = document.createElement("div");
    w.className = "wired";
    w.title = "运行下游时会自动把上游的产出传进来 · 点一下断开";
    w.innerHTML = `<span class="wired-dot"></span><span class="wired-t">来自「${esc(nodeName(inc.from))}」</span><span class="wired-x">断开</span>`;
    w.onclick = () => disconnect(node, f.key);
    wrap.appendChild(w);
    return wrap;
  }

  const commit = (v, typing) => {
    node.params[f.key] = v;
    const m = missOf(f, v);
    wrap.classList.toggle("missing", m);
    const tip = wrap.querySelector(".miss-tip");
    if (m && !tip) {
      const t = document.createElement("div");
      t.className = "miss-tip";
      t.textContent = "本机没有这个文件，点下拉重新选";
      wrap.appendChild(t);
    } else if (!m && tip) tip.remove();
    scheduleSave();
    /* 改了哪一格就同步哪一格：参数、采样器、模型、LoRA 强度、提示词，一个不落。
       不写回的话，从 ComfyUI 界面跑同一份工作流用的还是文件里那个旧值 */
    queueParamPush(node, f.nodeId, f.name, v, typing);
  };
  /* 失焦（点去别处 / Tab 走）就立刻写，别让人非得敲一下回车 */
  const onBlur = () => flushNodePush(node);

  if (Array.isArray(f.choices) && f.choices.length) {
    const sel = document.createElement("select");
    const opts = f.choices.map(c => (c && typeof c === "object") ? (c.value ?? c.name ?? String(c)) : c);
    if (miss) {
      const o = document.createElement("option");
      o.value = cur; o.textContent = "⚠ " + cur + "（不存在）";
      o.selected = true; o.disabled = true;
      sel.appendChild(o);
    }
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o;
      /* 模式类下拉的选项带英文括注（v2v — 视频转视频(Video to Video)），
         一排两格里塞不下，显示时去掉括注，值仍然是完整的那个字符串 */
      op.textContent = RE_MODE.test(f.name) ? String(o).replace(/\s*\([^)]*\)\s*/g, "").trim() : o;
      if (o === cur) op.selected = true;
      sel.appendChild(op);
    }
    sel.onchange = () => commit(sel.value);
    sel.onblur = onBlur;
    wrap.appendChild(sel);
  } else if (f.type === "BOOLEAN") {
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!cur;
    cb.onchange = () => commit(cb.checked);
    cb.onblur = onBlur;
    wrap.appendChild(cb);
  } else if (cls === "main" || (typeof cur === "string" && cur.length > 60)) {
    const ta = document.createElement("textarea");
    ta.value = cur ?? "";
    ta.rows = Math.min(6, Math.max(3, Math.ceil(String(cur ?? "").length / 42)));
    ta.oninput = () => commit(ta.value, true);
    ta.onblur = onBlur;
    wrap.appendChild(ta);
  } else if (f.type === "INT" || f.type === "FLOAT") {
    const inp = document.createElement("input");
    inp.type = "number";
    if (f.min !== undefined) inp.min = f.min;
    if (f.max !== undefined) inp.max = f.max;
    if (f.step !== undefined) inp.step = f.step;
    else if (f.type === "FLOAT") inp.step = "any";      // 不设的话默认 step=1，12.2 会被当成非法步长
    /* 浮点尾巴太脏（0.7000000000000002）—— 只修显，不动实际值 */
    inp.value = typeof cur === "number" && !Number.isInteger(cur)
      ? String(parseFloat(cur.toFixed(6))) : (cur ?? 0);
    const readNum = () => {
      const raw = String(inp.value ?? "").trim();
      if (raw === "") return undefined;                  // 正在删空，先别写个 0 出去
      /* loose = 接线喂进来的常量（时长这类）。它不是节点声明的 INT 格子，
         用户敲 12.2 就得原样留下 —— 以前按 INT 走 parseInt，0.2 秒静默蒸发 */
      const v = (f.type === "INT" && !f.loose) ? parseInt(raw, 10) : parseFloat(raw);
      return Number.isFinite(v) ? v : undefined;         // 「-」「1.」这种半截先不管
    };
    /* 边敲边记：敲完不用回车，停手 3 秒自己写回 ComfyUI */
    inp.oninput = () => { const v = readNum(); if (v !== undefined) commit(v, true); };
    inp.onchange = () => { const v = readNum(); if (v !== undefined) commit(v); flushNodePush(node); };
    inp.onblur = onBlur;
    wrap.appendChild(inp);
  } else {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = cur ?? "";
    inp.oninput = () => commit(inp.value, true);
    inp.onchange = () => commit(inp.value);
    inp.onblur = onBlur;
    wrap.appendChild(inp);
  }

  if (miss) {
    const t = document.createElement("div");
    t.className = "miss-tip";
    t.textContent = "本机没有这个文件，点下拉重新选";
    wrap.appendChild(t);
  }
  return wrap;
}

function missOf(f, v) {
  if (!Array.isArray(f.choices) || !f.choices.length) return false;
  const opts = f.choices.map(c => (c && typeof c === "object") ? (c.value ?? c.name ?? c) : c);
  return typeof v === "string" && !opts.includes(v);
}

/* ==================================================================
   素材槽 —— 数量取「工作流内置上限」
   ──────────────────────────────────────────────────────────────────
   · 上限只从 object_info 的 COMFY_AUTOGROW_V3.max 读（h3 = 图 9 /
     视频 3 / 音频 3），不写死，换工作流自动变；
   · 工作流里现成的 LoadImage / LoadVideoUI / LoadAudio 按「连到第几个
     参考槽」配对；连的是首帧这种固定口就不算素材槽，照旧渲染；
   · 画面只摆「已有素材」的槽，空槽收在「＋」后面 —— 没输入的接口隐藏。
================================================================== */
const AG_TYPE = "COMFY_AUTOGROW_V3";
const AG_KIND = { IMAGE: "image", AUDIO: "audio", VIDEO: "video" };
const KIND_CN = { image: "图片", video: "视频", audio: "音频" };
const KIND_NAME = { image: "参考图", video: "参考视频", audio: "参考音频" };
/* 需要新造加载节点时用哪一类（都是本机 ComfyUI 核心/自带节点） */
const LOADER_OF = { image: "LoadImage", video: "LoadVideoUI", audio: "LoadAudio" };

/** 一个节点上的全部 autogrow 组（含动态下拉当前分支里的） */
function autoGrowGroups(info, cur) {
  const out = [];
  const scan = (sec, prefix) => {
    for (const [name, spec] of Object.entries(sec || {})) {
      if (!Array.isArray(spec) || !spec.length) continue;
      const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
      if (t === AG_TYPE) {
        const o = (spec[1] && typeof spec[1] === "object") ? spec[1] : {};
        /* prefix/min/max 实际挂在 template 里，个别版本挂在外层，两边都认 */
        const tp = (o.template && typeof o.template === "object") ? o.template : {};
        const tm = tp.input || o.input || {};
        let media = "";
        for (const s2 of ["required", "optional"]) {
          for (const sp of Object.values(tm[s2] || {})) {
            const tt = Array.isArray(sp?.[0]) ? "COMBO" : String(sp?.[0] || "");
            if (AG_KIND[tt]) { media = tt; break; }
          }
          if (media) break;
        }
        const kind0 = AG_KIND[media];
        if (!kind0) continue;
        /* ref_videos 接的是 IMAGE 帧批次，但语义是视频；ref_video_audios 是音轨 */
        let kind = kind0;
        if (/video/i.test(name) && !/audio/i.test(name)) kind = "video";
        else if (/audio/i.test(name)) kind = "audio";
        out.push({
          name, kind, media: kind0,
          group: prefix + name,
          item: tp.prefix || o.prefix || (name + "_"),
          min: tp.min ?? o.min ?? 0,
          max: tp.max ?? o.max ?? 0,
        });
      } else if (/^COMFY_.*COMBO/i.test(t)) {
        /* 动态下拉：只扫当前选中那一支（子输入的 API 键就是「父名.子名」） */
        const hit = (spec[1]?.options || []).find(o => (o?.key ?? o?.name) === cur?.[name]);
        if (!hit) continue;
        for (const s2 of ["required", "optional"]) scan(hit?.inputs?.[s2], prefix + name + ".");
      }
    }
  };
  for (const s of ["required", "optional"]) scan(info?.input?.[s], "");
  return out;
}

/** 读 UI 节点某个 widget 的值（named / 数组两种形态都吃） */
function uiWidgetValue(n, info, want) {
  const named = (n.widgets_values_named && typeof n.widgets_values_named === "object") ? n.widgets_values_named
    : (!Array.isArray(n.widgets_values) && n.widgets_values && typeof n.widgets_values === "object") ? n.widgets_values
      : null;
  const arr = Array.isArray(n.widgets_values) ? n.widgets_values : null;
  let idx = 0;
  for (const w of listWidgets(info)) {
    const v = named ? named[w.name] : (arr ? arr[idx] : undefined);
    if (arr) idx += 1 + (w.extraAfter ? 1 : 0);
    if (w.name === want) return v === undefined ? w.default : v;
  }
  return undefined;
}

const slotBlank = (v) => v === undefined || v === null || v === "" || v === "None" || v === "none";

/**
 * 汇总一个工作流节点的素材槽。
 * @returns {{has:boolean, limits:{image:number,video:number,audio:number},
 *            groups:Array, slots:Array}}
 *   slots[i] = {kind, idx, value, loader:{id,cls,field,byp,mute,ext}}
 */
function collectAssetSlots(node) {
  const oi = S.oi || {};
  const out = { has: false, limits: { image: 0, video: 0, audio: 0 }, groups: [], slots: [] };
  if (!node.prompt) return out;

  /* ① autogrow 组 = 上限来源 */
  for (const [pid, nd] of Object.entries(node.prompt)) {
    const info = oi[nd.class_type];
    if (!info) continue;
    for (const g of autoGrowGroups(info, nd.inputs)) out.groups.push({ pid, ...g });
  }
  if (!out.groups.length) return out;
  out.has = true;
  /* 同类型可能有多个 autogrow 组（h3 的 ref_audios 与 ref_video_audios），
     只拿一个当槽位来源（优先名字不带 video 的）；其余组占用时照旧按普通素材显示 */
  const mainOf = {};
  for (const g of out.groups) {
    const cur = mainOf[g.kind];
    if (!cur) { mainOf[g.kind] = g; continue; }
    if (/video/i.test(cur.name) && !/video/i.test(g.name)) mainOf[g.kind] = g;
  }
  for (const k of ["image", "video", "audio"]) if (mainOf[k]) out.limits[k] = mainOf[k].max;
  /* 上限全是 0 的组（有些节点声明了 autogrow 但一个槽也不给）等于没有，
     这时照旧按普通素材字段渲染，别在素材区塞一堆空按钮 */
  if (!out.limits.image && !out.limits.video && !out.limits.audio) {
    out.has = false;
    return out;
  }
  out.mainOf = mainOf;

  /* ② 工作流里的素材加载节点 */
  const dstName = new Map();
  for (const n of node.uiWf?.nodes || []) {
    for (const s of n.inputs || []) if (s.link != null) dstName.set(s.link, s.name);
  }
  const loaders = [];
  for (const n of node.uiWf?.nodes || []) {
    const info = oi[n.type];
    if (!info) continue;
    const w = listWidgets(info).find(w => {
      const tt = targetType({ cls: n.type, name: w.name, type: w.type });
      return tt === "image" || tt === "video" || tt === "audio";
    });
    if (!w) continue;
    const kind = targetType({ cls: n.type, name: w.name, type: w.type });

    /* 它连到哪：是参考槽（ref_image_3）还是固定口（first_frame） */
    let hit = null, fixed = false;
    for (const o of n.outputs || []) {
      for (const lid of (o.links || [])) {
        const nm = dstName.get(lid);
        if (!nm) continue;
        const g = out.groups.find(g => nm.startsWith(g.group + "." + g.item));
        if (g) {
          const k = parseInt(nm.slice((g.group + "." + g.item).length), 10);
          if (Number.isInteger(k)) {
            /* 只有主组上的连线算槽位，副组（视频音轨那类）当固定用途 */
            if (mainOf[g.kind] && mainOf[g.kind].group === g.group) hit = { kind: g.kind, idx: k };
            else fixed = true;
            continue;
          }
        }
        fixed = true;
      }
    }
    const key = String(n.id) + "|" + w.name;
    const pv = node.params?.[key];
    const on = (node.assetOn || []).includes(String(n.id));
    loaders.push({
      id: String(n.id), cls: n.type, field: w.name, kind,
      value: pv !== undefined ? pv : uiWidgetValue(n, info, w.name),
      byp: (n.mode === 4 && !on), mute: (n.mode === 2 && !on),
      idx: hit && hit.kind === kind ? hit.idx : null,
      fixed,
    });
  }
  /* 画布自己补出来的加载节点（刷新后按 extraSlots 重建） */
  for (const e of node.extraSlots || []) {
    const info = oi[e.cls];
    if (!info) continue;
    const key = e.id + "|" + e.field;
    loaders.push({
      id: e.id, cls: e.cls, field: e.field, kind: e.kind,
      value: node.params?.[key], byp: false, mute: false,
      idx: e.idx, ext: true,
    });
  }

  /* ③ 配槽：有明确槽号的先占，其余补空位（固定口的节点不进池） */
  const used = { image: new Set(), video: new Set(), audio: new Set() };
  const take = (L, idx) => {
    if (used[L.kind].has(idx)) return;
    used[L.kind].add(idx);
    out.slots.push({
      kind: L.kind, idx, value: L.value,
      gkey: mainOf[L.kind]?.group || null, loader: L,
    });
  };
  for (const L of loaders) {
    if (L.fixed && L.idx == null) continue;
    if (L.idx == null) continue;
    take(L, L.idx);
  }
  for (const L of loaders) {
    if (L.fixed && L.idx == null) continue;
    if (L.idx != null) continue;
    const max = out.limits[L.kind] || 0;
    let idx = -1;
    for (let k = 0; k < max; k++) if (!used[L.kind].has(k)) { idx = k; break; }
    if (idx >= 0) take(L, idx);
  }
  return out;
}

/** 该类型还空着的槽号（0..max-1） */
function findFreeSlot(info, kind) {
  const max = info.limits[kind] || 0;
  const used = new Set(info.slots.filter(s => s.kind === kind).map(s => s.idx));
  for (let k = 0; k < max; k++) if (!used.has(k)) return k;
  return null;
}

/** 造一个加载节点塞进 prompt（值先留空，用户选了文件才真正提交） */
function injectLoader(node, kind, idx) {
  const cls = LOADER_OF[kind];
  const info = S.oi?.[cls];
  if (!info) { toast(`本机没有 ${cls} 节点，加不了${KIND_CN[kind]}`, "err"); return null; }
  const ws = listWidgets(info);
  const field = ws.find(w => targetType({ cls, name: w.name, type: w.type }) === kind)?.name;
  if (!field) return null;
  const inputs = {};
  for (const w of ws) if (w.default !== undefined) inputs[w.name] = w.default;
  const id = "xy_" + kind + "_" + idx + "_" + Math.random().toString(36).slice(2, 5);
  node.prompt[id] = { class_type: cls, inputs, _meta: { title: `${KIND_NAME[kind]} ${idx + 1}` } };
  node.extraSlots = [...(node.extraSlots || []), { id, kind, idx, cls, field }];
  return { id, cls, field };
}

/** 按 extraSlots 把上次注入的加载节点重建回 prompt（刷新/导入后用） */
function restoreExtraSlots(node) {
  for (const e of node.extraSlots || []) {
    if (node.prompt[e.id]) continue;
    const info = S.oi?.[e.cls];
    if (!info) continue;
    const inputs = {};
    for (const w of listWidgets(info)) if (w.default !== undefined) inputs[w.name] = w.default;
    node.prompt[e.id] = { class_type: e.cls, inputs, _meta: { title: `${KIND_NAME[e.kind]} ${e.idx + 1}` } };
  }
}

/** 把槽里选好的素材真正接进 prompt（空槽不接，免得提交时校验失败） */
function wireAssetSlots(node) {
  if (!node.prompt) return;
  const info = collectAssetSlots(node);
  const offSet = new Set(node.assetOff || []);
  for (const s of info.slots) {
    const v = s.value;
    if (slotBlank(v)) {
      if (s.loader.ext && node.prompt[s.loader.id]) delete node.prompt[s.loader.id];
      continue;
    }
    /* 用户点过「不启用」的槽：这一轮不接线（提交前还会再摘一遍，双保险） */
    if (offSet.has(String(s.loader.id))) continue;
    /* 工作流里本来就 bypass 的槽：用户没点过就不动它，保持原样 */
    if ((s.loader.byp || s.loader.mute) && !(node.assetOn || []).includes(s.loader.id)) continue;
    /* 加载节点没在 prompt 里（被 bypass 或画布新造）→ 补一条 */
    if (!node.prompt[s.loader.id]) {
      const ext = s.loader.ext ? (node.extraSlots || []).find(x => x.id === s.loader.id) : null;
      const ui = (node.uiWf?.nodes || []).find(n => String(n.id) === s.loader.id);
      const cls = ext ? ext.cls : ui?.type;
      const li = cls ? S.oi?.[cls] : null;
      if (!cls || !li) continue;
      const inputs = {};
      if (ext) {
        for (const w of listWidgets(li)) if (w.default !== undefined) inputs[w.name] = w.default;
      } else {
        for (const w of listWidgets(li)) {
          const val = uiWidgetValue(ui, li, w.name);
          if (val !== undefined) inputs[w.name] = val;
        }
      }
      inputs[s.loader.field] = v;
      node.prompt[s.loader.id] = {
        class_type: cls, inputs,
        _meta: { title: ext ? `${KIND_NAME[ext.kind]} ${ext.idx + 1}` : (ui?.title || cls) },
      };
      if (ui) ui.mode = 0;              // 画布上填了素材 = 明确要用它，解掉 bypass
      node.assetOn = [...new Set([...(node.assetOn || []), s.loader.id])];
      s.loader.byp = false;
    } else {
      node.prompt[s.loader.id].inputs[s.loader.field] = v;
    }
    /* 同一个参考槽可能挂在多个节点上（h3 的 LOW/HIGH 两套条件），一起连；
       只认同一个 autogrow 组，别串到视频音轨那类副组上 */
    for (const g of info.groups) {
      if (g.group !== s.gkey) continue;
      const t = node.prompt[g.pid];
      if (!t) continue;
      t.inputs[g.group + "." + g.item + s.idx] = [s.loader.id, 0];
    }
  }
}

/** 点「＋」：把下一个空槽摆出来；池里没有现成节点就造一个 */
function addAssetSlot(node, kind) {
  const info = collectAssetSlots(node);
  const mine = info.slots.filter(s => s.kind === kind).sort((a, b) => a.idx - b.idx);
  const shownNow = node.emptyShown || [];
  /* ① 先露出工作流里本来就空着的槽（bypass 的 "None" 那些） */
  const hidden = mine.find(s => slotBlank(s.value) && !shownNow.includes(`${kind}:${s.idx}`));
  if (hidden) {
    node.emptyShown = [...shownNow, `${kind}:${hidden.idx}`];
  } else {
    /* ② 槽位还没到上限 → 补一个加载节点 */
    const free = findFreeSlot(info, kind);
    if (free == null) { toast(`${KIND_NAME[kind]}已经到上限（${info.limits[kind]} 个）`, ""); return; }
    if (!injectLoader(node, kind, free)) return;
    node.emptyShown = [...shownNow, `${kind}:${free}`];
  }
  renderNode(node);
  save();
  const at = node.emptyShown[node.emptyShown.length - 1];
  nodeEl(node)?.querySelector(`[data-slot="${at}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** 槽 → 一个可交给 assetCard 渲染的字段 */
function slotField(node, s) {
  const key = s.loader.id + "|" + s.loader.field;
  const hit = buildFields(node).find(f => f.key === key);
  if (hit) return hit;
  const spec = S.oi?.[s.loader.cls]?.input?.required?.[s.loader.field]
    || S.oi?.[s.loader.cls]?.input?.optional?.[s.loader.field];
  const choices = Array.isArray(spec?.[0]) ? spec[0]
    : (Array.isArray(spec?.[1]?.options) ? spec[1].options : null);
  return {
    key, nodeId: s.loader.id, name: s.loader.field, type: "COMBO",
    choices, value: s.value,
    title: `${s.loader.cls} ${s.loader.id}`,
    cls: s.loader.cls,
  };
}

/** 素材被改（上传 / 换文件）：写值 → 接线 → 重画 */
function commitAsset(node, f, v) {
  node.params[f.key] = v;
  /* 换图 / 换模型 / 传文件：文件名本身也是工作流里的一格，一起写回去，
     不然画布上换了图，回 ComfyUI 打开还是老图 */
  queueParamPush(node, f.nodeId, f.name, v);
  /* 用户在这里动手 = 明确要用这个素材节点，bypass 的也要救回来 */
  if (f.nodeId) {
    node.assetOn = [...new Set([...(node.assetOn || []), String(f.nodeId)])];
    node.assetOff = (node.assetOff || []).filter(x => x !== String(f.nodeId));
  }
  wireAssetSlots(node);
  renderNode(node);
  save();
  /* 工作流里本来是 bypass 的，选完文件后画布已经把它救活了，文件也要跟着改，
     否则下次刷新恢复，这个节点又被旁路，刚选的素材白搭 */
  if (syncCfg.push && f.nodeId) pushModesToComfy(node, { quiet: true }).catch(() => { });
}

/** 停用 / 启用一个素材节点：停用的不参与提交，节点和文件都留着 */
function setAssetOff(node, loaderId, off) {
  const id = String(loaderId);
  if (!id) return;
  if (off) {
    node.assetOff = [...new Set([...(node.assetOff || []), id])];
    node.assetOn = (node.assetOn || []).filter(x => x !== id);
  } else {
    node.assetOff = (node.assetOff || []).filter(x => x !== id);
    node.assetOn = [...new Set([...(node.assetOn || []), id])];
  }
  wireAssetSlots(node);
  renderNode(node);
  save();

  /* 同步给 ComfyUI：否则画布上停了，从 ComfyUI 界面跑那个工作流照样用它 */
  const base = off ? "已停用：这次生成不提交它" : "已启用：这次生成会用上它";
  if (!syncCfg.push) { toast(base, off ? "" : "ok"); return; }
  pushModesToComfy(node, { quiet: true }).then(r => {
    if (r.error) return;                                   // 失败已在里面报过
    if (r.changed) toast(`${base} · 已写回 ComfyUI 文件（${r.changed} 个节点）；ComfyUI 里正开着这份工作流的话，重新打开一次才看得到`, off ? "" : "ok", 5200);
    else if (r.notInFile) toast(`${base} · 这是画布补出来的素材，ComfyUI 文件里没有它`, "", 4200);
    else toast(`${base} · ComfyUI 那边已是一致状态`, off ? "" : "ok");
  });
}

/* ---------------- LoRA 启停 ---------------- */
/** 某个输入口在 object_info 里声明的类型（MODEL / CLIP / IMAGE …） */
function inputTypeOf(cls, name) {
  const info = S.oi?.[cls];
  const spec = info?.input?.required?.[name] || info?.input?.optional?.[name];
  if (!Array.isArray(spec)) return "";
  return Array.isArray(spec[0]) ? "COMBO" : String(spec[0] || "");
}

/** 停用的 LoRA 从提交副本里摘掉，下游接回它上游（只动 LoraLoader，素材另有一套） */
function bypassLoraInPrompt(prompt, offIds) {
  const off = new Set((offIds || []).map(String));
  if (!off.size) return 0;
  const target = Object.keys(prompt || {})
    .filter(id => off.has(id) && /lora/i.test(String(prompt[id]?.class_type || "")));
  if (!target.length) return 0;

  /* 按「输出槽类型」找本节点的同类输入：LoraLoader 的 MODEL / CLIP 是两路，接错就变味 */
  const upstreamFor = (id, slot) => {
    const nd = prompt[id];
    if (!nd) return null;
    const outs = S.oi?.[nd.class_type]?.output || [];
    const want = String(outs[Number(slot)] || "");
    const ups = Object.entries(nd.inputs || {}).filter(([, v]) => Array.isArray(v));
    const typed = want ? ups.find(([k]) => inputTypeOf(nd.class_type, k) === want) : null;
    const pick = typed || (ups.length === 1 ? ups[0] : null);
    return pick ? [String(pick[1][0]), pick[1][1]] : null;
  };
  const resolve = (src, slot, guard = 0) => {
    if (guard > 32) return null;
    if (!off.has(String(src)) || !prompt[src]) return [String(src), slot];
    const up = upstreamFor(String(src), slot);
    return up ? resolve(up[0], up[1], guard + 1) : null;
  };

  let n = 0;
  /* 先替换引用，再删节点：递归里还要读它自己的输入 */
  for (const nd of Object.values(prompt)) {
    if (!nd?.inputs) continue;
    for (const [k, v] of Object.entries(nd.inputs)) {
      if (!Array.isArray(v)) continue;
      const r = resolve(String(v[0]), v[1]);
      if (!r || (String(r[0]) === String(v[0]) && r[1] === v[1])) continue;
      nd.inputs[k] = r;
      n++;
    }
  }
  for (const id of target) delete prompt[id];
  return n;
}

/** UI 工作流里一条 link 的上游，落到 prompt 里真实存在的那个节点（沿旁路链往上找） */
function promptSourceOf(node, linkId, guard = 0) {
  if (guard > 32) return null;
  const links = node.uiWf?.links || [];
  const lk = links.find(l => Array.isArray(l) && l[0] === linkId);
  if (!lk) return null;
  const srcId = String(lk[1]), slot = lk[2];
  if (node.prompt?.[srcId]) return [srcId, slot];
  /* 上游被旁路 / 静音：convert 时被穿透了，接着往上找同类型的口 */
  const src = (node.uiWf?.nodes || []).find(n => String(n.id) === srcId);
  if (!src) return null;
  const ups = (src.inputs || []).filter(s => s.link != null);
  const outType = src.outputs?.[slot]?.type;
  const pick = ups.find(s => !outType || s.type === outType) || ups[0];
  return pick ? promptSourceOf(node, pick.link, guard + 1) : null;
}

/**
 * 把 ComfyUI 里被旁路的 LoRA 救回 prompt。
 * 光把它加回来不够 —— convert 时它被旁路，下游早就穿透到它上游去了，
 * 所以还要照着 uiWf 的连线把下游重新挂到它身上，否则新加的这个是孤儿，白加。
 */
function reviveLora(node, wfNode) {
  const cls = wfNode?.type;
  const li = cls ? S.oi?.[cls] : null;
  if (!cls || !li || !node.prompt) return false;
  const id = String(wfNode.id);
  const inputs = {};
  for (const w of listWidgets(li)) {
    const val = uiWidgetValue(wfNode, li, w.name);
    if (val !== undefined) inputs[w.name] = val;
  }
  for (const slot of wfNode.inputs || []) {
    if (slot?.link == null || !slot.name) continue;
    const src = promptSourceOf(node, slot.link);
    if (src) inputs[slot.name] = src;
  }
  node.prompt[id] = { class_type: cls, inputs, _meta: { title: wfNode.title || cls } };

  /* 下游挂回来：uiWf 里从这一节点出发的每条线，把目标口指回它 */
  let wired = 0;
  for (const lk of (node.uiWf?.links || [])) {
    if (!Array.isArray(lk) || String(lk[1]) !== id) continue;
    const toId = String(lk[3]);
    const to = (node.uiWf.nodes || []).find(n => String(n.id) === toId);
    const nm = to?.inputs?.[lk[4]]?.name;
    if (!nm || !node.prompt[toId]?.inputs) continue;
    node.prompt[toId].inputs[nm] = [id, lk[2]];
    wired++;
  }
  return { restored: true, wired };
}

/** 停用 / 启用一个 LoRA：提交时旁路它，并把 ComfyUI 里那份工作流同步成同样的状态 */
function setLoraOff(node, loraId, off) {
  const id = String(loraId || "");
  if (!id) return;
  if (off) {
    node.assetOff = [...new Set([...(node.assetOff || []), id])];
    node.assetOn = (node.assetOn || []).filter(x => x !== id);
  } else {
    node.assetOff = (node.assetOff || []).filter(x => x !== id);
    node.assetOn = [...new Set([...(node.assetOn || []), id])];
    /* 这个 LoRA 在 prompt 里压根没有（工作流里本来就是旁路）→ 现建一条回来 */
    if (!node.prompt?.[id]) {
      const ui = (node.uiWf?.nodes || []).find(n => String(n.id) === id);
      if (ui) reviveLora(node, ui);
    }
  }
  renderNode(node);
  save();

  const base = off ? "已停用：这次生成不加载这个 LoRA" : "已启用：这个 LoRA 重新参与生成";
  if (!syncCfg.push) { toast(base, off ? "" : "ok"); return; }
  pushModesToComfy(node, { quiet: true }).then(r => {
    if (r.error) return;
    if (r.changed) toast(`${base} · 已写回 ComfyUI 文件（${r.changed} 个节点）；ComfyUI 里正开着这份工作流的话，重新打开一次才看得到`, off ? "" : "ok", 5200);
    else if (r.notInFile) toast(`${base} · 这是画布补出来的节点，ComfyUI 文件里没有它`, "", 4200);
    else toast(`${base} · ComfyUI 那边已是一致状态`, off ? "" : "ok");
  });
}

/* ---------------- 节点 DOM ---------------- */
/**
 * 这个字段能不能接上游的东西，能接的话要哪种。
 * 返回 "image" | "video" | "audio" | "text" | null
 */
function targetType(f) {
  const cls = String(f.cls || "");
  const name = String(f.name || "");
  if (/^LoadImage/i.test(cls) && /^image$/i.test(name)) return "image";
  /* 视频：VHS_LoadVideo / CS_Load_Video 用 video，内置 LoadVideo 用的是 file */
  if (/(Load|Upload).*Video|VHS_LoadVideo|LoadVideoUI/i.test(cls) && /^(video|file)$/i.test(name)) return "video";
  /* 音频：LoadAudio / VHS_LoadAudioUpload */
  if (/(Load|Upload).*Audio|VHS_LoadAudio/i.test(cls) && /^(audio|file)$/i.test(name)) return "audio";
  /* 文本：名字像提示词的字符串字段（prompt / text / positive / negative…）
     注意这里不能回头调 classify()：classify 反过来要问 targetType，会无限递归 */
  if (f.type === "STRING" && RE_PROMPT.test(name)) return "text";
  return null;
}

/* ---------------- 连线 ---------------- */
/** 这个字段上接进来的是哪条线 */
function incomingEdge(node, key) {
  return S.edges.find(e => e.to === node.id && e.key === key) || null;
}

/** 按 id 取画布节点名 */
function nodeName(id) {
  return S.nodes.find(n => n.id === id)?.name || "?";
}

/** 断开某个输入上的线 */
function disconnect(node, key) {
  const before = S.edges.length;
  S.edges = S.edges.filter(e => !(e.to === node.id && e.key === key));
  if (S.edges.length === before) return;
  view.setEdges(S.edges);
  renderNode(node);
  save();
  toast("已断开连线", "");
}

/**
 * 从上游节点取能喂给下游的东西。
 * 返回 {value} 表示直接当文本用；返回 {filename,type,direct} 表示是个文件。
 */
function upstreamValue(src, want = "image") {
  if (!src) return null;
  if (src.kind === "input") {
    /* 这个素材节点接住了上游产出，就用产出（它自己那份本地文件还在，只是暂时被顶替） */
    if (src.pulled) {
      const p = src.pulled;
      if (p.kind === "text") return { value: p.value || "" };
      if (!p.value) return null;
      return { filename: p.value, subfolder: p.sub || "", type: p.sType || "output",
        direct: p.sType === "input" && !p.sub };
    }
    if (src.inKind === "text") return { value: src.value || "" };
    if (!src.value) return null;
    return { filename: src.value, subfolder: "", type: "input", direct: true };
  }
  if (src.kind === "content") {
    if (src.inKind === "text") return { value: src.value || "" };
    if (!src.value) return null;
    const t = src.sType || "output";
    /* 带子目录的 input 文件不能直接给 LoadImage（它只认根目录里的名字），得重传一次 */
    return { filename: src.value, subfolder: src.sub || "", type: t, direct: t === "input" && !src.sub };
  }
  const r = src.result;
  if (!r) return null;
  const pool = want === "video" ? (r.videos || []) : [...(r.images || []), ...(r.gifs || [])];
  const hit = pool.find(x => x.filename);
  if (!hit) return null;
  return { ...hit, direct: hit.type === "input" };
}

/* ---------------- 运行结果 → 内容节点 ---------------- */
function pickResult(res, kind) {
  if (kind === "text") {
    const t = (res.texts || [])[0];
    return t ? { value: t.text } : null;
  }
  if (kind === "image") {
    const it = [...(res.images || []), ...(res.gifs || [])][0];
    return it || null;
  }
  if (kind === "video") return (res.videos || [])[0] || null;
  return null;
}

function applyResult(n, kind, got) {
  if (kind === "text") {
    n.value = got.value || "";
    n.sub = ""; n.sType = ""; n.src = "";
  } else {
    n.value = got.filename;
    n.sub = got.subfolder || "";
    n.sType = got.type || "output";
    n.src = api.viewUrl(got);
  }
  n.name = n.name || `结果 · ${WANT_CN[kind]}`;
  n.status = "done";
  n.error = "";
}

/** 把产出写进「素材节点」：它自己那份本地文件不动，产出单独记在 pulled 里，
    想换回来点一下「改用本地文件」就行 */
function applyPulled(n, kind, got, from) {
  n.pulled = {
    kind,
    value: kind === "text" ? (got.value || "") : got.filename,
    sub: kind === "text" ? "" : (got.subfolder || ""),
    sType: kind === "text" ? "" : (got.type || "output"),
    from: from?.id || "",
    fromName: from?.name || "",
    at: Date.now(),
  };
  n.status = "done";
  n.error = "";
}

function makeContentNode(kind, got, x, y, name) {
  const node = {
    id: uid(), kind: "content", inKind: kind,
    name: name || `结果 · ${WANT_CN[kind]}`,
    x, y, params: {}, value: "", sub: "", sType: "", src: "",
    /* 图像 / 视频结果节点默认给宽一些：默认 360px 的框型装不下 640px 的预览 */
    w: (kind === "image" || kind === "video") ? 520 : undefined,
    status: "done", error: "", result: null,
  };
  applyResult(node, kind, got);
  S.nodes.push(node);
  mountNode(node);
  $("#empty-tip").classList.add("hide");
  return node;
}

/**
 * 把这次产出接到下游节点上。
 * · 连的是「素材节点」（图像 / 视频 / 音频 / 文本）：产出写进它，节点里直接显示；
 * · 连的是自动生成的「结果节点」：原地更新；
 * · 没连到这个类型：在右边新建一个结果节点并连上。
 * 返回 { made, mismatch }，mismatch 是「连了但类型对不上」的说明。
 */
function syncOutputs(node, res) {
  const kinds = [];
  if ((res.texts || []).length) kinds.push("text");
  if ((res.images || []).length || (res.gifs || []).length) kinds.push("image");
  if ((res.videos || []).length) kinds.push("video");
  if (!kinds.length) return { made: [], mismatch: [] };

  const linked = S.edges
    .filter(e => e.from === node.id && !e.key)
    .map(e => S.nodes.find(n => n.id === e.to))
    .filter(n => n && (n.kind === "content" || n.kind === "input"));

  const wp = view.getPos(node.id);
  const wfEl = nodeEl(node);
  const cx = wp.x + (wfEl?.offsetWidth || 360) + 96;
  let cy = wp.y;
  const made = [];
  const mismatch = new Set();

  for (const kind of kinds) {
    const got = pickResult(res, kind);
    if (!got) continue;
    let target = linked.find(n => n.inKind === kind);
    if (target) {
      if (target.kind === "input") applyPulled(target, kind, got, node);
      else applyResult(target, kind, got);
      renderNode(target);
    } else {
      target = makeContentNode(kind, got, cx, cy);
      S.edges.push({ from: node.id, to: target.id, key: null, type: kind });
      cy += (nodeEl(target)?.offsetHeight || 220) + 26;
    }
    made.push(target);
  }
  /* 连了节点但类型对不上（比如 h3 出视频、连的是图片节点）——说清楚，别让人干等 */
  for (const n of linked) {
    if (!kinds.includes(n.inKind)) {
      mismatch.add(`「${n.name}」要${WANT_CN[n.inKind] || "别的"}，这次出来的是${kinds.map(k => WANT_CN[k]).join("、")}`);
    }
  }
  view.setEdges(S.edges);
  return { made, mismatch: [...mismatch] };
}

/** 看看某个 prompt 字段要的是哪种数据 */
function fieldWant(prompt, nid, field) {
  const ct = prompt[nid]?.class_type || "";
  if (/audio/i.test(field) || /Audio/i.test(ct)) return "audio";
  if (/video/i.test(field) || /Video/i.test(ct)) return "video";
  if (/image/i.test(field) || /^LoadImage/i.test(ct)) return "image";
  return "text";
}

function nodeIco(node) {
  if (node.kind === "input" || node.kind === "content") return IN_KINDS[node.inKind]?.ico || "📄";
  if (node.kind === "workflow") return node.wfKind === "video" ? "🎬" : "🖼";
  return "📄";
}

/** 输出口类型：素材/内容节点按自己的类型标；
    工作流节点能判则判（生图流=image / 视频流=video / 音频流=audio），
    判不了才标 media 兜底 —— 这样从输出口拖线时只亮真正匹配的输入口，
    与从输入口拉线时的分流反馈一致（匹配的亮、对不上的暗、松手不符会拒） */
function outTypeOf(node) {
  if (node.kind === "input" || node.kind === "content") return IN_KINDS[node.inKind]?.otype || "text";
  if (node.kind === "workflow" && ["image", "video", "audio", "text"].includes(node.wfKind)) return node.wfKind;
  return "media";
}

function mountNode(node) {
  const el = document.createElement("div");
  el.className = "node"
    + (node.kind === "input" ? " in-node" : "")
    + (node.kind === "content" ? " content-node" : "");
  const isContent = node.kind === "content";
  el.innerHTML = `
    <div class="node-head">
      <span class="n-ico">${nodeIco(node)}</span>
      <span class="n-title" title="${esc(node.name)}">${esc(node.name)}</span>
      ${isContent ? `<span class="ct-tag">${WANT_CN[node.inKind] || ""}</span>` : ""}
      <div class="node-status"></div>
      <span class="n-actions">
        ${node.kind === "workflow" ? `<button class="nbtn sync" title="与 ComfyUI 同步">⟳</button>` : ""}
        ${node.kind === "workflow" ? `<button class="nbtn run" title="运行 (Ctrl+Enter)">▶</button>` : ""}
        <button class="nbtn collapse" title="折叠/展开">▾</button>
        <button class="nbtn del" title="删除">✕</button>
      </span>
    </div>
    <div class="node-body"></div>
    <div class="node-out hide"></div>
    ${isContent || node.kind === "input" ? `<span class="port in-edge" data-port="in:${node.id}" data-kind="in"
        data-itype="${IN_KINDS[node.inKind]?.otype || "media"}"
        title="${node.kind === "input"
          ? "把工作流节点的输出线拖到这里：跑完的产出会在这个节点里显示，也能接着喂给下游"
          : "把工作流节点的输出线拖到这里"}"></span>` : ""}
    <div class="node-ports"><span class="port" data-port="out:${node.id}" data-kind="out"
      data-otype="${outTypeOf(node)}" title="拖这条线到下游节点的输入口"></span></div>
    <span class="node-resize" title="拖动改变大小 · 双击恢复自适应"></span>`;
  view.addNode(node.id, el, node.x ?? 0, node.y ?? 0, node.w, node.h);
  el.querySelector(".del").onclick = (e) => { e.stopPropagation(); removeNode(node.id); };
  /* 节点左上角那个接收产出的口：点一下断开（产出留在节点里，不跟着消失） */
  const ie = el.querySelector(".port.in-edge");
  if (ie) {
    ie.addEventListener("click", (e) => {
      e.stopPropagation();
      const has = S.edges.some(x => x.to === node.id && x.key == null);
      if (!has) { toast("这个口还没接东西 —— 把工作流节点右边的圆点拖过来", ""); return; }
      S.edges = S.edges.filter(x => !(x.to === node.id && x.key == null));
      view.setEdges(S.edges);
      renderNode(node);
      save();
      toast("已断开连线（产出还留在这个节点里）", "");
    });
  }
  el.querySelector(".collapse").onclick = (e) => {
    e.stopPropagation();
    el.querySelector(".node-body").classList.toggle("hidden");
    el.querySelector(".collapse").textContent = el.querySelector(".node-body").classList.contains("hidden") ? "▸" : "▾";
  };
  const runBtn = el.querySelector(".nbtn.run");
  if (runBtn) runBtn.onclick = (e) => {
    e.stopPropagation();
    /* 一个按钮两种身份：空闲时开跑，跑起来就变成「停止」 */
    if (node.status === "running") stopRun(node);
    else runNode(node);
  };
  const syncBtn = el.querySelector(".nbtn.sync");
  if (syncBtn) syncBtn.onclick = (e) => { e.stopPropagation(); syncFromComfy(node); };
  renderNode(node);
}

function nodeEl(node) { return view.nodes.get(node.id)?.el; }

/* ==================================================================
   提示词框跟着节点框一起长
   ──────────────────────────────────────────────────────────────────
   以前工作流节点里的提示词框按 rows（3~6 行）定死：把节点从 400px 拉到 760px，
   底下只是多一片空白，想多看几行还得再拖一次输入框自己的右下角 —— 一根节点
   要调两次尺寸。

   规则：
     · 只认「手动拉过尺寸」的节点（.resized）；自适应高度的节点保持原样，
       免得一加参数就把框撑大；
     · 正文可视高度的一半分给这些框，按个平均；内容本来就没几行的框不上撑
       （按各自 scrollHeight 封顶），不会出现半屏空白。
   这里刻意用算出来的 px 而不是 flex：工作流节点的正文里套着 sec / sec-body
   好几层，逐层改成 flex 会牵连素材槽、网格两列这些布局。
================================================================== */
function fitTextBoxes(node) {
  const el = nodeEl(node);
  if (!el || !el.classList.contains("resized")) return;
  const body = el.querySelector(".node-body");
  if (!body) return;
  const tas = [...body.querySelectorAll("textarea")].filter(t => t.offsetParent !== null);
  if (!tas.length) return;
  for (const t of tas) t.style.height = "";                    // 先还原，量自然高度

  /* 每块框「还能长多高」= 内容高度 - 自然高度；内容只有两行的框几乎不占额度，
     省下来的高度要还给提示词框（平分的话，两行高的那个框会白白吃掉一半） */
  const boxes = tas.map(t => ({
    t, natural: t.offsetHeight,
    room: Math.max(0, (t.scrollHeight || 0) + 2 - t.offsetHeight),
    add: 0,
  }));
  let left = Math.round(body.clientHeight * 0.5);
  let pool = boxes.filter(b => b.room > 0);
  while (left > 0 && pool.length) {
    const share = Math.max(1, Math.floor(left / pool.length));
    let given = 0;
    for (const b of pool) {
      const give = Math.min(share, b.room - b.add, left - given);
      if (give <= 0) continue;
      b.add += give; given += give;
    }
    left -= given;
    if (!given) break;                                          // 没有进展就收手，别空转
    pool = pool.filter(b => b.add < b.room);
  }
  for (const b of boxes) if (b.add > 0) b.t.style.height = (b.natural + b.add) + "px";
}

/* ---------------- 素材节点的内容 ---------------- */
/** 素材节点接住了上游产出：优先显示产出，本地文件另存着不丢 */
function pulledUrl(node) {
  const p = node.pulled;
  if (!p || p.kind === "text") return "";
  return api.viewUrl({ filename: p.value, subfolder: p.sub || "", type: p.sType || "output" });
}

function renderInputBody(node, el) {
  const k = IN_KINDS[node.inKind] || IN_KINDS.text;
  const body = el.querySelector(".node-body");
  body.innerHTML = "";
  const pull = node.pulled;

  /* 工作流提示：常驻正文最顶上（紧挨左上角的输入口），paintStatus 负责开关和内容 */
  const tip = document.createElement("div");
  tip.className = "wf-tip";
  tip.hidden = true;
  body.appendChild(tip);

  if (node.inKind === "text") {
    /* 文本节点接住产出：产出单独一块摆着，别动不动就把用户自己写的那段顶掉 */
    if (pull && pull.kind === "text" && (pull.value || "").trim()) {
      const box = document.createElement("div");
      box.className = "pulled-text";
      const pre = document.createElement("pre");
      pre.className = "out-text";
      pre.textContent = pull.value;
      const row = document.createElement("div");
      row.className = "in-row";
      const use = document.createElement("button");
      use.className = "btn btn-ghost";
      use.textContent = "填进下面的输入框";
      use.onclick = () => {
        node.value = pull.value;
        node.pulled = null;
        renderNode(node); save();
        queueTextPush(node);
        toast("已填进输入框", "ok");
      };
      const drop = document.createElement("button");
      drop.className = "btn btn-ghost danger";
      drop.textContent = "丢弃";
      drop.onclick = () => { node.pulled = null; renderNode(node); save(); };
      row.append(use, drop);
      box.append(pre, row);
      body.appendChild(box);
    }
    const ta = document.createElement("textarea");
    ta.className = "in-text";
    ta.placeholder = "写提示词 / 文本，然后把右边的圆点拖到工作流的提示词输入口";
    ta.value = node.value || "";
    /* 只改 node.value 并轻量刷新状态，不能整块重渲染，否则输入框会丢焦点 */
    ta.oninput = () => {
      node.value = ta.value;
      scheduleSave();
      paintStatus(node);
      queueTextPush(node, true);  // 接在工作流提示词口上的，顺带写回 ComfyUI（停手 3 秒自动写）
    };
    /* 一点别处就立刻写，不用等那 3 秒 */
    ta.onblur = () => { queueTextPush(node); flushPendingPushes(); };
    body.appendChild(ta);
    return;
  }

  /* 接住了产出（图片 / 视频 / 音频）：直接展示产出 */
  if (pull) {
    const url = pulledUrl(node);
    const pv = document.createElement("div");
    pv.className = "in-preview pulled";
    if (node.inKind === "image") {
      const img = new Image();
      img.src = url; img.title = "点开看大图";
      img.onclick = () => window.open(url, "_blank");
      pv.appendChild(img);
      attachResBadge(pv, img);
    } else if (node.inKind === "video") {
      const v = document.createElement("video");
      v.src = url; v.controls = true; v.loop = true;
      pv.appendChild(v);
      attachResBadge(pv, v);
    } else {
      const a = document.createElement("audio");
      a.src = url; a.controls = true;
      pv.appendChild(a);
    }
    body.appendChild(pv);
    takeDropOn(pv,
      (item) => useLibOnInputNode(node, item),
      (file) => uploadToNode(node, file));

    const nm = document.createElement("div");
    nm.className = "in-name";
    nm.textContent = pull.value;
    nm.title = pull.value;
    body.appendChild(nm);

    const row = document.createElement("div");
    row.className = "in-row";
    const open = document.createElement("button");
    open.className = "btn btn-ghost";
    open.textContent = "打开";
    open.onclick = () => url && window.open(url, "_blank");
    const back = document.createElement("button");
    back.className = "btn btn-ghost";
    back.textContent = "改用本地文件";
    back.title = "清掉这次接到的产出，换回这个节点自己的文件";
    back.onclick = () => { node.pulled = null; renderNode(node); save(); };
    row.append(open, makeCollectBtn(node), back);
    body.appendChild(row);
    return;
  }

  if (node.value) {
    const pv = document.createElement("div");
    pv.className = "in-preview";
    const src = node.src || api.viewUrl({ filename: node.value, type: "input" });
    if (node.inKind === "image") {
      const img = document.createElement("img");
      img.src = src; img.title = "点开看大图";
      img.onclick = () => window.open(src, "_blank");
      pv.appendChild(img);
      attachResBadge(pv, img);
    } else if (node.inKind === "video") {
      const v = document.createElement("video");
      v.src = src; v.controls = true; v.loop = true; v.muted = true;
      pv.appendChild(v);
      attachResBadge(pv, v);
    } else {
      const a = document.createElement("audio");
      a.src = src; a.controls = true;
      pv.appendChild(a);
    }
    body.appendChild(pv);
    takeDropOn(pv,
      (item) => useLibOnInputNode(node, item),
      (file) => uploadToNode(node, file));

    const nm = document.createElement("div");
    nm.className = "in-name";
    nm.textContent = node.value;
    nm.title = node.value;
    body.appendChild(nm);

    const row = document.createElement("div");
    row.className = "in-row";
    const b1 = document.createElement("button");
    b1.className = "btn btn-ghost";
    b1.textContent = "换一个";
    b1.onclick = () => pickFile(node);
    const b2 = document.createElement("button");
    b2.className = "btn btn-ghost danger";
    b2.textContent = "移除";
    b2.onclick = () => {
      node.value = ""; node.src = ""; node.status = "idle"; node.error = "";
      renderNode(node); save();
    };
    row.append(b1, b2);
    body.appendChild(row);
    return;
  }

  const drop = document.createElement("div");
  drop.className = "in-drop";
  drop.innerHTML = `<b>＋</b>点击选${k.label.replace("输入", "")}，或直接拖进来`;
  drop.onclick = () => pickFile(node);
  /* 本地文件、素材库里的条目都能直接落进来 */
  takeDropOn(drop,
    (item) => useLibOnInputNode(node, item),
    (file) => uploadToNode(node, file));
  body.appendChild(drop);
}

function pickFile(node) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = IN_KINDS[node.inKind]?.accept || "";
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (f) uploadToNode(node, f);
  };
  inp.click();
}

/** 把本地文件传进 ComfyUI 的 input 目录，记下文件名 */
async function uploadToNode(node, file) {
  node.status = "running"; node.progress = "上传中…"; node.error = "";
  renderNode(node);
  try {
    const name = await api.uploadImage(file);
    node.value = name;
    /* 同名文件会被覆盖，加时间戳防止浏览器拿旧缓存 */
    node.src = api.viewUrl({ filename: name, type: "input" }) + "&t=" + Date.now();
    node.status = "done"; node.progress = "";
    renderNode(node);
    save();
    toast(`已上传：${name}`, "ok");
  } catch (e) {
    node.status = "error"; node.error = e.message; node.progress = "";
    renderNode(node);
    toast("上传失败：" + e.message, "err");
  }
}

/** 新建一个素材节点 */
function addInputNode(inKind, at) {
  const k = IN_KINDS[inKind];
  if (!k) return null;
  const p = at || centerScreen();
  const same = S.nodes.filter(n => n.kind === "input" && n.inKind === inKind).length;
  const node = {
    id: uid(), kind: "input", inKind,
    name: k.label + (same ? " " + (same + 1) : ""),
    x: p.x, y: p.y,
    params: {},
    value: "",
    src: "",
    status: "idle", error: "",
    result: null,
  };
  S.nodes.push(node);
  mountNode(node);
  view.select(node.id);
  ensureNodeVisible(node);
  $("#empty-tip").classList.add("hide");
  save();
  /* 文本节点直接把光标送进去，省一次点击 */
  if (inKind === "text") nodeEl(node)?.querySelector(".in-text")?.focus();
  return node;
}

/** 把某个节点挪进可视区（节点比视口还高时，让顶部对齐） */
function ensureNodeVisible(node) {
  const n = view.nodes.get(node.id);
  if (!n) return;
  const r = $("#stage").getBoundingClientRect();
  const k = view.view.k;
  const w = n.el.offsetWidth, h = n.el.offsetHeight;
  if (h * k > r.height - 40) {
    view.view.y = 16 - n.y * k;
  } else {
    const bottom = view.view.y + (n.y + h) * k;
    if (bottom > r.height - 12) view.view.y -= (bottom - (r.height - 12));
    const top = view.view.y + n.y * k;
    if (top < 12) view.view.y += (12 - top);
  }
  const left = view.view.x + n.x * k;
  const right = left + w * k;
  if (left < 12) view.view.x += (12 - left);
  if (right > r.width - 12) view.view.x -= (right - (r.width - 12));
  view.apply();
}

/* ==================================================================
   四大区 · 区内自由排序
   ──────────────────────────────────────────────────────────────────
   工作流节点的正文分成四块，边界是硬的：**素材 / 参数 / LoRA / 模型**。
   区内的格子可以拖着换位置，但拖不出这一区 —— 分类本身就说明它们是
   不同性质的东西，参数混进模型堆里只会更难找。

     · 参数区与模型区：格子随意排。这两片「谁先谁后」不影响出图，
       纯属个人习惯（有人先看画幅，有人先看步数）。
     · 素材区与 LoRA 区：不给拖。素材顺序就是参考图编号（image1 / image2），
       LoRA 顺序就是叠加链的先后 —— 顺序一乱，出图结果就变了，
       这不是排版的自由，是改参数。

   顺序按「工作流文件名 → 字段 key 列表」记在 S.orders 里：
   重开画布、把节点删掉再加回来，排好的那一版都还在。
   工作流改版加了新参数时，认不出来的那些按原相对次序追加到末尾，
   不会把现有顺序打乱。
================================================================== */
const FIELD_ZONES = { param: "参数", model: "模型" };

/** 这份工作的排序记录挂在工作流文件名上（换节点不丢） */
function orderKeyOf(node) {
  return String(node?.file || node?.name || "");
}

/** 按记下的顺序重排；没记过就是原顺序，新字段追加在尾部 */
function orderedFields(node, zone, seq) {
  const saved = S.orders?.[orderKeyOf(node)]?.[zone];
  if (!Array.isArray(saved) || !saved.length) return seq;
  const pos = new Map(saved.map((k, i) => [k, i]));
  return seq
    .map((f, i) => ({ f, i, p: pos.has(f.key) ? pos.get(f.key) : 1e6 + i }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.f);
}

function saveFieldOrder(node, zone, keys) {
  const k = orderKeyOf(node);
  if (!k) return;
  S.orders = S.orders || {};
  (S.orders[k] || (S.orders[k] = {}))[zone] = keys;
  save();
}

/** 多行文本（提示词 / 系统提示词）没法压进 200×50：压进去只剩一条缝，写不了字 */
function isWideField(f) {
  if (classify(f) === "main") return true;
  const v = f?.value;
  return typeof v === "string" && (v.includes("\n") || v.length > 40);
}

/** 重名的格子（四个「帧数」、两个「分段模式」）得挂节点角标，否则长得一模一样 */
function tagMaker(node, fields) {
  const cnt = new Map();
  for (const f of fields) { const n = cnName(f); cnt.set(n, (cnt.get(n) || 0) + 1); }
  const needIds = [];
  for (const f of fields) if (cnt.get(cnName(f)) > 1 && !needIds.includes(f.nodeId)) needIds.push(f.nodeId);
  const baseCnt = new Map();
  for (const nid of needIds) { const b = nodeLabel(node, nid); baseCnt.set(b, (baseCnt.get(b) || 0) + 1); }
  const seen = new Map();
  const nameOf = new Map();
  for (const nid of needIds) {
    const b = nodeLabel(node, nid);
    const i = (seen.get(b) || 0) + 1;
    seen.set(b, i);
    /* 序号放前面：角标窄的时候尾巴会被省略号吃掉 */
    nameOf.set(nid, baseCnt.get(b) > 1 ? `#${i} ${b}` : b);
  }
  return (f) => (cnt.get(cnName(f)) > 1 ? { tag: nameOf.get(f.nodeId) } : null);
}

/* 正在拖的那一格：只在一次拖拽期间有效 */
let dragField = null;

/** 区内容器：一堆固定尺寸的格子，可拖着换位置 */
function fieldFlow(node, fields, zone, tagOf) {
  const wrap = document.createElement("div");
  wrap.className = "field-flow";
  wrap.dataset.zone = zone;
  for (const f of orderedFields(node, zone, fields)) {
    const cell = fieldControl(f, node, tagOf ? tagOf(f) : null);
    cell.classList.add("cell");
    if (isWideField(f)) cell.classList.add("cell-wide");
    cell.dataset.fkey = f.key;
    wrap.appendChild(cell);
  }
  attachFieldSort(wrap, node, zone);
  return wrap;
}

/** 把鼠标底下的那一格找出来（拖拽指示线要贴在它左右） */
function cellAt(wrap, x, y) {
  for (const c of wrap.querySelectorAll(":scope > .field")) {
    const r = c.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c;
  }
  return null;
}

function attachFieldSort(wrap, node, zone) {
  const cells = () => [...wrap.querySelectorAll(":scope > .field")];
  const clearMark = () => cells().forEach(c => c.classList.remove("drop-before", "drop-after"));

  wrap.addEventListener("dragstart", (e) => {
    const cell = e.target.closest?.(".field");
    if (!cell || cell.parentElement !== wrap) return;
    dragField = { key: cell.dataset.fkey, zone, el: cell };
    cell.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    /* 有些环境不给 setData 就当成没拖拽，兜个空串 */
    try { e.dataTransfer.setData("text/plain", cell.dataset.fkey); } catch { /* 忽略 */ }
    try { e.dataTransfer.setDragImage(cell, 24, 24); } catch { /* 忽略 */ }
  });

  wrap.addEventListener("dragend", () => {
    cells().forEach(c => c.classList.remove("dragging", "drop-before", "drop-after"));
    wrap.classList.remove("drop-deny");
    dragField = null;
  });

  wrap.addEventListener("dragover", (e) => {
    if (!dragField) return;
    /* 跨区不接：不 preventDefault、光标给「禁止」、整片描一圈红虚线。
       光靠「放下去没反应」说明不了问题，得当场看出来这一区不收 */
    if (dragField.zone !== zone) {
      try { e.dataTransfer.dropEffect = "none"; } catch { /* 忽略 */ }
      wrap.classList.add("drop-deny");
      return;
    }
    e.preventDefault();
    wrap.classList.remove("drop-deny");
    e.dataTransfer.dropEffect = "move";
    const to = cellAt(wrap, e.clientX, e.clientY);
    if (!to || to.dataset.fkey === dragField.key) { clearMark(); return; }
    const r = to.getBoundingClientRect();
    const left = e.clientX < r.left + r.width / 2;
    cells().forEach(c => c.classList.remove("drop-before", "drop-after"));
    to.classList.add(left ? "drop-before" : "drop-after");
  });

  wrap.addEventListener("dragleave", (e) => {
    if (!wrap.contains(e.relatedTarget)) { clearMark(); wrap.classList.remove("drop-deny"); }
  });

  wrap.addEventListener("drop", (e) => {
    /* 拖的是面板里的格子，就别让画布（stage）把它当成拖素材，冒泡到此为止 */
    if (dragField) e.stopPropagation();
    if (!dragField || dragField.zone !== zone) { wrap.classList.remove("drop-deny"); return; }
    e.preventDefault();
    const from = dragField.key;
    const to = cellAt(wrap, e.clientX, e.clientY);
    clearMark();
    if (!to || !from || to.dataset.fkey === from) return;
    const r = to.getBoundingClientRect();
    const after = e.clientX >= r.left + r.width / 2;
    const rest = cells().map(c => c.dataset.fkey).filter(k => k !== from);
    let at = rest.indexOf(to.dataset.fkey);
    if (at < 0) at = rest.length - 1;
    rest.splice(after ? at + 1 : at, 0, from);
    saveFieldOrder(node, zone, rest);
    renderNode(node);
  });
}

function renderNode(node) {
  if (typeof node === "string") node = S.nodes.find(n => n.id === node);   // 容错：传 id 也认
  if (!node) return;
  const el = nodeEl(node);
  if (!el) return;
  el.classList.toggle("running", node.status === "running");
  el.classList.toggle("error", node.status === "error");
  /* 素材节点接到上游产出时，边框跟着变绿，一眼看出这个节点现在装的是别人的产出 */
  el.classList.toggle("has-pulled", !!(node.kind === "input" && node.pulled));

  /* 节点被拉矮之后内容区会滚动；重画会把 scrollTop 抹回 0，
     这里先记下来画完再放回去，改一个参数不会把视线弹回顶部 */
  const scrollBody = el.querySelector(".node-body");
  const keepScroll = scrollBody ? scrollBody.scrollTop : 0;

  if (node.kind === "workflow") {
    const body = el.querySelector(".node-body");
    body.innerHTML = "";
    /* 先按素材槽把 prompt 对齐一次：画布上看到的素材 = 实际提交的素材 */
    wireAssetSlots(node);
    const fields = buildFields(node);
    /* 画布不提供编辑的（ComfyUI 里被节点面板接管、或由画幅算出来的宽高）单独收一堆，
       混在参数里会让人以为改了能生效，实际上节点压根不认这一格 */
    const locked = fields.filter(f => f.locked);
    const g = { main: [], mode: [], front: [], when: [], size: [], sample: [], model: [], lora: [], asset: [], other: [] };
    for (const f of fields) if (!f.locked) g[classify(f)].push(f);

    /* 每个字段归到哪一道（一采 / 二采 / 共用）：双采样工作流里「步数」「种子」
       两套名字一模一样，不分开摆根本认不出改的是哪一道 */
    const stg = computeStages(node.prompt);
    const stageOf = (f) => stg.get(String(f.nodeId)) || 0;

    /* 段号按实际出现的顺序编：没有素材的工作流就是 ① 参数 ② 模型，
       不会出现「一上来就是 ②」这种看着像丢了一段的情况；有素材时仍是 ①②③ */
    let secNo = 0;

    /* ① 素材：图 / 视频 / 音频。放最上面，缺文件一眼就看见，也能直接本地上传 */
    const slots = collectAssetSlots(node);
    /* 已经被素材槽认领的字段别再摆一遍 */
    const claimed = new Set(slots.slots
      .filter(s => s.loader && node.prompt[s.loader.id])
      .map(s => s.loader.id + "|" + s.loader.field));
    const plainAsset = g.asset.filter(f => !claimed.has(f.key));
    /* 导演台的源视频是连进来的（写进时间线，不是普通的字段），单独给他一行「来自谁」 */
    const dirVid = S.edges.find(e => e.to === node.id
      && String(e.key || "").endsWith("|" + DIRECTOR_VIDEO_KEY));
    if (slots.has || plainAsset.length || dirVid) {
      const miss = plainAsset.filter(f => missOf(f, node.params[f.key] ?? f.value));
      let right = plainAsset.length;
      if (slots.has) {
        right = ["image", "video", "audio"]
          .map(k => `${KIND_CN[k]} ${slots.slots.filter(s => s.kind === k && !slotBlank(s.value)).length}/${slots.limits[k]}`)
          .filter(t => !/ 0\/0$/.test(t))
          .join(" · ") || plainAsset.length;
      } else if (dirVid) {
        right = "源视频 ← 上游";
      }
      const box = sectionBox(++secNo, "素材", miss.length ? `⚠ 缺 ${miss.length}` : right, miss.length > 0);
      const sb = box.querySelector(".sec-body");
      if (dirVid) {
        const row = document.createElement("div");
        row.className = "wired-row";
        row.appendChild(wiredChip(node, dirVid.key, { from: dirVid.from }));
        sb.appendChild(row);
      }
      if (slots.has) sb.appendChild(slotZone(node, slots));
      /* 固定口（首帧 / 尾帧 / 遮罩这类不是 autogrow 槽的图）也走同一套方块卡：
         图框在上、按钮在下、同类型横排 —— 跟参考图那一片长得一样，不再是一整行 */
      if (plainAsset.length) {
        /* 跟槽位挨着摆的时候，上面得有一行小标题，否则会被当成上一类的格子 */
        if (slots.has) {
          const h = document.createElement("div");
          h.className = "slot-head";
          h.innerHTML = `<span>其他素材</span><span class="slot-cnt">${plainAsset.length}</span>`;
          sb.appendChild(h);
        }
        const grid = document.createElement("div");
        grid.className = "slot-grid";
        const seen = new Map();
        for (const f of plainAsset) {
          let lb = nodeLabel(node, f.nodeId);
          const n = (seen.get(lb) || 0) + 1;
          seen.set(lb, n);
          if (n > 1) lb += ` ${n}`;      // 好几个都叫 LoadImage 时，靠序号分开
          grid.appendChild(assetCard(f, node, { tile: true, label: lb }));
        }
        sb.appendChild(grid);
      }
      body.appendChild(box);
    }

    /* ② 参数：能改的格子全平铺成一张网。
       一采 / 二采不再各开一块 —— 分块就拖不动了；道次靠格子标签上的小角标认，
       混着摆也不会认错。排好的顺序记在 S.orders 里，下次打开还在 */
    const paramFields = (() => {
      /* 没排过的时候给一版默认顺序：
         提示词 → 画幅 / 模式 / 时长 → 尺寸与采样（一采在前、二采在后）→ 其余 */
      const rank = (f) => {
        const n = semName(f);
        return /^aspect_ratio$/i.test(n) ? 0 : RE_ASPECT.test(n) ? 1
          : RE_MODE.test(n) ? 2 : 3;
      };
      const lead = [...g.front, ...g.mode, ...g.when].sort((x, y) => rank(x) - rank(y));
      /* 时长是被下游算出来的（h3：length = 表达式(时长)）—— 那一格挂个小提示，
         免得人以为改了它帧数没动 */
      const durDriven = [...g.when, ...g.size, ...g.other, ...g.main]
        .some(x => x.driven && RE_DURATION.test(semName(x)));
      for (const f of lead) f._durHint = durDriven && !f.driven && RE_DURATION.test(semName(f));
      /* 尺寸与采样按道次排开：一采的在前、二采的在后（只决定默认顺序） */
      const byStage = new Map();
      for (const f of [...g.size, ...g.sample]) {
        const st = stageOf(f);
        if (!byStage.has(st)) byStage.set(st, []);
        byStage.get(st).push(f);
      }
      const stageSeq = [...byStage.entries()].sort((x, y) => x[0] - y[0])
        .flatMap(([, v]) => v);
      /* 只有一道采样时不标道次 —— 「一采」铺满整个面板，等于没说 */
      if ([...byStage.keys()].filter(s => s > 0).length > 1) {
        for (const f of stageSeq) f._pass = stageOf(f);
      }
      return [...g.main, ...lead, ...stageSeq, ...g.other];
    })();
    if (paramFields.length || locked.length) {
      /* 标题右边：项数 + 「可拖」——这一区能自己排，得让人知道 */
      const right = document.createElement("span");
      right.className = "sec-right";
      right.appendChild(document.createTextNode(String(paramFields.length)));
      if (paramFields.length) {
        const tip = document.createElement("em");
        tip.className = "zone-tip";
        tip.textContent = "可拖";
        tip.title = "按住格子左边的名字拖动，只能在本区内换位置";
        right.appendChild(tip);
      }
      const box = sectionBox(++secNo, "参数", right, false);
      const sb = box.querySelector(".sec-body");
      /* 重名的格子挂节点角标；顺序按 S.orders 排（没排过就是上面那版默认顺序） */
      if (paramFields.length) {
        sb.appendChild(fieldFlow(node, paramFields, "param", tagMaker(node, paramFields)));
      }
      /* 画布不提供编辑的那几格（ComfyUI 面板接管 / 由画幅算出的宽高）收在参数区末尾：
         拖不动的东西夹在可拖的中间最碍事 */
      if (locked.length) sb.appendChild(lockedBox(locked, node));
      body.appendChild(box);
    }


    /* ③ LoRA：名字在上面、强度紧贴在这条下面，一眼看出哪个强度配的哪个 LoRA */
    const loraOrder = [];
    for (const f of g.lora) if (!loraOrder.includes(f.nodeId)) loraOrder.push(f.nodeId);
    /* ComfyUI 里被旁路的 LoRA 不进 prompt，画布上原本整个看不见。
       现在补成「已停用」的卡：看得见、点得到启用，不用回 ComfyUI 按 Ctrl+B */
    const dormant = dormantLoras(node);
    if (loraOrder.length || dormant.length) {
      /* 标题右边：先摆「几个 LoRA」，对不上时再挂一颗「没写回」的按钮 */
      const right = document.createElement("span");
      right.className = "sec-right";
      right.appendChild(document.createTextNode(String(loraOrder.length + dormant.length)));
      const chip = loraSyncChip(node);
      if (chip) right.appendChild(chip);
      const box = sectionBox(++secNo, "LoRA", right, false);
      const sb = box.querySelector(".sec-body");
      /* 一采、二采各挂一整套 LoRA 时（导演台那种），标题必须写清楚是哪一道 */
      const stages = loraOrder.map(id => stg.get(String(id)) || 0);
      const tagOn = new Set(stages.filter(v => v > 0)).size > 1;
      loraOrder.forEach((id, i) => {
        sb.appendChild(loraCard(node, g.lora.filter(f => f.nodeId === id), i + 1, tagOn ? stages[i] : null));
      });
      dormant.forEach((d, i) => {
        sb.appendChild(loraDormantCard(node, { ...d, idx: `LoRA ${loraOrder.length + i + 1}` }));
      });
      body.appendChild(box);
    }

    /* ④ 模型：UNET / CLIP / VAE 这些（LoRA 单独一区）。
       顺序同样可以拖 —— 谁排前面纯看习惯，不影响加载链（链是按接线走的） */
    if (g.model.length) {
      const miss = g.model.filter(f => missOf(f, node.params[f.key] ?? f.value));
      const box = sectionBox(++secNo, "模型", miss.length ? `⚠ 缺 ${miss.length}` : g.model.length, miss.length > 0);
      const sb = box.querySelector(".sec-body");
      /* 两个 VAE、两套 CLIP 是常事，重名就挂角标 */
      sb.appendChild(fieldFlow(node, g.model, "model", tagMaker(node, g.model)));
      body.appendChild(box);
    }
  } else if (node.kind === "input") {
    renderInputBody(node, el);
  } else if (node.kind === "content") {
    renderContentBody(node, el);
  }

  /* 结果不再塞在节点里：跑完会自动生成 / 更新右侧的内容节点 */
  const out = el.querySelector(".node-out");
  if (out) { out.innerHTML = ""; out.classList.add("hide"); }

  if (keepScroll && scrollBody) scrollBody.scrollTop = keepScroll;
  /* 重画会把提示词框打回 rows 高度 —— 拉过尺寸的节点得重新把高度分一次 */
  fitTextBoxes(node);

  paintStatus(node);
  view.scheduleEdges();
}

/** 工作流节点里带编号的一节。right 可以是一个元素（塞按钮进来），也可以是一段文字 */
function sectionBox(no, title, right, bad) {
  const box = document.createElement("div");
  box.className = "sec" + (bad ? " bad" : "");
  box.innerHTML = `<div class="sec-head"><span class="sec-no">${no}</span>
    <span class="sec-t">${esc(title)}</span><span class="sec-n"></span></div>
    <div class="sec-body"></div>`;
  const slot = box.querySelector(".sec-n");
  if (right instanceof Node) slot.replaceWith(right);
  else slot.textContent = String(right ?? "");
  return box;
}

/** 两列网格：参数多的时候一行两个，节点不用拉太宽 */
function grid2(items) {
  const row = document.createElement("div");
  row.className = "grid2";
  for (const it of items) row.appendChild(it);
  return row;
}

/**
 * 一张 LoRA 卡：模型名在上面，它自己的强度紧贴在下面
 * 以前「LoRA 名」进模型区、「强度」被 strength 规则抓进参数区，两边分家，
 * 一排 5 个 LoRA 配 5 个强度，谁配谁全靠猜。
 */
/**
 * LoRA 段标题右边的小按钮：画布上点过启停、但 ComfyUI 文件里还没落地的项
 * 平时不显示（正常显示的是「几个 LoRA」），对不上时才冒出来，点一下重推
 */
function loraSyncChip(node) {
  const bad = (node.unsynced || []).length;
  if (!bad) return null;
  const b = document.createElement("button");
  b.className = "sec-sync";
  b.innerHTML = `<i>⇅</i>${bad} 项没写回`;
  b.title = "画布上的启停状态和 ComfyUI 的工作流文件对不上。\n"
    + "常见原因：ComfyUI 里正开着这份工作流，它把自己内存里的版本存回去盖掉了我们写的。\n"
    + "关掉 ComfyUI 那一页（或先别在那边保存）再点这里。";
  b.onclick = (e) => {
    e.stopPropagation();
    b.disabled = true;
    pushModesToComfy(node);
  };
  return b;
}

function loraCard(node, fs, idx, pass) {
  const id = fs[0]?.nodeId;
  const nd = node.prompt[id] || {};
  const off = !!id && (node.assetOff || []).includes(String(id));
  const card = document.createElement("div");
  card.className = "lora-card" + (off ? " off" : "");

  const head = document.createElement("div");
  head.className = "lora-head";
  head.innerHTML = (pass === null || pass === undefined ? ""
    : `<span class="pass-tag${pass ? " p" + pass : ""}">${PASS_CN[pass] || ""}</span>`)
    + `<span class="lora-idx">LoRA ${idx}</span>`
    + (off ? `<span class="lora-off-tag">已停用</span>` : "")
    + `<span class="lora-cls">${esc(String(nd.class_type || ""))}</span>`;
  card.appendChild(head);

  const byName = new Map(fs.map(f => [f.name, f]));
  const nameF = byName.get("lora_name") || fs[0];
  if (nameF) card.appendChild(fieldControl(nameF, node));

  const strengths = ["strength_model", "strength_clip"].map(n => byName.get(n)).filter(Boolean);
  /* 强度只占半格，右边那半格摆「不启用 / 启用」—— 一个 LoRA 少占一整行 */
  const opCell = document.createElement("div");
  opCell.className = "lora-ops-slot";
  opCell.appendChild(loraOps(node, id, off, false));
  if (strengths.length === 1) {
    const row = document.createElement("div");
    row.className = "lora-srow";
    row.appendChild(fieldControl(strengths[0], node));
    row.appendChild(opCell);
    card.appendChild(row);
  } else if (strengths.length > 1) {
    card.appendChild(grid2(strengths.map(f => fieldControl(f, node))));
    card.appendChild(opCell);
  } else {
    card.appendChild(opCell);
  }

  /* 强度被上游节点接走了（工作流里用 Float 节点驱动），这里只能说明一下 */
  const ext = ["strength_model", "strength_clip"].filter(n => Array.isArray(nd.inputs?.[n]));
  if (ext.length) {
    const tip = document.createElement("div");
    tip.className = "lora-ext";
    const src = nd.inputs[ext[0]][0];
    const srcName = node.prompt[src]?._meta?.title || node.prompt[src]?.class_type || src;
    tip.textContent = `强度由上游「${srcName}」控制`;
    card.appendChild(tip);
  }
  return card;
}

/** LoRA 的「启用 / 不启用」一行：跟素材同一套语义，节点不删、随时开回来 */
function loraOps(node, id, off, text = true) {
  const row = document.createElement("div");
  row.className = "lora-ops";
  const oid = String(id || "");
  if (off) {
    if (text) {
      const tag = document.createElement("span");
      tag.className = "lora-off";
      tag.textContent = "已停用 · 这次生成不加载";
      tag.title = "点「启用」让它重新参与，并把 ComfyUI 里这个节点解除旁路";
      row.appendChild(tag);
    }
    const on = document.createElement("button");
    on.className = "mini-btn on";
    on.textContent = "启用";
    on.title = "让这个 LoRA 重新参与生成，同时把 ComfyUI 里这份工作流的该节点解除旁路（mode 4 → 0）";
    on.onclick = (e) => { e.stopPropagation(); setLoraOff(node, oid, false); };
    row.appendChild(on);
  } else {
    const stop = document.createElement("button");
    stop.className = "mini-btn stop";
    stop.textContent = "不启用";
    stop.title = "这次生成不加载这个 LoRA；节点不删，随时能开回来。同时把 ComfyUI 里这份工作流的该节点设为旁路（mode 0 → 4）";
    stop.onclick = (e) => { e.stopPropagation(); setLoraOff(node, oid, true); };
    row.appendChild(stop);
  }
  return row;
}

/** ComfyUI 里被旁路、prompt 里已经没有的 LoRA —— 补一张卡，好让人一键启用 */
function dormantLoras(node) {
  const live = new Set(Object.keys(node.prompt || {})
    .filter(id => /lora/i.test(String(node.prompt[id]?.class_type || ""))));
  return (node.uiWf?.nodes || [])
    .filter(n => /lora/i.test(String(n.type || "")) && (n.mode === 4 || n.mode === 2) && !live.has(String(n.id)))
    .map(n => {
      const named = (n.widgets_values_named && typeof n.widgets_values_named === "object") ? n.widgets_values_named : null;
      const arr = Array.isArray(n.widgets_values) ? n.widgets_values : null;
      return {
        id: String(n.id),
        cls: String(n.type || ""),
        name: named?.lora_name ?? (arr ? arr[0] : ""),
        strength: named?.strength_model ?? (arr && arr.length > 1 ? arr[1] : null),
      };
    });
}

function loraDormantCard(node, info) {
  const card = document.createElement("div");
  card.className = "lora-card off";
  const head = document.createElement("div");
  head.className = "lora-head";
  head.innerHTML = `<span class="lora-idx">${esc(info.idx)}</span>`
    + `<span class="lora-cls">${esc(info.cls)}</span>`;
  card.appendChild(head);
  card.appendChild(loraOps(node, info.id, true));

  const nm = document.createElement("div");
  nm.className = "lora-name";
  nm.textContent = info.name || "（ComfyUI 里这个 LoRA 是旁路状态）";
  nm.title = `${info.cls} · 节点 ${info.id}`;
  card.appendChild(nm);

  if (info.strength !== null && info.strength !== undefined) {
    const st = document.createElement("div");
    st.className = "lora-ext";
    st.textContent = `强度 ${info.strength}`;
    card.appendChild(st);
  }
  return card;
}

/** 已接线的输入：显示来源，点一下断开 */
function wiredChip(node, key, inc) {
  const w = document.createElement("div");
  w.className = "wired";
  w.style.flex = "1";
  w.title = "运行时自动用上游的产出 · 点一下断开";
  w.innerHTML = `<span class="wired-dot"></span><span class="wired-t">来自「${esc(nodeName(inc.from))}」</span><span class="wired-x">断开</span>`;
  w.onclick = () => disconnect(node, key);
  return w;
}

/** 素材槽分区：只摆有内容的槽，空槽收进「＋」 */
function slotZone(node, slots) {
  const wrap = document.createElement("div");
  wrap.className = "slot-zone";
  for (const kind of ["image", "video", "audio"]) {
    const max = slots.limits[kind] || 0;
    if (!max) continue;
    const mine = slots.slots.filter(s => s.kind === kind).sort((a, b) => a.idx - b.idx);
    const shown = mine.filter(s => !slotBlank(s.value)
      || (node.emptyShown || []).includes(`${kind}:${s.idx}`));
    const cnt = mine.filter(s => !slotBlank(s.value)).length;

    const row = document.createElement("div");
    row.className = "slot-kind";
    if (cnt || shown.length) {
      const head = document.createElement("div");
      head.className = "slot-head";
      head.innerHTML = `<span>${KIND_NAME[kind]}</span><span class="slot-cnt">${cnt}/${max}</span>`;
      row.appendChild(head);
    }

    /* 同类型横排：一格一个文件，按钮在格子底下 */
    const grid = document.createElement("div");
    grid.className = "slot-grid";
    shown.forEach((s, i) => {
      grid.appendChild(assetCard(slotField(node, s), node, {
        tile: true,
        slot: `${kind}:${s.idx}`,
        label: `${KIND_NAME[kind]} ${i + 1}`,     // 连续编号：空槽藏起来了，槽号会跳
        off: !!s.loader.byp || !!s.loader.mute,
        clearable: true,
        onClear: () => {
          node.emptyShown = (node.emptyShown || []).filter(x => x !== `${kind}:${s.idx}`);
          renderNode(node);
          save();
        },
      }));
    });

    const canAdd = shown.length < mine.length || mine.length < max;
    if (canAdd) {
      const add = document.createElement("button");
      add.className = "slot-add";
      /* 「＋」本身也是一格，跟素材格同宽，省掉一整行空标题 */
      add.innerHTML = `<b>＋</b><span>${KIND_NAME[kind]}</span><i>${cnt}/${max}</i>`;
      add.title = `添加一个${KIND_NAME[kind]}（上限 ${max} 个，取自工作流内置配置，已用 ${cnt} 个）`;
      add.onclick = () => addAssetSlot(node, kind);
      grid.appendChild(add);
    }
    row.appendChild(grid);
    wrap.appendChild(row);
  }
  return wrap;
}

/* ==================================================================
   拖进来就填 —— 素材库条目 / 本地文件直接落到某一格上
   ──────────────────────────────────────────────────────────────────
   以前只有「掉在画布空白处 = 建一个节点」这一条路，落在素材格上没人接，
   于是从素材库往「参考图 3」那一格拖，什么也不会发生。现在格子和素材节点
   自己接 drop：库里点住文件拖到格子上，就等于给这一格换文件。
================================================================== */
const LIB_DND = "application/x-xy-lib";      // 和素材库 dragstart 写进去的是同一个 MIME

/** 这一拖带的是「素材库条目 / 本地文件」吗（dragover 阶段读不到 data，只能看 types） */
function isFileDrag(e) {
  const t = e.dataTransfer;
  if (!t) return false;
  const types = [...(t.types || [])];
  return types.includes(LIB_DND) || types.includes("Files");
}

/** 素材库里的一条 → ComfyUI input 根目录里的文件名（LoadImage 只认根目录里的名字） */
async function adoptLibFile(item) {
  const type = item.type || "input";
  const sub = item.sub || "";
  if (type === "input" && !sub) return item.name;     // 已经在 input 根目录，直接用
  const res = await fetch(api.viewUrl({ filename: item.name, subfolder: sub, type }));
  if (!res.ok) throw new Error(`取文件失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const ext = (item.name.match(/\.[a-z0-9]+$/i) || [""])[0];
  const stem = (item.name.slice(0, item.name.length - ext.length) || "file")
    .replace(/[^\w\-.\u4e00-\u9fff]/g, "_").slice(0, 60);
  /* 名字固定住：同一个素材反复拖只覆盖同一个 input 文件，不会把 input 目录灌满 */
  const f = new File([blob], `xy_${stem}${ext}`, { type: blob.type || "application/octet-stream" });
  return await api.uploadImage(f);
}

/** 库条目 → 工作流节点的某一格 */
async function useLibOnField(node, f, tt, item) {
  if (item.kind && tt && item.kind !== tt) {
    toast(`这是${KIND_CN[item.kind] || item.kind}，这一格要${KIND_CN[tt] || tt}`, "err");
    return;
  }
  try {
    const name = await adoptLibFile(item);
    if (f.cls) patchChoices(f.cls, f.name, name);
    commitAsset(node, f, name);
    toast(`已用上：${item.name}`, "ok");
  } catch (e) {
    toast("引入失败：" + e.message, "err");
  }
}

/** 库条目 → 素材节点（图像 / 视频 / 音频） */
async function useLibOnInputNode(node, item) {
  const want = node.inKind;
  if (item.kind && want && item.kind !== want) {
    toast(`这是${KIND_CN[item.kind] || item.kind}，这个节点要${KIND_CN[want] || want}`, "err");
    return;
  }
  try {
    const name = await adoptLibFile(item);
    node.value = name;
    node.src = api.viewUrl({ filename: name, type: "input" }) + "&t=" + Date.now();
    node.pulled = null;                // 换成本机 input 文件，之前接住的产出作废
    node.status = "done"; node.error = "";
    renderNode(node);
    save();
    toast(`已用上：${item.name}`, "ok");
  } catch (e) {
    toast("引入失败：" + e.message, "err");
  }
}

/** 给一个元素装上「拖到上面就能填」：库条目走 onLib，本地文件走 onFile */
function takeDropOn(el, onLib, onFile) {
  el.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    el.classList.add("drop-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove("drop-over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove("drop-over");
    const dt = e.dataTransfer;
    if (!dt) return;
    const raw = dt.getData(LIB_DND);
    if (raw) {
      let it = null;
      try { it = JSON.parse(raw); } catch { return; }
      if (it?.name && onLib) onLib(it);
      return;
    }
    const file = dt.files?.[0];
    if (file && onFile) onFile(file);
  });
}

/** 本地文件直接落到某一格：传进 input/ 再选用 */
async function uploadFileOnField(node, f, tt, file) {
  try {
    const name = await api.uploadImage(file);
    if (f.cls) patchChoices(f.cls, f.name, name);
    commitAsset(node, f, name);
    toast(`已上传并选用：${name}`, "ok");
  } catch (e) {
    toast("上传失败：" + e.message, "err");
  }
}

/** 素材卡：缩略图 + 选文件 + 底下按钮
 *  meta = {label:「参考图 3」, off:工作流里就是 bypass, slot:"image:3",
 *          clearable, onClear, forced:用户手动停用, tile:摆成小方块（素材槽区用）} */
function assetCard(f, node, meta = {}) {
  const tt = targetType(f);
  const cur = node.params[f.key] !== undefined ? node.params[f.key] : f.value;
  const hasFile = !slotBlank(cur);          // 工作流里空槽的占位值就是字符串 "None"
  const miss = missOf(f, cur);
  const inc = incomingEdge(node, f.key);
  const nid = String(f.nodeId || "");
  const forced = !!(nid && (node.assetOff || []).includes(nid));
  const off = forced || !!meta.off;
  const tile = !!meta.tile;

  const card = document.createElement("div");
  card.className = "asset-card" + (tile ? " tile" : "")
    + (miss ? " missing" : "") + (off ? " off" : "");
  card.dataset.key = f.key;
  if (meta.slot) card.dataset.slot = meta.slot;
  card.title = `${f.title || f.name}\n${cur || "未选择"}`
    + (off ? "\n（这次不用它）" : "") + "\n\n拖素材库里的文件到这一格可以直接换";

  const port = document.createElement("span");
  port.className = "port in" + (inc ? "" : " pullable");
  port.dataset.port = `in:${node.id}:${f.key}`;
  port.dataset.kind = "in";
  port.dataset.itype = tt;
  port.title = inc
    ? `已接：「${nodeName(inc.from)}」· 想换就把这一格的线往外拖到别的输出口`
    : `从这一格往外拖 = 接一个${IN_KINDS[tt].label}（松手在空白处就新建一个）；也可以把别的输出线拖进来`;

  /* 缩略图（方块模式把编号挂在左上角，省掉一整行标题） */
  const th = document.createElement("div");
  th.className = "asset-thumb";
  const url = hasFile ? api.viewUrl({ filename: cur, type: "input" }) : "";
  if (!hasFile) {
    th.textContent = IN_KINDS[tt].ico;
  } else if (tt === "image") {
    const img = new Image();
    img.src = url; img.loading = "lazy";
    img.onclick = () => window.open(url, "_blank");
    th.appendChild(img);
  } else if (tt === "video") {
    const v = document.createElement("video");
    v.src = url; v.muted = true; v.preload = "metadata";
    v.onclick = () => window.open(url, "_blank");
    th.appendChild(v);
  } else {
    th.textContent = "🎵";
  }
  if (tile && meta.label) {
    const tag = document.createElement("b");
    tag.className = "th-tag";
    tag.textContent = meta.label.replace(KIND_NAME[tt] + " ", "");
    tag.title = meta.label;
    th.appendChild(tag);
  }

  /* 选文件：接了线就是一枚来源 chip，没接线就是下拉 */
  let pick;
  if (inc) {
    if (tile) {
      pick = document.createElement("div");
      pick.className = "wired compact";
      pick.innerHTML = `<span class="wired-dot"></span>`
        + `<span class="wired-t">${esc(nodeName(inc.from))}</span>`
        + `<span class="wired-x">断</span>`;
      pick.title = `由「${nodeName(inc.from)}」提供 · 点一下断开`;
      pick.onclick = () => disconnect(node, f.key);
    } else {
      pick = wiredChip(node, f.key, inc);
    }
  } else {
    pick = document.createElement("select");
    const opts = (f.choices || []).map(c => (c && typeof c === "object") ? (c.value ?? c.name ?? String(c)) : c);
    if (!hasFile) {
      /* 空槽：先摆一个「未选择」，别让下拉默认指到第一个文件假装选好了 */
      const o = document.createElement("option");
      o.value = ""; o.textContent = tile ? "— 未选 —" : "— 选一个文件 —";
      o.selected = true;
      pick.appendChild(o);
    }
    if (miss && hasFile) {
      const o = document.createElement("option");
      o.value = cur; o.textContent = "⚠ " + cur + "（不存在）";
      o.selected = true; o.disabled = true;
      pick.appendChild(o);
    }
    if (!opts.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "（无可选项）";
      pick.appendChild(o);
    }
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o; op.textContent = o;
      if (o === cur) op.selected = true;
      pick.appendChild(op);
    }
    pick.onchange = () => commitAsset(node, f, pick.value);
  }

  /* 底下（方块）/ 右边（整行）的按钮 */
  const btns = [];
  /* 已经由上游节点供图的格子不用再上传，留着只会让两边的文件打架 */
  if (!inc) {
    const up = document.createElement("button");
    up.className = "mini-btn";
    up.textContent = "上传";
    up.title = "从本机选一个文件，传进 ComfyUI 的 input 目录并直接选用";
    up.onclick = (e) => { e.stopPropagation(); pickAssetFile(node, f, tt); };
    btns.push(up);
  }
  /* 启用 / 停用：
     · 停用 = 这次生成不用这个素材（节点还留在画布上，随时能开回来）
     · 工作流里本来就是 bypass 的，给一个明确的「启用」口
     ⚠️ 「启用」不能跟着 !inc 一起跳过：接了上游线的格子，只要它自己的加载节点还在旁路
        （线在、节点却没进提交），就会标「未生效」—— 以前这种格子一个按钮都没有，
        只能回 ComfyUI 按 Ctrl+B 解旁路。 */
  if ((forced || (meta.off && (hasFile || inc))) && nid) {
    const on = document.createElement("button");
    on.className = "mini-btn on";
    on.textContent = "启用";
    on.title = forced
      ? "重新把这一格接回生成流程"
      : inc
        ? "这一格的加载节点在 ComfyUI 里是旁路（线还连着，但这次生成不带它）· 点这里救回来，并写回文件"
        : "把这个素材节点从 bypass 状态救回来，并接到参考槽上（同时写回 ComfyUI）";
    on.onclick = (e) => { e.stopPropagation(); setAssetOff(node, nid, false); };
    btns.push(on);
  } else if (!inc && hasFile && nid) {
    const stop = document.createElement("button");
    stop.className = "mini-btn stop";
    stop.textContent = tile ? "停用" : "不启用";
    stop.title = "这次生成先不用这个素材，并同步把 ComfyUI 里的这个节点旁路（节点不删，随时能开回来）";
    stop.onclick = (e) => { e.stopPropagation(); setAssetOff(node, nid, true); };
    btns.push(stop);
  }
  /* 点「＋」露出来的空槽：不想用了能收回去 */
  if (meta.clearable && slotBlank(cur)) {
    const cl = document.createElement("button");
    cl.className = "mini-btn";
    cl.textContent = "收起";
    cl.title = "把这个空槽收回「＋ 添加」里";
    cl.onclick = (e) => { e.stopPropagation(); meta.onClear?.(); };
    btns.push(cl);
  }

  /* 文件名一行：方块模式只有「停用/未生效/接了上游」才需要，其余信息缩略图和下拉里都有 */
  let nm = null;
  if (!tile || off) {
    const nmText = inc ? `由「${nodeName(inc.from)}」提供` : (hasFile ? cur : "未选择");
    nm = document.createElement("div");
    nm.className = "asset-name";
    nm.innerHTML = ((!tile && meta.label) ? `<b class="an-tag">${esc(meta.label)}</b>` : "")
      + (tile ? "" : esc(nmText))
      + (forced ? `<span class="an-off">已停用</span>` : (meta.off ? `<span class="an-off">未生效</span>` : ""));
    nm.title = `${f.title} · ${f.name}\n${cur || ""}`;
  }

  if (tile) {
    card.appendChild(th);
    const pickRow = document.createElement("div");
    pickRow.className = "asset-line pick";
    pickRow.appendChild(pick);
    card.appendChild(pickRow);
    if (btns.length) {
      const row = document.createElement("div");
      row.className = "asset-line btns";
      for (const b of btns) row.appendChild(b);
      card.appendChild(row);
    }
    if (nm) card.appendChild(nm);
  } else {
    const line = document.createElement("div");
    line.className = "asset-line";
    line.appendChild(pick);
    for (const b of btns) line.appendChild(b);
    const main = document.createElement("div");
    main.className = "asset-main";
    main.append(line, nm);
    card.append(th, main);
  }
  card.appendChild(port);

  /* 素材库 / 本地文件拖到这一格 = 直接换文件 */
  takeDropOn(card,
    (item) => useLibOnField(node, f, tt, item),
    (file) => uploadFileOnField(node, f, tt, file));
  return card;
}

/** 本地上传后把新文件名补进候选表，下拉才不会显示「不存在」 */
function patchChoices(cls, field, name) {
  const info = S.oi?.[cls];
  const spec = info?.input?.required?.[field] || info?.input?.optional?.[field];
  if (!spec) return;
  if (Array.isArray(spec[0])) {
    if (!spec[0].includes(name)) spec[0].push(name);
  } else if (spec[1] && Array.isArray(spec[1].options)) {
    if (!spec[1].options.some(o => (o?.key ?? o) === name)) spec[1].options.push({ key: name });
  }
}

/** 从本机选文件 → 传进 input/ → 写进这个字段 */
function pickAssetFile(node, f, tt) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = IN_KINDS[tt]?.accept || "";
  inp.onchange = () => {
    const file = inp.files?.[0];
    if (file) uploadFileOnField(node, f, tt, file);
  };
  inp.click();
}

/* ---------------- 分辨率角标 ---------------- */
/**
 * 在预览框右上角标出真实像素尺寸。
 * 图片读 naturalWidth/Height，视频读 videoWidth/Height（要等元数据到）；
 * 读不到就什么都不显示 —— 宁可空着，也不猜一个数字糊上去。
 */
function attachResBadge(pv, media) {
  if (!pv || !media) return;
  const show = (w, h) => {
    if (!w || !h) return;
    let b = pv.querySelector(".res-badge");
    if (!b) {
      b = document.createElement("div");
      b.className = "res-badge";
      pv.appendChild(b);
    }
    b.textContent = `${w} × ${h}`;
    b.title = `分辨率 ${w} × ${h}`;
  };
  if (media.tagName === "IMG") {
    if (media.naturalWidth) show(media.naturalWidth, media.naturalHeight);
    else media.addEventListener("load",
      () => show(media.naturalWidth, media.naturalHeight), { once: true });
  } else if (media.tagName === "VIDEO") {
    const go = () => show(media.videoWidth, media.videoHeight);
    if (media.videoWidth) go();
    else media.addEventListener("loadedmetadata", go, { once: true });
  }
}

/* ---------------- 输出内容节点 ---------------- */
function renderContentBody(node, el) {
  const body = el.querySelector(".node-body");
  body.innerHTML = "";

  if (node.inKind === "text") {
    const pre = document.createElement("pre");
    pre.className = "out-text";
    pre.textContent = node.value || "（空）";
    body.appendChild(pre);
    const row = document.createElement("div");
    row.className = "in-row";
    const cp = document.createElement("button");
    cp.className = "btn btn-ghost";
    cp.textContent = "复制文本";
    cp.onclick = () => {
      navigator.clipboard?.writeText(node.value || "");
      toast("已复制", "ok");
    };
    row.append(cp, makeCollectBtn(node));
    body.appendChild(row);
    return;
  }

  const url = node.src || (node.value
    ? api.viewUrl({ filename: node.value, subfolder: node.sub || "", type: node.sType || "output" })
    : "");
  const pv = document.createElement("div");
  pv.className = "in-preview";
  if (!url) {
    pv.innerHTML = `<div class="ph">没有内容</div>`;
  } else if (node.inKind === "image") {
    const img = new Image();
    img.src = url;
    img.title = "点开看大图";
    img.onclick = () => window.open(url, "_blank");
    pv.appendChild(img);
    attachResBadge(pv, img);
  } else if (node.inKind === "video") {
    const v = document.createElement("video");
    v.src = url; v.controls = true; v.loop = true;
    pv.appendChild(v);
    attachResBadge(pv, v);
  } else {
    const a = document.createElement("audio");
    a.src = url; a.controls = true;
    pv.appendChild(a);
  }
  body.appendChild(pv);

  const meta = document.createElement("div");
  meta.className = "ct-meta";
  meta.innerHTML = `<span title="${esc(node.value || "")}">${esc(node.value || "—")}</span>`;
  body.appendChild(meta);

  const row = document.createElement("div");
  row.className = "in-row";
  const open = document.createElement("button");
  open.className = "btn btn-ghost";
  open.textContent = "打开";
  open.onclick = () => url && window.open(url, "_blank");
  row.append(open, makeCollectBtn(node));
  body.appendChild(row);
}

const WANT_CN = { text: "文本", image: "图", video: "视频", audio: "音频" };

function paintStatus(node) {
  if (typeof node === "string") node = S.nodes.find(n => n.id === node);   // 容错：传 id 也认
  const el = nodeEl(node);
  if (!el) return;
  const st = el.querySelector(".node-status");
  if (!st) return;

  /* 运行中：那枚 ▶ 变成红色 ■（同一个位置，点一下就停） */
  const rb = el.querySelector(".nbtn.run");
  if (rb) {
    const running = node.status === "running";
    rb.classList.toggle("stop", running);
    rb.textContent = running ? "■" : "▶";
    rb.title = running
      ? "停止：中断 ComfyUI 正在跑的这一次（还在排队没开始的也一并撤掉）"
      : "运行 (Ctrl+Enter)";
  }

  /* 节点头上的 ⟳：亮黄点 = ComfyUI 那边的文件比画布新 */
  const sb = el.querySelector(".nbtn.sync");
  if (sb) {
    sb.classList.toggle("stale", !!node.stale);
    const when = node.stale ? "ComfyUI 上的文件比这里新" :
      (node.syncAt ? `上次同步：${new Date(node.syncAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "");
    sb.title = (node.stale
      ? `ComfyUI 上的「${node.name}」有新改动 · 点这里重新读取`
      : `与 ComfyUI 的「${node.file}」同步`)
      + (when ? `\n${when}` : "")
      + `\n读的是磁盘上的工作流文件；在 ComfyUI 里改完记得按 Ctrl+S 保存`;
  }

  st.className = "node-status";
  if (node.status === "running") {
    st.innerHTML = `<span class="spin"></span>${esc(node.progress || "运行中…")}`;
  } else if (node.status === "error") {
    st.classList.add("err");
    st.textContent = node.error || "执行失败";
  } else if (node.kind === "input") {
    const pull = node.pulled;
    const up = S.edges.find(e => e.to === node.id && !e.key);
    /* 「等待/产出 · 来自 XX」这条工作流提示挂在正文最顶上，底部状态栏不重复 */
    const tip = el.querySelector(".wf-tip");
    if (tip) {
      tip.classList.toggle("ok", !!pull);
      if (pull) {
        tip.hidden = false;
        tip.textContent = pull.kind === "text"
          ? `产出文本 · 来自「${pull.fromName || "上游"}」`
          : `产出 · ${WANT_CN[pull.kind] || ""} · 来自「${pull.fromName || "上游"}」`;
      } else if (up) {
        tip.hidden = false;
        tip.textContent = `等待「${nodeName(up.from)}」的产出`;
      } else {
        tip.hidden = true;
      }
    }
    if (pull || up) {
      st.textContent = "";
    } else if (node.inKind === "text") {
      const n = (node.value || "").trim().length;
      st.textContent = n ? `${n} 个字符` : "空";
    } else {
      st.textContent = node.value ? "文件已就绪" : "还没选文件";
    }
  } else if (node.kind === "content") {
    const where = node.sType === "temp" ? "临时（会被 ComfyUI 清理，建议另存）"
      : node.sType === "input" ? "来自 input" : "来自 output";
    st.textContent = `${WANT_CN[node.inKind] || ""} · ${where}`;
  } else if (node.status === "stopped") {
    st.textContent = "已停止" + (node.elapsed ? ` · ${node.elapsed}s` : "");
  } else if (node.status === "done") {
    st.classList.add("ok");
    st.textContent = "完成" + (node.elapsed ? ` · ${node.elapsed}s` : "")
      + (node.outs ? ` · 结果已输出到右侧 ${node.outs} 个节点` : "")
      + (node.wired ? ` · 用了「${node.wired.from}」的${WANT_CN[node.wired.kind] || "图"}` : "");
  } else {
    st.textContent = node.notes?.length ? node.notes[0].slice(0, 60) : "";
  }
  /* 头部位置窄，长文案截断显示；hover 看全文 */
  st.title = st.textContent || "";
}

function removeNode(id) {
  removeNodes([id]);
}

/** 批量删除：一次清干净，只存一次档 */
function removeNodes(ids) {
  const set = new Set((ids || []).filter(Boolean));
  if (!set.size) return 0;
  S.nodes = S.nodes.filter(n => !set.has(n.id));
  for (const id of set) view.removeNode(id);
  /* 节点没了，挂在它身上的线也一起清掉；
     同时记下受影响的下游节点 —— 不重画的话卡片上会一直留着
     「来自『已经删掉的节点』」这种死字 */
  const touched = new Set();
  const before = S.edges.length;
  S.edges = S.edges.filter(e => {
    if (!set.has(e.from) && !set.has(e.to)) return true;
    if (set.has(e.from) && !set.has(e.to)) touched.add(e.to);
    return false;
  });
  if (S.edges.length !== before) view.setEdges(S.edges);
  for (const tid of touched) {
    const n = S.nodes.find(x => x.id === tid);
    if (n && n.kind === "workflow") renderNode(n);
  }
  if (!view.nodes.size) $("#empty-tip").classList.remove("hide");
  save();
  return set.size;
}

/* ==================================================================
   多选：底部操作条 + 批量复制 / 粘贴 / 删除
================================================================== */
let clip = null;          // 画布内部剪贴板

function updateSelBar(sel) {
  const bar = $("#sel-bar");
  if (!bar) return;
  const n = sel ? sel.size : 0;
  const c = $("#sel-count");
  if (c) c.innerHTML = `已选 <b>${n}</b> 个`;
  bar.classList.toggle("show", n >= 2);
}

/** 把一个节点摊成纯数据（不含 DOM / uiWf），复制和导出共用 */
function nodeSnapshot(n) {
  const pos = view.getPos(n.id), size = view.getSize(n.id);
  return {
    kind: n.kind, file: n.file, name: n.name, wfKind: n.wfKind,
    inKind: n.inKind, value: n.value, sub: n.sub, sType: n.sType,
    pulled: n.pulled ? JSON.parse(JSON.stringify(n.pulled)) : undefined,
    params: JSON.parse(JSON.stringify(n.params || {})),
    src: n.src,
    extraSlots: n.extraSlots ? JSON.parse(JSON.stringify(n.extraSlots)) : undefined,
    emptyShown: n.emptyShown ? [...n.emptyShown] : undefined,
    assetOn: n.assetOn ? [...n.assetOn] : undefined,
    assetOff: n.assetOff ? [...n.assetOff] : undefined,
    x: pos.x, y: pos.y, w: size.w, h: size.h,
  };
}

function copySelection() {
  const ids = [...view.selected].filter(id => S.nodes.some(n => n.id === id));
  if (!ids.length) { toast("先选几个节点：按住空格 + 左键拖一个框", ""); return 0; }
  const at = new Map(ids.map((id, i) => [id, i]));
  clip = {
    nodes: ids.map(id => nodeSnapshot(S.nodes.find(n => n.id === id))),
    /* 只带「选中的节点之间」的线，往外的线不复制 */
    edges: S.edges.filter(e => at.has(e.from) && at.has(e.to))
      .map(e => ({ a: at.get(e.from), b: at.get(e.to), key: e.key ?? null, type: e.type })),
    pasteN: 0,
  };
  toast(`已复制 ${clip.nodes.length} 个节点${clip.edges.length ? ` · ${clip.edges.length} 条线` : ""}，Ctrl+V 粘贴`, "ok");
  return clip.nodes.length;
}

/** 按快照重建一个节点（工作流节点要重新问 ComfyUI 拿定义） */
async function cloneSnapshot(s, x, y) {
  if (s.kind === "workflow") {
    const wf = S.workflows.find(w => w.file === s.file) || { file: s.file, name: s.name, kind: s.wfKind || "image" };
    let uiWf, prompt, warnings = [];
    try {
      uiWf = await api.getWorkflow(wf.file);
      ({ prompt, warnings } = convertWorkflow(uiWf, S.oi));
    } catch (e) {
      toast(`复制「${s.name}」失败：${e.message}`, "err", 4200);
      return null;
    }
    const node = {
      id: uid(), kind: "workflow", file: s.file, name: s.name, wfKind: s.wfKind,
      uiWf, prompt, params: JSON.parse(JSON.stringify(s.params || {})),
      status: "idle", error: "", notes: warnings, result: null,
      extraSlots: s.extraSlots ? JSON.parse(JSON.stringify(s.extraSlots)) : undefined,
      emptyShown: s.emptyShown ? [...s.emptyShown] : undefined,
      assetOn: s.assetOn ? [...s.assetOn] : undefined,
      assetOff: s.assetOff ? [...s.assetOff] : undefined,
      x, y, w: s.w, h: s.h,
    };
    restoreExtraSlots(node);
    S.nodes.push(node);
    mountNode(node);
    return node;
  }
  const isContent = s.kind === "content";
  const inKind = s.inKind || "image";
  const node = {
    id: uid(), kind: isContent ? "content" : "input", inKind,
    name: s.name, x, y, w: s.w, h: s.h, params: {},
    value: s.value || "", sub: s.sub || "", sType: s.sType || "", src: s.src || "",
    pulled: s.pulled ? JSON.parse(JSON.stringify(s.pulled)) : null,
    /* 收进成品库后记的文件名（按钮显示「已存 ✓」） */
    collected: s.collected || "",
    status: (s.value || isContent || s.pulled) ? "done" : "idle", error: "", result: null,
  };
  S.nodes.push(node);
  mountNode(node);
  return node;
}

async function pasteClip() {
  if (!clip?.nodes?.length) { toast("剪贴板是空的，先 Ctrl+C 复制一下", ""); return 0; }
  /* 每次粘贴再往右下挪一点，连按几次不会叠在一起 */
  const off = 48 * (++clip.pasteN);
  const made = [];
  for (const s of clip.nodes) made.push(await cloneSnapshot(s, s.x + off, s.y + off));

  for (const e of clip.edges) {
    const a = made[e.a], b = made[e.b];
    if (!a || !b) continue;
    S.edges = S.edges.filter(x => !(x.to === b.id && x.key === e.key));
    S.edges.push({ from: a.id, to: b.id, key: e.key, type: e.type });
  }
  view.setEdges(S.edges);
  /* 线是最后接的，卡片上的「来自谁」得重画一遍 */
  for (const n of made) if (n?.kind === "workflow") renderNode(n);

  const ids = made.filter(Boolean).map(n => n.id);
  view.selectMany(ids);
  $("#empty-tip").classList.add("hide");
  save();
  toast(`已粘贴 ${ids.length} 个节点${clip.edges.length ? ` · ${clip.edges.length} 条线` : ""}`, "ok");
  return ids.length;
}

async function duplicateSelection() {
  if (!copySelection()) return 0;
  return pasteClip();
}

/* ==================================================================
   运行
================================================================== */
/** 当前节点上「ComfyUI 里改不了」的字段，key 形如 12|width */
function lockedKeysOf(node) {
  const s = new Set();
  for (const [nid, nd] of Object.entries(node.prompt || {})) {
    const locks = lockMapOf(nd.class_type, effInputs(node, nid, nd));
    for (const name of Object.keys(locks)) s.add(nid + "|" + name);
  }
  return s;
}

/** 上游产出落到磁盘：output 里的取回来、重传一份进 input/；本来就在 input 的直接用。
    文件名固定成 xy_<上游>_<下游>.ext —— 同一条边反复跑只会覆盖同一个文件 */
async function materializeUpstream(node, src, v, want) {
  if (v.direct) return v.filename;
  node.progress = `传入「${src.name}」的${WANT_CN[want] || "文件"}…`;
  renderNode(node);
  const blob = await api.fetchBlob(v);
  const ext = (v.filename.match(/\.[a-z0-9]+$/i) || [".png"])[0];
  const tag = `${src.id}_${node.id}`.replace(/[^a-z0-9_-]/gi, "");
  const file = new File([blob], `xy_${tag}${ext}`, { type: blob.type || "application/octet-stream" });
  return api.uploadImage(file);
}

async function runNode(node, _seen = new Set()) {
  if (node.status === "running" || _seen.has(node.id)) return;
  _seen.add(node.id);
  node.status = "running"; node.error = ""; node.progress = "提交中…"; node.wired = null;
  /* 中止开关一开始就建好：传素材那一大段也在「运行中」，
     这时候点停止不该等它传完才生效 */
  node._abort = new AbortController();
  node._stopping = false;
  node.promptId = null;
  renderNode(node);
  const t0 = Date.now();
  try {
    /* 1) 上游没跑过就先跑上游 */
    const ups = S.edges
      .filter(e => e.to === node.id)
      .map(e => S.nodes.find(n => n.id === e.from))
      .filter(Boolean);
    for (const u of ups) {
      if (u.kind === "workflow" && !u.result) {
        node.progress = `先跑上游「${u.name}」…`;
        renderNode(node);
        await runNode(u, _seen);
        if (!u.result) throw new Error(`上游「${u.name}」没跑出结果，下游接不到图`);
      }
    }

    /* 1.5) 素材槽接线：有值的槽才接进 prompt，空槽不提交（免得校验失败） */
    wireAssetSlots(node);

    /* 2) 用户在面板上改过的参数。
       只读的那几格（ComfyUI 里被面板接管 / 由画幅算出的宽高）一律用工作流里的原值：
       旧存档里可能还留着「画布还能改」时写进去的数，跟画幅、时间线对不上就会出错 */
    const prompt = JSON.parse(JSON.stringify(node.prompt));
    const lockedKeys = lockedKeysOf(node);
    for (const [k, v] of Object.entries(node.params || {})) {
      if (lockedKeys.has(k)) continue;
      const [nid, field] = k.split("|");
      if (!prompt[nid]?.inputs || !field) continue;
      /* 这个口是被圈里的线驱动的（时长这类由上游算出）：不许拿面板旧值把它顶掉 */
      if (Array.isArray(prompt[nid].inputs[field])) continue;
      prompt[nid].inputs[field] = v;
      /* 导演台的分段模式：时间线 JSON 里的 taskType 优先级更高，
         只改 widget 等于没改，这里跟着写回时间线 */
      if (RE_MODE.test(field) && DIRECTOR_CLS.test(String(prompt[nid].class_type || ""))) {
        prompt[nid].inputs.timeline_data = patchTimeline(prompt[nid].inputs.timeline_data, (tl) => {
          (tl.global = tl.global || {}).taskType = v;
        });
      }
    }

    /* 3) 把连线上游的产出塞进目标输入：文本直接赋值，文件先传进 input/
         只处理「带 key」的字段级连线；key 为 null 的是流向内容节点的展示线，跳过 */
    for (const e of S.edges.filter(x => x.to === node.id && x.key)) {
      const src = S.nodes.find(n => n.id === e.from);
      if (!src) continue;
      const bar = e.key.indexOf("|");
      const nid = e.key.slice(0, bar), field = e.key.slice(bar + 1);
      if (!prompt[nid]?.inputs || !field) continue;

      /* 导演台的源视频：没有可以赋值的连线口，得把文件 + 帧数写进时间线 */
      if (field === DIRECTOR_VIDEO_KEY) {
        const v = upstreamValue(src, "video");
        if (!v || "value" in v) throw new Error(`「${src.name}」没产出视频，接不了导演台的源视频`);
        node.progress = `传入「${src.name}」的视频…`;
        renderNode(node);
        const fname = await materializeUpstream(node, src, v, "video");
        const meta = await libProbeVideo("input", "", fname);
        const mode = ensureDirectorVideoMode(node, nid);
        const next = applyDirectorVideo(node, nid, fname, meta);
        if (!next) throw new Error("导演台的时间线读不出来（timeline_data 不是合法 JSON），没法写源视频");
        prompt[nid].inputs.timeline_data = next;
        prompt[nid].inputs.task_type = mode || prompt[nid].inputs.task_type;
        node.wired = { from: src.name, kind: "video", file: fname };
        continue;
      }

      const want = fieldWant(prompt, nid, field);
      const v = upstreamValue(src, want);
      if (!v) throw new Error(`「${src.name}」还没准备好，先把它跑出来（要的是${WANT_CN[want] || "内容"}）`);

      if ("value" in v) {
        prompt[nid].inputs[field] = v.value;
        node.wired = { from: src.name, kind: "text" };
        continue;
      }

      const fname = await materializeUpstream(node, src, v, want);
      prompt[nid].inputs[field] = fname;
      node.wired = { from: src.name, kind: want, file: fname };
    }

    /* 3.4) 用户停用的 LoRA：不能像素材那样「把指向它的线删掉」——
           下游的 MODEL / CLIP 口一删就没输入，ComfyUI 只会回一句 Required input is missing。
           按 bypass 的原意办：把它摘掉，下游直接接回它自己的上游（类别对得上的那一路） */
    if (node.assetOff?.length) bypassLoraInPrompt(prompt, node.assetOff);

    /* 3.5) 用户停用的素材：从提交副本里摘掉节点，连同所有指向它的连线
            （node.prompt 本身不动，画布上那一格还在，随时能开回来） */
    if (node.assetOff?.length) {
      const missing = [];
      for (const oid of node.assetOff) {
        delete prompt[oid];
        for (const nd of Object.values(prompt)) {
          if (!nd?.inputs) continue;
          for (const [k, v] of Object.entries(nd.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== String(oid)) continue;
            delete nd.inputs[k];
            /* 摘掉的是「必填口」的话，ComfyUI 只会回一句 Required input is missing，
               先说清楚是哪一格，省得对着报错猜 */
            if (S.oi?.[nd.class_type]?.input?.required?.[k]) {
              missing.push(`${nd.class_type} 的「${cnName({ name: k, cls: nd.class_type }) || k}」`);
            }
          }
        }
      }
      if (missing.length) {
        throw new Error(`停用的素材占着必填口：${missing.slice(0, 2).join("；")}`
          + `${missing.length > 2 ? ` 等 ${missing.length} 处` : ""} —— 换一个素材，或者这一格别停用`);
      }
    }

    /* 内联来源只给面板看，不进提交体 */
    for (const nd of Object.values(prompt)) {
      if (nd?._meta?.inlined) delete nd._meta.inlined;
      if (nd?._meta?.inlinedType) delete nd._meta.inlinedType;
    }
    /* 传素材、算上游那段时间里点过「停止」：到这儿就别提交了 */
    if (node._stopping) throw new Error("已取消");
    const id = await api.submit(expandPromptTokens(prompt));
    /* 记下任务号：跑起来之后按钮变「停止」，点的就是这一次 */
    node.promptId = id;
    node.progress = "运行中…";
    renderNode(node);
    const res = await api.waitFor(id, {
      onTick: (t) => { node.progress = t; renderNode(node); },
      signal: node._abort.signal,
    });
    node.result = res;
    node.status = "done";
    node.progress = "";
    node.elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    /* 4) 结果挂到下游：连了素材节点就写进素材节点，没连就自动建结果节点 */
    const out = syncOutputs(node, res);
    node.outs = out.made.length;
    if (out.mismatch.length) {
      toast(`有连着的节点没收下产出：${out.mismatch.join("；")}`, "err", 6500);
    }
  } catch (e) {
    if (node._stopping || /已取消/.test(e.message)) {
      /* 自己点的「停止」不算失败：状态清成「已停止」，别留一片红 */
      node.status = "stopped";
      node.progress = "";
      node.error = "";
      node.elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      toast("已停止这次运行", "", 2600);
    } else {
      node.status = "error";
      node.error = e.message;
      toast(e.message, "err", 6000);
    }
  }
  node._stopping = false;
  node.promptId = null;
  node._abort = null;
  renderNode(node);
  if (node.status === "done") ensureNodeVisible(node);
  save();
}

/**
 * 停止这一次运行：先撤掉「还在排队」的那一份，再中断正在跑的那一份。
 * ComfyUI 的 /api/interrupt 只打当前正在执行的任务 —— 提交完立刻点停止时
 * 多半还没轮到它，光 interrupt 打不着，所以队列也得撤。
 */
async function stopRun(node) {
  if (node.status !== "running" || node._stopping) return;
  node._stopping = true;
  node.progress = "停止中…";
  renderNode(node);
  const pid = node.promptId || "";
  /* 轮询先停：按钮立刻回来，不等网络（被中断的 prompt 永远不会进 history） */
  node._abort?.abort();
  let bad = "";
  try {
    if (pid) await api.deleteQueued(pid);
    await api.interrupt(pid);
  } catch (e) { bad = e.message; }
  if (bad) {
    toast(`画布这边已停，但 ComfyUI 没接住中断请求（${bad}）—— 去 ComfyUI 里手动取消一下队列`, "err", 6500);
  }
  /* 兜底：万一轮询那边没接住（还在传素材、或本来就没提交），
     别让按钮永远卡在「停止中」 */
  if (node._stopping) {
    node._stopping = false;
    if (node.status === "running") {
      node.status = "stopped";
      node.progress = "";
      renderNode(node);
    }
  }
}

/* ==================================================================
   拖文件进画布 → 自动建素材节点
================================================================== */
async function addMediaFileNode(file, cx, cy) {
  const p = cx ? view.screenToWorld(cx, cy) : centerScreen();
  const name = file.name || "";
  const inKind =
    /^video\//.test(file.type) || /\.(mp4|webm|mov|mkv|avi)$/i.test(name) ? "video" :
    /^audio\//.test(file.type) || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(name) ? "audio" :
    "image";
  const node = addInputNode(inKind, p);
  if (node) await uploadToNode(node, file);
}

/* ==================================================================
   向前连线：从「那一格」自己的输入口往外拉
================================================================== */
/** 记一条线（同一个输入只留一条），并重画目标节点 */
function connectEdge(fromId, target, key, kind) {
  if (fromId === target.id) { toast("不能连到自己", "err"); return; }
  S.edges = S.edges.filter(e => !(e.to === target.id && e.key === key));
  S.edges.push({ from: fromId, to: target.id, key, type: kind });
  view.setEdges(S.edges);
  renderNode(target);
  save();
  const field = String(key).split("|")[1] || "输入";
  toast(`已接上：「${nodeName(fromId)}」→ ${field}`, "ok");
}

/** 从某一格往前拉出一个素材节点（文本格就是文本节点）并接上 */
function createPulledInput(target, key, kind, cx, cy) {
  const w = view.screenToWorld(cx, cy);
  const inNode = addInputNode(kind, { x: w.x - 300, y: w.y - 46 });
  if (!inNode) { view.scheduleEdges(); return null; }
  connectEdge(inNode.id, target, key, kind);
  return inNode;
}

/* ==================================================================
   素材往下游：挑一个「能吃这种素材」的工作流
   ──────────────────────────────────────────────────────────────────
   以前从素材节点往外拖、在空白处松手，只会再建一个「图像输入」——
   素材接素材，等于原地打转。现在改成：先把画布里所有工作流过一遍，
   看谁的输入口能吃这种素材（图接图、视频接视频、文本接文本），列出来
   让人挑；挑中就把素材接到它第一个能用的槽位上，跑的时候自动把文件
   送进 input/。一个都吃不下时才退回「建一个素材节点」。

   「能吃」怎么判：把工作流转成 prompt 之后，看它有没有能接素材的槽
   （autogrow 的 ref_images 之类）或能拉线的字段（LoadImage 的 image、
   LoadVideo 的 video、prompt 这类 STRING）。判定和真正接线时用的是同一套，
   所以列出来的必然接得上。被 bypass / mute 的加载节点也算 —— 接上会顺手
   救活它，不然接上去等于没接。
================================================================== */
const FEED_CN = { text: "文本", image: "图片", video: "视频", audio: "音频" };

const wfIntake = new Map();          // file -> Set<kind>；失败时存 Error，别每次拖线都重试
function resetWfIntake() { wfIntake.clear(); }

/** 工作流里被 bypass / mute 掉、但下游还活着的加载节点。
    它们不在 prompt 里（画布上暂时看不见），接上素材时能把它救活 —— 也算「能吃」。
    下游也全是停用的不算：那种分支整条都没通，救活一个加载节点也是白接。 */
function dormantLoaders(uiWf) {
  const nodes = uiWf?.nodes || [];
  const byLink = new Map();
  for (const n of nodes) for (const s of n.inputs || []) if (s.link != null) byLink.set(s.link, n);
  const off = (n) => (n?.mode ?? 0) === 2 || (n?.mode ?? 0) === 4;

  const out = [];
  for (const n of nodes) {
    if (!off(n)) continue;
    const links = [];
    for (const o of n.outputs || []) for (const l of o.links || []) links.push(l);
    if (!links.length) continue;
    if (!links.some(l => byLink.get(l) && !off(byLink.get(l)))) continue;
    const info = S.oi?.[n.type];
    if (!info) continue;
    const w = listWidgets(info).find(x => targetType({ cls: n.type, name: x.name, type: x.type }));
    if (!w) continue;
    const kind = targetType({ cls: n.type, name: w.name, type: w.type });
    out.push({ id: String(n.id), cls: n.type, field: w.name, kind });
  }
  return out;
}

/** 扫一份工作流文件，看它有哪些口真的能接素材
    （判定跟真正接线时用的是同一套：素材槽 + 能拉线的字段 + 休眠的加载节点，
      所以「列出来」的必然「接得上」，不会出现点了没反应） */
function intakeKindsOf(uiWf) {
  const { prompt } = convertWorkflow(uiWf, S.oi);
  const probe = { prompt, uiWf, params: {}, extraSlots: [], assetOn: [], assetOff: [] };
  const kinds = new Set();
  const info = collectAssetSlots(probe);
  for (const s of info.slots) kinds.add(s.kind);
  const fields = buildFields(probe);
  for (const f of fields) {
    const tt = targetType(f);
    if (tt) kinds.add(tt);
  }
  for (const d of dormantLoaders(uiWf)) kinds.add(d.kind);
  /* autogrow 口还留着容量、只是图里没摆加载节点的工作流（h3 的参考视频口就是这样）
     —— 接线时会补一个空槽，所以它其实吃得住。带时长参数的按视频流算，
     其余按容量算（参考图那类）。 */
  for (const k of ["image", "video", "audio"]) {
    if (!kinds.has(k) && info.limits[k] > 0) kinds.add(k);
  }
  /* 导演台：源视频在时间线里（不是连线口），分段模式切到 v2v / rv2v 才出现 —— 
     入口是有的，只是要切模式，所以带导演台的工作流一律算能吃视频 */
  if (Object.values(prompt).some(nd => DIRECTOR_CLS.test(String(nd?.class_type || "")))) kinds.add("video");
  return kinds;
}

/** 参数里有没有「时长」这一类（duration / 帧数）—— 有就是跑视频的流 */
function hasDurationParam(fields) {
  return (fields || []).some(f => !f.locked && RE_DURATION.test(f.name));
}

async function intakeOf(wf) {
  const hit = wfIntake.get(wf.file);
  if (hit instanceof Error) throw hit;
  if (hit) return hit;
  try {
    const kinds = intakeKindsOf(await api.getWorkflow(wf.file));
    wfIntake.set(wf.file, kinds);
    return kinds;
  } catch (e) {
    wfIntake.set(wf.file, e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}

/** 能吃 kind 的工作流清单（并发 4 个，边扫边报进度） */
async function intakeCandidates(kind, onTick) {
  const queue = [...(S.workflows || [])];
  const all = queue.length;
  const out = [];
  let done = 0;
  const run = async () => {
    while (queue.length) {
      const w = queue.shift();
      try { if ((await intakeOf(w)).has(kind)) out.push(w); } catch { }
      done++;
      try { onTick?.(done, all); } catch { }
    }
  };
  await Promise.all([run(), run(), run(), run()]);
  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out;
}

/* ---------- 选择器：贴在鼠标旁边的小面板 ---------- */
let pickerEl = null, pickerOff = [];

function closeWfPicker() {
  for (const fn of pickerOff) { try { fn(); } catch { } }
  pickerOff = [];
  pickerEl?.remove();
  pickerEl = null;
}

function openWfPicker({ kind, fromId, at, sx, sy, fallback }) {
  closeWfPicker();
  const cn = FEED_CN[kind] || kind;
  const altLabel = IN_KINDS[kind]?.label || cn;

  const el = document.createElement("div");
  el.className = "wfpick";
  el.innerHTML = `
    <div class="wfpick-head">
      <span class="wfpick-ico">${IN_KINDS[kind]?.ico || "📄"}</span>
      <span class="wfpick-title">接一个能吃「${cn}」的工作流</span>
      <button class="wfpick-x" title="取消（Esc）">✕</button>
    </div>
    <input class="wfpick-q" placeholder="搜工作流…" spellcheck="false" autocomplete="off">
    <div class="wfpick-list"><div class="wfpick-hint">正在看各个工作流的输入口…</div></div>
    <div class="wfpick-foot"></div>`;
  document.body.appendChild(el);
  pickerEl = el;

  const q = el.querySelector(".wfpick-q");
  const listEl = el.querySelector(".wfpick-list");
  const footEl = el.querySelector(".wfpick-foot");
  let items = [], shown = [], active = 0, loading = true;

  const place = () => {
    const r = el.getBoundingClientRect();
    const left = Math.max(10, Math.min(sx + 14, innerWidth - r.width - 10));
    const top = Math.max(10, Math.min(sy + 12, innerHeight - r.height - 10));
    el.style.left = left + "px";
    el.style.top = top + "px";
  };

  const paint = () => {
    [...listEl.querySelectorAll(".wfpick-item")]
      .forEach((b, i) => b.classList.toggle("active", i === active));
    listEl.querySelector(".wfpick-item.active")?.scrollIntoView({ block: "nearest" });
  };

  const foot = () => {
    if (loading) { footEl.innerHTML = `<span class="wfpick-kbd">识别中…</span>`; return; }
    footEl.innerHTML = `<button class="wfpick-alt">＋ 只建一个「${altLabel}」</button>
      <span class="wfpick-kbd">↑↓ 选 · Enter 接上 · Esc 取消</span>`;
    footEl.querySelector(".wfpick-alt").onclick = () => { closeWfPicker(); fallback?.(); };
  };

  const render = () => {
    if (loading) return;
    const kw = q.value.trim().toLowerCase();
    shown = items.filter(w => !kw || w.name.toLowerCase().includes(kw));
    if (!shown.length) {
      listEl.innerHTML = items.length
        ? `<div class="wfpick-hint">没有名字里带「${esc(q.value.trim())}」的工作流</div>`
        : `<div class="wfpick-hint">画布里的工作流都吃不下${cn}。<br>
            换一个工作流再来，或者就建一个${cn}节点放着。</div>`;
      place();
      return;
    }
    listEl.innerHTML = "";
    shown.forEach((w, i) => {
      const set = wfIntake.get(w.file);
      const tags = ["image", "video", "audio", "text"]
        .filter(k => set instanceof Set && set.has(k))
        .map(k => `<span class="wfpick-tag${k === kind ? " on" : ""}">${IN_KINDS[k]?.short || "文"}</span>`)
        .join("");
      const b = document.createElement("button");
      b.className = "wfpick-item" + (i === active ? " active" : "");
      b.title = w.file;
      b.innerHTML = `<span class="wfpick-name">${esc(w.name)}</span><span class="wfpick-tags">${tags}</span>`;
      b.onclick = () => choose(w);
      b.onmouseenter = () => { active = i; paint(); };
      listEl.appendChild(b);
    });
    place();
  };

  const choose = (w) => {
    closeWfPicker();
    chainIntoWorkflow(w, kind, fromId, at);
  };

  q.addEventListener("input", () => { active = 0; render(); });
  el.querySelector(".wfpick-x").onclick = () => closeWfPicker();

  const onKey = (e) => {
    if (!pickerEl) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWfPicker(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!shown.length) return;
      e.preventDefault(); e.stopPropagation();
      active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      paint();
      return;
    }
    if (e.key === "Enter" && !loading) {
      const w = shown[active];
      if (w) { e.preventDefault(); e.stopPropagation(); choose(w); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  pickerOff.push(() => document.removeEventListener("keydown", onKey, true));

  /* 点面板外面 = 取消。延一帧再挂监听，免得被「松手」那一发指针事件立刻关掉 */
  const onDown = (e) => { if (!el.contains(e.target)) closeWfPicker(); };
  setTimeout(() => {
    if (pickerEl !== el) return;
    document.addEventListener("pointerdown", onDown, true);
    pickerOff.push(() => document.removeEventListener("pointerdown", onDown, true));
  }, 0);

  foot(); place(); q.focus();

  if (!S.oi || !(S.workflows || []).length) {
    loading = false; items = []; foot(); render();
    return;
  }
  intakeCandidates(kind, (done, all) => {
    if (pickerEl !== el) return;
    footEl.innerHTML = `<span class="wfpick-kbd">正在识别工作流的输入口 ${done}/${all}…</span>`;
  }).then(list => {
    if (pickerEl !== el) return;
    loading = false; items = list; active = 0; foot(); render();
  }).catch(() => {
    if (pickerEl !== el) return;
    loading = false; items = []; foot(); render();
  });
}

/** 挑中一个工作流：落到松手的位置，把素材接到它第一个能用的槽上 */
async function chainIntoWorkflow(wf, kind, fromId, at) {
  const node = await addWorkflowNode(wf, { x: at.x - 8, y: at.y - 24 });
  if (!node) return null;
  const hit = pickIntake(node, kind);
  if (!hit) {
    toast(`「${wf.name}」里没找到能接${FEED_CN[kind] || kind}的口，节点先落下了`, "err", 4600);
    return node;
  }
  /* 那个加载节点本来是 bypass 的：接上就得救活，否则等于没接 */
  if (hit.bypass) reviveLoader(node, hit.loaderId);
  /* 素材槽光有线还不够：采样节点的 ref_images.N 得显式指到加载节点上 */
  if (hit.slot) wireSlotGroup(node, hit.slot);
  S.edges = S.edges.filter(e => !(e.to === node.id && e.key === hit.key));
  S.edges.push({ from: fromId, to: node.id, key: hit.key, type: kind });
  view.setEdges(S.edges);
  renderNode(node);
  save();
  toast(hit.director
    ? `已接上：「${nodeName(fromId)}」的视频会写进「${node.name}」的导演台时间线，分段模式切到 v2v`
    : `已接上：「${nodeName(fromId)}」→「${node.name}」的${hit.label}`, "ok", hit.director ? 5200 : 3800);
  return node;
}

/** 把槽号显式写进 autogrow 口（不然空槽接上素材，采样节点压根不知道用第几个） */
function wireSlotGroup(node, slot) {
  for (const g of collectAssetSlots(node).groups) {
    if (g.group !== slot.gkey) continue;
    const t = node.prompt[g.pid];
    if (!t?.inputs) continue;
    t.inputs[g.group + "." + g.item + slot.idx] = [String(slot.loader.id), 0];
  }
}

/* ==================================================================
   导演台：模式 + 源视频
   ──────────────────────────────────────────────────────────────────
   导演台（MiniMaxH3Director）是个「整台」节点：图 / 视频 / 音频都不在连线口上，
   全在 timeline_data 那段 JSON 里 —— 分段模式切到 v2v / rv2v 之后，
   源视频从 timeline.video 进来。所以：
     · 判定「能吃视频」看的是有没有导演台（它的入口随模式开关）；
     · 真接的时候，把文件名和帧数写进 timeline_data，顺手把模式切到 v2v。
================================================================== */
const DIRECTOR_CLS = /^(Comfy)?MiniMaxH3Director$/i;
const DIRECTOR_VIDEO_MODE = /^(v2v|rv2v)\b/i;

/** 这个工作流里的导演台节点（一个工作流最多一个） */
function directorOf(node) {
  for (const [id, nd] of Object.entries(node.prompt || {})) {
    if (DIRECTOR_CLS.test(String(nd?.class_type || ""))) return { id, nd };
  }
  return null;
}

/** 改时间线 JSON：字符串进、字符串出；解析失败就原样退回（别把人家的工作流搅坏） */
function patchTimeline(str, fn) {
  if (typeof str !== "string" || !str.trim()) return str;
  let o;
  try { o = JSON.parse(str); } catch { return str; }
  if (!o || typeof o !== "object") return str;
  try { fn(o); } catch { return str; }
  return JSON.stringify(o);
}

function patchDirectorTimeline(node, dirId, fn) {
  const t = node.prompt?.[dirId]?.inputs;
  if (!t || typeof t.timeline_data !== "string") return "";
  const next = patchTimeline(t.timeline_data, fn);
  t.timeline_data = next;
  return next;
}

/** 导演台的分段模式这一格（值得改的是它带着的可选值） */
function directorModeField(node, dirId) {
  return buildFields(node).find(f => String(f.nodeId) === String(dirId) && RE_MODE.test(f.name)) || null;
}

const modeVal = (v) => String(v && typeof v === "object" ? (v.value ?? v.name ?? "") : (v ?? ""));

/** 让导演台切到能吃视频的模式（已经是 v2v / rv2v 就不动），返回切成了什么 */
function ensureDirectorVideoMode(node, dirId) {
  const f = directorModeField(node, dirId);
  if (!f) return "";
  const cur = modeVal(node.params?.[f.key] ?? f.value);
  if (DIRECTOR_VIDEO_MODE.test(cur)) return cur;
  const choices = (f.choices || []).map(modeVal);
  const want = choices.find(c => /^v2v\b/i.test(c)) || choices.find(c => /^rv2v\b/i.test(c)) || "";
  if (!want) return "";
  node.params = node.params || {};
  node.params[f.key] = want;
  /* 时间线里的 taskType 优先级比 widget 高，只改 widget 等于没改 */
  patchDirectorTimeline(node, dirId, (tl) => { (tl.global = tl.global || {}).taskType = want; });
  return want;
}

/** 把一段视频写进导演台时间线（v2v 的源视频只有这一个入口） */
function applyDirectorVideo(node, dirId, fname, meta) {
  const fps = Math.max(1, Math.round(Number(meta?.fps) || 24));
  const frames = Math.max(1, Math.round(Number(meta?.frames) || 0));
  const w = Math.round(Number(meta?.width) || 0);
  const h = Math.round(Number(meta?.height) || 0);
  const next = patchDirectorTimeline(node, dirId, (tl) => {
    tl.timelineMode = "video";
    tl.editMode = "global";
    tl.totalFrames = frames;
    tl.frameRate = fps;
    if (w && h) { tl.width = w; tl.height = h; }
    tl.video = {
      ...(tl.video || {}),
      fileName: fname, videoFile: fname, subfolder: "", type: "input",
      frames: [], frameMap: [], deletedSourceRanges: [],
      sourceFrameCount: frames, width: w, height: h,
      storageWidth: w, storageHeight: h,
    };
    /* 换源视频 = 时间线重来：旧的片段 / 关键帧对不上新片子的长度，留着必定报错 */
    tl.videoClips = [];
    tl.segments = [];
    tl.shots = [];
    tl.keyframes = [];
    tl.global = { ...(tl.global || {}) };
    if (!DIRECTOR_VIDEO_MODE.test(String(tl.global.taskType || ""))) {
      const mode = modeVal(node.params?.[directorModeField(node, dirId)?.key]) || "v2v — 视频转视频(Video to Video)";
      tl.global.taskType = mode;
    }
  });
  return next;
}

/** 导演台这一路「源视频」的连线 key（不是真字段，用 @ 前缀区分） */
const DIRECTOR_VIDEO_KEY = "@video";

/** 这个工作流里接 kind 最好的一格：空着的槽优先、没被停用的优先 */
function pickIntake(node, kind) {
  const info = collectAssetSlots(node);
  const mine = info.slots.filter(s => s.kind === kind);
  if (mine.length) {
    const score = (s) => (s.loader.byp || s.loader.mute ? 2 : 0) + (slotBlank(s.value) ? 0 : 1);
    const s = [...mine].sort((a, b) => score(a) - score(b) || a.idx - b.idx)[0];
    return {
      key: s.loader.id + "|" + s.loader.field,
      loaderId: s.loader.id,
      bypass: !!(s.loader.byp || s.loader.mute),
      label: `${KIND_NAME[kind]} ${s.idx + 1}`,
      slot: s,
    };
  }
  /* 导演台：视频不走连线口，走时间线的源视频 —— 切到 v2v 模式才出现，所以单独一档 */
  if (kind === "video") {
    const dir = directorOf(node);
    if (dir) {
      const mode = ensureDirectorVideoMode(node, dir.id);
      return {
        key: dir.id + "|" + DIRECTOR_VIDEO_KEY, loaderId: dir.id, bypass: false,
        director: dir.id, label: `源视频（导演台·${mode ? mode.split(/[ —]/)[0] : "v2v"}）`,
      };
    }
  }
  /* 没有 autogrow 素材槽的工作流：退回按字段找
     文本要挑「正向」那一格 —— 按名字排序，负向的排到最后，
     不然拖一段提示词进去会直接落到 negative 上 */
  const can = buildFields(node).filter(f => targetType(f) === kind);
  if (can.length) {
    const nameRank = (f) => {
      if (kind !== "text") return 0;
      if (/negative/i.test(f.name)) return 3;
      if (/positive|^prompt$|^text$|^instruction$|^description$/i.test(f.name)) return 0;
      return /prompt|text/i.test(f.name) ? 1 : 2;
    };
    const blankRank = (f) => (slotBlank(node.params[f.key] ?? f.value) ? 0 : 1);
    const pick = [...can].sort((a, b) => nameRank(a) - nameRank(b) || blankRank(a) - blankRank(b))[0];
    return {
      key: pick.key, loaderId: String(pick.nodeId), bypass: false,
      label: cnName(pick) || KIND_NAME[kind],
    };
  }
  /* 容量还空着、只是工作流里没摆加载节点（h3 的参考视频口）：先补一个空槽再接，
     不然这种流永远「能吃但接不上」 */
  if ((info.limits[kind] || 0) > 0) {
    const before = new Set(info.slots.map(s => s.loader.id + "|" + s.loader.field));
    addAssetSlot(node, kind);
    const fresh = collectAssetSlots(node).slots
      .filter(s => s.kind === kind && !before.has(s.loader.id + "|" + s.loader.field))
      .sort((a, b) => a.idx - b.idx)[0];
    if (fresh) {
      return {
        key: fresh.loader.id + "|" + fresh.loader.field,
        loaderId: fresh.loader.id,
        bypass: false,
        label: `${KIND_NAME[kind]} ${fresh.idx + 1}`,
        slot: fresh,
      };
    }
  }
  /* 最后一档：工作流里那个加载节点被 bypass 了，接上先把它救活 */
  const dor = dormantLoaders(node.uiWf).find(d => d.kind === kind);
  if (dor) {
    return {
      key: dor.id + "|" + dor.field, loaderId: dor.id, bypass: true,
      label: `${KIND_CN[kind] || ""}加载节点`,
    };
  }
  return null;
}

/** 把工作流里被 bypass / mute 掉的加载节点救活（只改内存副本，不动磁盘文件） */
function reviveLoader(node, loaderId) {
  const ui = (node.uiWf?.nodes || []).find(n => String(n.id) === String(loaderId));
  if (!ui) return false;
  ui.mode = 0;
  const { prompt } = convertWorkflow(node.uiWf, S.oi);
  node.prompt = prompt;
  restoreExtraSlots(node);
  node.assetOn = [...new Set([...(node.assetOn || []), String(loaderId)])];
  node.assetOff = (node.assetOff || []).filter(x => x !== String(loaderId));
  return true;
}

/** 兜底的老路：就在这儿落一个素材节点并接上 */
function pullIntoInputNode(fromId, kind, w) {
  const n = addInputNode(kind, { x: w.x - 20, y: w.y - 30 });
  if (!n) { view.scheduleEdges(); return null; }
  S.edges.push({ from: fromId, to: n.id, key: null, type: kind });
  view.setEdges(S.edges);
  renderNode(n);
  save();
  toast(`已建「${n.name}」并连上：跑完「${nodeName(fromId)}」的产出会显示在这个节点里`, "ok");
  return n;
}

/* ==================================================================
   素材库：直连 ComfyUI 的 input / output
================================================================== */
const fmtSize = (n) => {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
};

async function libReq(path, opts) {
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch { }
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j ?? {};
}

/** 视频的帧数 / 帧率 / 宽高：导演台 v2v 的时间线要靠它把源视频写准 */
function libProbeVideo(kind, sub, name) {
  return libReq(`/api/lib/probe?kind=${encodeURIComponent(kind)}`
    + `&sub=${encodeURIComponent(sub || "")}&name=${encodeURIComponent(name)}`);
}

async function libInit() {
  try {
    const st = await libReq("/api/lib/root");
    S.lib.root = st;
    if (!st.ok) { renderLibError("自动探测没找到 ComfyUI 的 input / output 目录。"); return; }
    await libLoadProjects();
  } catch (e) {
    renderLibError(e.message);
  }
}

async function libLoadProjects() {
  try {
    const d = await libReq(`/api/lib/projects?kind=${encodeURIComponent(S.lib.kind)}`);
    S.lib.projects = d.projects || [];
    if (S.lib.project && !S.lib.projects.some(p => p.name === S.lib.project)) S.lib.project = "";
    renderLibProjects();
    await libLoadItems();
  } catch (e) {
    $("#lib-count").textContent = "读取失败：" + e.message;
  }
}

async function libLoadItems() {
  const box = $("#lib-items");
  box.innerHTML = `<div class="hint-sm">读取中…</div>`;
  try {
    const d = await libReq(`/api/lib/items?kind=${encodeURIComponent(S.lib.kind)}&project=${encodeURIComponent(S.lib.project)}`);
    S.lib.items = d.items || [];
    renderLibItems();
    $("#lib-count").textContent =
      `${S.lib.kind} / ${S.lib.project || "根目录"} · ${S.lib.items.length} 个文件`;
  } catch (e) {
    box.innerHTML = `<div class="hint-sm">读取失败：${esc(e.message)}</div>`;
  }
}

function renderLibProjects() {
  const box = $("#lib-projects");
  box.innerHTML = "";
  const chip = (label, name, count) => {
    const b = document.createElement("button");
    b.className = "lib-chip" + (S.lib.project === name ? " on" : "");
    b.innerHTML = `<span>${esc(label)}</span>${count != null ? `<span class="n">${count}</span>` : ""}`;
    b.title = name ? `子库：${name}` : "根目录（各子库之外的散文件）";
    b.onclick = () => {
      S.lib.project = name;
      S.lib.sel.clear();
      renderLibProjects();
      libLoadItems();
    };
    /* 子库后面的 ✕ = 整个文件夹一起删（根目录不给这个口） */
    if (name) {
      const x = document.createElement("span");
      x.className = "lib-chip-x";
      x.textContent = "✕";
      x.title = `删除整个子库「${name}」（连里面的文件一起删）`;
      x.onclick = (e) => { e.stopPropagation(); libDeleteProject(name, count); };
      b.appendChild(x);
    }
    return b;
  };
  box.appendChild(chip("根目录", "", null));
  for (const p of S.lib.projects) box.appendChild(chip(p.name, p.name, p.count));
}

/* 勾选用的键：子目录 + 文件名（根目录的 sub 是空串） */
const libKey = (it) => `${it.sub || ""}|${it.name}`;
const libParseKey = (k) => {
  const i = k.indexOf("|");
  return { sub: k.slice(0, i), name: k.slice(i + 1) };
};

function updateLibSelBar() {
  const n = S.lib.sel.size;
  const bar = $("#lib-selbar");
  if (!bar) return;
  bar.classList.toggle("on", n > 0);
  $("#lib-sel-n").textContent = n ? `已选 ${n} 个` : "已选 0";
  $("#lib-sel-del").disabled = !n;
  $("#lib-sel-all").disabled = !S.lib.items.length;
  $("#lib-sel-inv").disabled = !S.lib.items.length;
}

/** 当前子库视图下有哪些文件夹（从文件路径反推，含多级） */
function libDirsOfItems() {
  const base = S.lib.project || "";
  const set = new Set();
  for (const it of S.lib.items) {
    const sub = it.sub || "";
    if (base && sub !== base && !sub.startsWith(base + "/")) continue;
    const rel = base ? sub.slice(base.length + 1) : sub;   /* 剥掉当前子库前缀 */
    if (!rel) continue;
    const segs = rel.split("/");
    for (let i = 1; i <= segs.length; i++) set.add(segs.slice(0, i).join("/"));
  }
  return [...set].sort();
}

function renderLibItems() {
  const box = $("#lib-items");
  box.innerHTML = "";
  /* 选中项可能已经被删掉了，跟当前列表对一次 */
  const alive = new Set(S.lib.items.map(libKey));
  for (const k of [...S.lib.sel]) if (!alive.has(k)) S.lib.sel.delete(k);
  updateLibSelBar();
  if (!S.lib.items.length) {
    box.innerHTML = `<div class="hint-sm">这个子库是空的。点右上角 ⤴ 上传，或把本地文件直接拖进画布。</div>`;
    return;
  }
  /* 子库内部的文件夹：一排 chip，✕ = 连文件夹带内容一起删（侧栏 ✕ 只删一级子库） */
  const dirs = libDirsOfItems();
  if (dirs.length) {
    const bar = document.createElement("div");
    bar.className = "lib-dirs";
    bar.innerHTML = `<span class="lib-dirs-t">文件夹</span>`;
    const base = S.lib.project || "";
    for (const rel of dirs) {
      const full = base ? base + "/" + rel : rel;
      const cnt = S.lib.items.filter(it => (it.sub || "") === full || (it.sub || "").startsWith(full + "/")).length;
      const c = document.createElement("button");
      c.className = "lib-chip";
      c.innerHTML = `<span>${esc(rel)}</span><span class="n">${cnt}</span>`;
      c.title = `${S.lib.kind}/${full} · 当前视图约 ${cnt} 个文件`;
      const x = document.createElement("span");
      x.className = "lib-chip-x";
      x.textContent = "✕";
      x.title = `删除整个文件夹「${full}」（连里面的文件和子目录一起删）`;
      x.onclick = (e) => { e.stopPropagation(); libDeleteDir(full); };
      c.appendChild(x);
      bar.appendChild(c);
    }
    box.appendChild(bar);
  }
  for (const it of S.lib.items) box.appendChild(libItemCard(it));
}

function libItemCard(it) {
  const kind = S.lib.kind;                    // input / output
  const key = libKey(it);
  const el = document.createElement("div");
  el.className = "lib-item" + (S.lib.sel.has(key) ? " picked" : "");
  el.draggable = true;
  el.title = `${it.name}\n${kind}/${it.sub || "根目录"}\n${fmtSize(it.size)}\n拖到画布空白处 = 建节点\n拖到素材格 / 图像输入节点上 = 直接换文件`;

  const th = document.createElement("div");
  th.className = "li-thumb";
  const url = api.viewUrl({ filename: it.name, subfolder: it.sub || "", type: kind });
  if (it.kind === "image") {
    const img = new Image();
    img.src = url; img.loading = "lazy";
    th.appendChild(img);
  } else if (it.kind === "video") {
    const v = document.createElement("video");
    v.src = url; v.muted = true; v.preload = "metadata";
    th.appendChild(v);
  } else {
    th.textContent = it.kind === "audio" ? "🎵" : "📄";
  }

  const nm = document.createElement("div");
  nm.className = "li-name";
  nm.textContent = it.name;

  const sz = document.createElement("div");
  sz.className = "li-size";
  sz.textContent = fmtSize(it.size);

  /* 勾选：批量删除靠它 */
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "li-pick";
  pick.checked = S.lib.sel.has(key);
  pick.title = "勾上（可多选），再点上面的「删除」批量删";
  pick.onchange = () => {
    if (pick.checked) S.lib.sel.add(key); else S.lib.sel.delete(key);
    el.classList.toggle("picked", pick.checked);
    updateLibSelBar();
  };

  const del = document.createElement("button");
  del.className = "li-del";
  del.textContent = "✕";
  del.title = "从磁盘删除这个文件";
  del.onclick = (e) => { e.stopPropagation(); libDelete(it); };

  /* 改名：右下角一个「改」字，点开就把文件名那条换成输入框，就地改 */
  const ren = document.createElement("button");
  ren.className = "li-ren";
  ren.textContent = "改";
  ren.title = "重命名这个文件（扩展名不变）";
  ren.onclick = (e) => { e.stopPropagation(); libRename(it, nm); };

  el.addEventListener("dragstart", (e) => {
    if (e.target.closest(".li-pick")) { e.preventDefault(); return; }   // 别把勾选拖成拖拽
    e.dataTransfer.setData("application/x-xy-lib", JSON.stringify({
      name: it.name, sub: it.sub || "", kind: it.kind, type: kind, size: it.size,
    }));
    e.dataTransfer.setData("text/plain", it.name);
    e.dataTransfer.effectAllowed = "copy";
  });

  el.append(th, nm, sz, pick, ren, del);
  return el;
}

/**
 * 就地改名：文件名那一条换成输入框，扩展名单独当静态后缀摆着。
 *
 * 为什么不弹 prompt 输入整串文件名：
 *   · 整串输入就得自己校验扩展名，手一滑把 .png 写成 .jpg，缩略图立刻认不出来；
 *   · prompt 是浏览器原生弹窗，跟这套深色界面也不是一路。
 * 所以只让人改主干名，扩展名由后端保住（`lib_rename` 只改 stem）。
 * 回车 / 点别处 = 提交，Esc = 放弃。
 */
function libRename(it, nmEl) {
  if (!nmEl || nmEl.querySelector("input")) return;      // 已经在改了
  const dot = it.name.lastIndexOf(".");
  const stem = dot > 0 ? it.name.slice(0, dot) : it.name;
  const ext = dot > 0 ? it.name.slice(dot) : "";
  const card = nmEl.closest(".lib-item");

  const inp = document.createElement("input");
  inp.className = "li-name-in";
  inp.value = stem;
  inp.spellcheck = false;
  const sfx = document.createElement("span");
  sfx.className = "li-name-ext";
  sfx.textContent = ext;

  nmEl.textContent = "";
  nmEl.classList.add("editing");
  nmEl.append(inp, sfx);
  if (card) card.draggable = false;          // 正在改名，别一动就拖走整张卡
  inp.focus();
  inp.select();

  let done = false;
  const restore = () => {
    done = true;
    if (card) card.draggable = true;
    nmEl.classList.remove("editing");
    nmEl.textContent = it.name;
  };
  const commit = async () => {
    if (done) return;
    const v = inp.value.trim();
    if (!v || v === stem) return restore();   // 没改 / 清空了，当放弃
    done = true;
    try {
      const r = await libReq("/api/lib/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: S.lib.kind, sub: it.sub || "", name: it.name, to: v }),
      });
      if (r.unchanged) return restore();
      /* ComfyUI 的节点里存的是文件名，改完旧名就对不上了 —— 提一句，免得跑的时候才发现 */
      toast(`已改名：${it.name} → ${r.name}（画布里引用旧名的要重选）`, "ok");
      /* 勾选状态跟着搬过去，不然批量删会漏掉这个文件 */
      if (S.lib.sel.delete(libKey(it))) S.lib.sel.add(`${it.sub || ""}|${r.name}`);
      await libLoadItems();
    } catch (e) {
      done = false;                           // 失败留在编辑态，名字还能再改
      toast("改名失败：" + e.message, "err");
      inp.focus();
      inp.select();
    }
  };

  inp.onkeydown = (e) => {
    e.stopPropagation();                      // 别让画布快捷键把回车 / Esc 吃掉
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); restore(); }
  };
  inp.onblur = () => commit();
  inp.onmousedown = (e) => e.stopPropagation();
  inp.onclick = (e) => e.stopPropagation();
  inp.ondblclick = (e) => e.stopPropagation();
}

async function libDelete(it) {
  const where = `${S.lib.kind}${it.sub ? "/" + it.sub : ""}`;
  if (!confirm(`删除 ${where}/${it.name} ？\n\n磁盘上的文件会被真正删掉，不能恢复。`)) return;
  try {
    await libReq(`/api/lib/file?kind=${encodeURIComponent(S.lib.kind)}`
      + `&sub=${encodeURIComponent(it.sub || "")}&name=${encodeURIComponent(it.name)}`,
      { method: "DELETE" });
    toast("已删除：" + it.name, "ok");
    await libLoadProjects();
  } catch (e) {
    toast("删除失败：" + e.message, "err");
  }
}

/** 批量删勾选的素材 */
async function libDeleteMany() {
  const list = [...S.lib.sel].map(libParseKey);
  if (!list.length) return;
  const head = list.slice(0, 6).map(x => `· ${x.sub ? x.sub + "/" : ""}${x.name}`).join("\n");
  const more = list.length > 6 ? `\n… 还有 ${list.length - 6} 个` : "";
  if (!confirm(`删除勾选的 ${list.length} 个素材？\n\n${head}${more}\n\n磁盘上的文件会被真正删掉，不能恢复。`)) return;
  try {
    const r = await libReq("/api/lib/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: S.lib.kind, items: list }),
    });
    const bad = (r.failed || []).length;
    toast(`已删除 ${r.deleted} 个素材${bad ? `，${bad} 个没删掉` : ""}`, bad ? "err" : "ok", bad ? 5200 : 3200);
    S.lib.sel.clear();
    await libLoadProjects();
  } catch (e) {
    toast("批量删除失败：" + e.message, "err");
  }
}

/** 删素材库内部的一个文件夹（含里面的文件和子目录）——侧栏 ✕ 只删一级子库，这个管多级 */
/* ==================================================================
   成品库：把节点上满意的产出收进 output/成品库/
   output 是全输出库（废稿成品混在一起），成品库单独放挑出来的图。
   复制不删源；同名自动加 _1 后缀，不覆盖已收的。
================================================================== */
const LIB_KEPT = "成品库";

/** 节点上现在装的文件定位（产出优先，其次本地文件） */
function nodeFileLoc(node) {
  if (node.pulled && node.pulled.value) {
    return { kind: node.pulled.sType || "output", sub: node.pulled.sub || "", name: node.pulled.value };
  }
  if (node.value) {
    return { kind: node.sType || "output", sub: node.sub || "", name: node.value };
  }
  return null;
}

async function collectToLib(node) {
  const f = nodeFileLoc(node);
  if (!f) { toast("这个节点还没有文件", "err"); return; }
  try {
    const r = await libReq("/api/lib/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, lib: LIB_KEPT }),
    });
    /* 记一笔「已存」，按钮变状态；存档带着走，刷新后还认得 */
    if (node.pulled) node.pulled.collected = r.name;
    else node.collected = r.name;
    renderNode(node);
    save();
    toast(`已存到成品库：${r.name}`, "ok");
  } catch (e) {
    toast("保存到成品库失败：" + e.message, "err");
  }
}

/** 做一个「⭐ 存到成品库」按钮；已存过的显示 ✓ 和最终文件名 */
function makeCollectBtn(node) {
  const done = node.pulled ? node.pulled.collected : node.collected;
  const b = document.createElement("button");
  b.className = "btn btn-ghost" + (done ? " ok" : "");
  b.textContent = done ? "已存 ✓" : "⭐ 存到成品库";
  b.title = done
    ? `已收进成品库：${done}\n再点一次会另存一份（同名自动加后缀）`
    : `把这份产出复制进「${LIB_KEPT}」子库（output/${LIB_KEPT}/），源文件不动`;
  b.onclick = () => collectToLib(node);
  return b;
}

async function libDeleteDir(sub) {
  if (!sub) return;
  const n = S.lib.items.filter(it => (it.sub || "") === sub || (it.sub || "").startsWith(sub + "/")).length;
  if (!confirm(`删除文件夹「${sub}」？\n\n${S.lib.kind}/${sub} 里的文件`
    + `（含子目录里的，当前视图约 ${n} 个）会一起删掉，不能恢复。`)) return;
  try {
    const r = await libReq(`/api/lib/dir?kind=${encodeURIComponent(S.lib.kind)}`
      + `&sub=${encodeURIComponent(sub)}`, { method: "DELETE" });
    toast(`已删除文件夹「${sub}」（${r.deleted_files || 0} 个文件）`, "ok");
    S.lib.sel.clear();
    await libLoadItems();
  } catch (e) {
    toast("删除文件夹失败：" + e.message, "err");
  }
}

/** 整个子库（文件夹）一起删 */
async function libDeleteProject(name, count) {
  if (!name) return;
  const n = count == null ? "全部" : count;
  if (!confirm(`删除整个子库「${name}」？\n\n${S.lib.kind}/${name} 里的 ${n} 个文件`
    + `（含子目录里的）会一起删掉，不能恢复。`)) return;
  try {
    const r = await libReq(`/api/lib/project?kind=${encodeURIComponent(S.lib.kind)}`
      + `&name=${encodeURIComponent(name)}`, { method: "DELETE" });
    toast(`已删除子库「${name}」（${r.deleted_files || 0} 个文件）`, "ok");
    if (S.lib.project === name) S.lib.project = "";
    S.lib.sel.clear();
    await libLoadProjects();
  } catch (e) {
    toast("删除子库失败：" + e.message, "err");
  }
}

function libUpload() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.onchange = async () => {
    const files = [...(inp.files || [])];
    if (!files.length) return;
    let ok = 0;
    for (const f of files) {
      try { await api.uploadImage(f, S.lib.project); ok++; }
      catch (e) { toast(`上传 ${f.name} 失败：${e.message}`, "err"); }
    }
    if (ok) toast(`已上传 ${ok} 个文件到 ${S.lib.project || "根目录"}`, "ok");
    await libLoadProjects();
  };
  inp.click();
}

async function libNewProject() {
  const name = prompt("新建子库（按项目命名，会创建目录）：", "");
  if (!name || !name.trim()) return;
  try {
    await libReq("/api/lib/project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: S.lib.kind, name: name.trim() }),
    });
    S.lib.project = name.trim();
    await libLoadProjects();
    toast("已创建子库：" + name.trim(), "ok");
  } catch (e) {
    toast("创建失败：" + e.message, "err");
  }
}

function renderLibError(msg) {
  $("#lib-projects").innerHTML = "";
  $("#lib-items").innerHTML = `
    <div class="lib-err"><b>素材库没就绪</b><br>${esc(msg || "")}<br>
      填 ComfyUI 根目录（里面要同时有 input 和 output 两个文件夹）：
      <input id="lib-root-input" placeholder="例如 E:/ComfyUI-aki-v3.2/ComfyUI" spellcheck="false">
      <button class="mini-btn" id="lib-root-save" style="margin-top:6px">保存并重试</button>
    </div>`;
  $("#lib-root-save").onclick = async () => {
    const root = $("#lib-root-input").value.trim();
    if (!root) return;
    try {
      await libReq("/api/lib/root", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      await libInit();
    } catch (e) {
      toast("设置失败：" + e.message, "err");
    }
  };
}

/** 素材库 → 画布：拖进来直接变成内容节点（已在磁盘上，不用重传） */
async function addLibNode(item, cx, cy) {
  const p = view.screenToWorld(cx, cy);
  const at = { x: p.x - 140, y: p.y - 70 };
  const kind = item.kind || "image";

  if (kind === "text") {
    try {
      const url = api.viewUrl({ filename: item.name, subfolder: item.sub || "", type: item.type || "input" });
      const txt = await (await fetch(url)).text();
      const node = addInputNode("text", at);
      if (node) {
        node.name = item.name;
        node.value = txt.slice(0, 20000);
        renderNode(node);
        save();
      }
    } catch (e) {
      toast("读取文本失败：" + e.message, "err");
    }
    return;
  }

  const got = { filename: item.name, subfolder: item.sub || "", type: item.type || "input" };
  const node = makeContentNode(kind, got, at.x, at.y, item.name);
  renderNode(node);
  view.select(node.id);
  save();
  toast(`已放到画布：${item.name}`, "ok");
}

function centerScreen() {
  const r = $("#stage").getBoundingClientRect();
  const w = view.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  return { x: w.x - 160 + (Math.random() * 40 - 20), y: w.y - 140 + (Math.random() * 40 - 20) };
}

/* ==================================================================
   持久化
================================================================== */
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 350); }

function save() {
  /* 恢复还没走完时，S.nodes 是空的；这时候写回去等于把上次的画布清掉 */
  if (S.restoring) return;
  const data = {
    v: 1, view: view.view, seq: S.seq,
    /* 用户拖出来的参数排列（按工作流文件名记）：跟着画布一起存，
       重开以后面板还是他排好的那个样子 */
    orders: S.orders,
    nodes: S.nodes.map(n => ({
      id: n.id, kind: n.kind, file: n.file, name: n.name, wfKind: n.wfKind,
      inKind: n.inKind, value: n.value, sub: n.sub, sType: n.sType,
      /* 素材节点接住的产出（上游写进来的），要一起存，不然刷新就没了 */
      pulled: n.pulled,
      collected: n.collected,
      x: view.getPos(n.id).x, y: view.getPos(n.id).y,
      w: view.getSize(n.id).w, h: view.getSize(n.id).h,
      params: n.params, src: n.src,
      /* 素材槽：画布补出来的加载节点 + 用户点开过的空槽 + 明确启用/停用过的 */
      extraSlots: n.extraSlots, emptyShown: n.emptyShown, assetOn: n.assetOn, assetOff: n.assetOff,
      /* 上次见到的工作流结构指纹：下次恢复时拿来判断 ComfyUI 那边有没有改过 */
      wfSig: n.wfSig,
      /* 上次见到文件时各节点的 mode：用来分清「启停是谁改的」 */
      wfModes: n.wfModes,
    })),
    edges: S.edges,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { }
}

function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    S.seq = d.seq || 1;
    S.orders = d.orders && typeof d.orders === "object" ? d.orders : {};
    S.edges = Array.isArray(d.edges) ? d.edges : [];
    S._pending = Array.isArray(d.nodes) ? d.nodes : [];
    S.restoring = S._pending.length > 0;      // 恢复完成前禁止 save 覆盖
    if (d.view) view.setView(d.view);
    view.setEdges(S.edges);
  } catch (e) {
    console.error("恢复画布失败", e);
  }
}

/** 连上 ComfyUI 后再把节点真正建出来 */
async function resumeNodes() {
  if (!S._pending?.length) { S.restoring = false; return; }
  const list = S._pending; S._pending = null;
  const bad = [];
  const synced = [];                   // 这次恢复时发现 ComfyUI 那边改过的工作流
  for (const p of list) {
    /* 素材节点 / 内容节点不需要问 ComfyUI 要定义，直接重建 */
    if (p.kind === "input" || p.kind === "image" || p.kind === "content") {
      const isContent = p.kind === "content";
      const inKind = p.inKind || "image";
      const node = {
        id: p.id || uid(),
        kind: isContent ? "content" : "input",
        inKind,
        name: p.name || (isContent ? `结果 · ${WANT_CN[inKind] || ""}` : (IN_KINDS[inKind]?.label || "素材")),
        x: p.x, y: p.y, params: {},
        w: p.w, h: p.h,
        value: p.value || "", sub: p.sub || "", sType: p.sType || "",
        src: p.src || "",
        /* 上次接住的产出：连着的线恢复后还要能看出「这是谁给的」 */
        pulled: p.pulled || null,
        status: (p.value || isContent || p.pulled) ? "done" : "idle", error: "", result: null,
      };
      S.nodes.push(node);
      mountNode(node);
      view.setPos(node.id, p.x, p.y);
      continue;
    }
    if (p.kind !== "workflow") { bad.push(p.name || p.file || "?"); continue; }
    const wf = S.workflows.find(w => w.file === p.file);
    if (!wf) { bad.push(p.name || p.file || "?"); continue; }
    try {
      /* 每次恢复都直接读磁盘上的工作流文件（api 层禁了缓存），
         所以在 ComfyUI 里启用/停用 LoRA、改参数，刷新画布就能跟上 */
      const [uiWf, meta] = await Promise.all([
        api.getWorkflow(wf.file),
        api.getWorkflowMeta(wf.file).catch(() => null),
      ]);
      const node = { ...p, params: p.params || {}, status: "idle", result: null };
      const r = adoptWorkflow(node, uiWf, meta);
      S.nodes.push(node);
      mountNode(node);
      view.setPos(node.id, p.x, p.y);
      /* 旧存档没有 wfModes：画布上的启停状态还没写进文件，补一次，
         否则「不启用」只停在画布上，ComfyUI 那边仍然是启用 */
      if (r.legacy && syncCfg.push && (node.assetOn?.length || node.assetOff?.length)) {
        pushModesToComfy(node, { quiet: true }).catch(() => { });
      }
      /* 上次存下来的结构指纹对不上 = ComfyUI 那边改过，记一条给它个说法 */
      if (p.wfSig && p.wfSig !== node.wfSig && (r.added || r.removed || r.conflicts.length)) {
        synced.push({ name: node.name, ...r });
      }
    } catch (e) {
      console.warn("恢复节点失败", p.file, e);
      bad.push(p.name || p.file || "?");
    }
  }
  /* 有的节点这次没恢复出来（工作流被删/改名），挂在它身上的线也要清掉，
     否则卡片上会显示「来自某个不存在的节点」 */
  const alive = new Set(S.nodes.map(n => n.id));
  const kept = S.edges.filter(e => alive.has(e.from) && alive.has(e.to));
  if (kept.length !== S.edges.length) S.edges = kept;
  view.setEdges(S.edges);
  /* 节点是一个一个建起来的：先建的卡片当时还查不到「来自谁」，这里补画一遍 */
  for (const n of S.nodes) if (n.kind === "workflow") renderNode(n);
  if (S.nodes.length) $("#empty-tip").classList.add("hide");
  if (bad.length) toast(`有 ${bad.length} 个节点没能恢复：${bad.join("、")}`, "err", 6000);
  /* ComfyUI 那边改过（启用/停用节点、增删节点、改参数）→ 说明一句，别让人以为画布没跟上 */
  if (synced.length) {
    const one = synced[0];
    const bits = [];
    if (one.added) bits.push(`+${one.added} 节点`);
    if (one.removed) bits.push(`-${one.removed} 节点`);
    if (one.conflicts.length) bits.push(`${one.conflicts.length} 个参数`);
    toast(synced.length === 1
      ? `「${one.name}」已按 ComfyUI 最新文件重建（${bits.join("，")}）`
      : `${synced.length} 个工作流已按 ComfyUI 最新文件重建（如「${one.name}」${bits.join("，")}）`,
      "ok", 5000);
  }
  S.restoring = false;
  save();                       // 这次写回去的是真正恢复出来的节点
}

/* ==================================================================
   画布背景：日间模式 / 自定义背景图
   日间标志走 localStorage（一个小串）；背景图是几 MB 的 dataURL，
   localStorage 一共才 5MB 左右，一张高清图就能把配额爆掉
   （setItem 抛 QuotaExceededError，还会连累画布存档写不进去），
   所以图片存 IndexedDB。
================================================================== */
function applyDay(on) {
  document.body.classList.toggle("day", !!on);
  localStorage.setItem("xy-wxhb.day", on ? "1" : "0");
  $("#btn-day").classList.toggle("active", !!on);
  view.scheduleEdges();   // 线色跟着变量走，重画一次
}

/* ---- IndexedDB 小helper：只服务背景图 ---- */
const BG_DB = "xy-wxhb-bg";
function bgIdb(mode, val) {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(BG_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("bg");
    rq.onsuccess = () => {
      const st = rq.result.transaction("bg", mode === "get" ? "readonly" : "readwrite").objectStore("bg");
      let out;
      if (mode === "get") out = st.get("bgimg");
      else if (mode === "set") out = st.put(val, "bgimg");
      else out = st.delete("bgimg");
      out.onsuccess = () => res(out.result);
      out.onerror = () => rej(out.error);
    };
    rq.onerror = () => rej(rq.error);
  });
}

async function applyBgImg(dataUrl) {
  const el = $("#bgimg");
  if (dataUrl) {
    el.style.backgroundImage = `url("${dataUrl}")`;
    el.classList.remove("hide");
    try {
      await bgIdb("set", dataUrl);
    } catch (e) {
      toast(`背景图本次生效，但没能存下来（${e.message || "写入失败"}），刷新后要重选`, "err", 6500);
    }
  } else {
    el.style.backgroundImage = "";
    el.classList.add("hide");
    try { await bgIdb("del"); } catch { }
  }
  $("#btn-bgimg").classList.toggle("active", !!dataUrl);
}

/** 选一张本地图片当画布背景：读成 dataURL，太大了先缩放再存 */
function pickBgImg() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    let url = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    if (url.length > 3.5e6) {
      url = await shrinkImage(url);
      if (url.length > 5e6) {
        toast("这张图太大了（缩放后仍超 5MB），已放弃设置", "err");
        return;
      }
    }
    applyBgImg(url);
    toast("背景图已设置；再点一次「🖼 背景」可清除", "ok");
  };
  inp.click();
}

/** canvas 缩放：长边压到 1920，透明底保留 png，其余转 jpeg */
function shrinkImage(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1920 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, c.width, c.height);
      const alpha = /^data:image\/png/i.test(dataUrl);
      res(c.toDataURL(alpha ? "image/png" : "image/jpeg", .88));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

/* ==================================================================
   导入 / 导出
================================================================== */
function exportCanvas() {
  const at = new Map(S.nodes.map((n, i) => [n.id, i]));
  const data = {
    app: "xy-wxhb", v: 2,
    nodes: S.nodes.map(n => ({
      kind: n.kind, file: n.file, name: n.name, wfKind: n.wfKind,
      inKind: n.inKind, value: n.value, sub: n.sub, sType: n.sType,
      /* 素材节点接住的产出（上游写进来的），要一起存，不然刷新就没了 */
      pulled: n.pulled,
      collected: n.collected,
      x: view.getPos(n.id).x, y: view.getPos(n.id).y,
      w: view.getSize(n.id).w, h: view.getSize(n.id).h,
      params: n.params, src: n.src,
      extraSlots: n.extraSlots, emptyShown: n.emptyShown, assetOn: n.assetOn, assetOff: n.assetOff,
      wfModes: n.wfModes,
    })),
    /* 线按节点下标存，导入时 id 会重新生成，下标不会 */
    edges: S.edges
      .map(e => ({ a: at.get(e.from), b: at.get(e.to), key: e.key, type: e.type }))
      .filter(e => e.a !== undefined && e.b !== undefined),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `canvas-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast(`已导出画布 JSON（${data.nodes.length} 节点 / ${data.edges.length} 条线）`, "ok");
}

async function importCanvas(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.nodes)) throw new Error("不是画布文件");
    const made = [];
    for (const n of d.nodes) {
      let created = null;
      if (n.kind === "workflow") {
        const wf = S.workflows.find(w => w.file === n.file) || { file: n.file, name: n.name, kind: n.wfKind || "image" };
        created = await addWorkflowNode(wf, { x: n.x, y: n.y });
        if (created) {
          if (n.params) created.params = n.params;
          created.extraSlots = n.extraSlots;
          created.emptyShown = n.emptyShown;
          created.assetOn = n.assetOn;
          created.assetOff = n.assetOff;
          restoreExtraSlots(created);
          renderNode(created);
        }
      } else if (n.kind === "input" || n.kind === "image") {
        const inKind = n.inKind || "image";
        created = addInputNode(inKind, { x: n.x, y: n.y });
        if (created) {
          created.name = n.name || created.name;
          created.value = n.value || "";
          created.src = n.src || "";
          created.pulled = n.pulled || null;
          created.status = (created.value || created.pulled) ? "done" : "idle";
          renderNode(created);
        }
      } else if (n.kind === "content") {
        const got = { filename: n.value, subfolder: n.sub || "", type: n.sType || "output" };
        created = makeContentNode(n.inKind || "image", n.inKind === "text" ? { value: n.value } : got,
          n.x, n.y, n.name);
        renderNode(created);
      }
      made.push(created);      // 下标必须和 d.nodes 对齐，否则线会连错
      if (created && (n.w || n.h)) view.setSize(created.id, n.w, n.h);
    }
    let wired = 0;
    for (const ed of (d.edges || [])) {
      const from = made[ed.a], to = made[ed.b];
      if (!from || !to) continue;
      S.edges = S.edges.filter(x => !(x.to === to.id && x.key === ed.key));
      S.edges.push({ from: from.id, to: to.id, key: ed.key ?? null, type: ed.type });
      wired++;
    }
    view.setEdges(S.edges);
    /* 线是最后才接的，卡片上「来自谁」要重画一遍才对 */
    for (const n of S.nodes) if (n.kind === "workflow") renderNode(n);
    save();
    toast(`导入完成：${made.filter(Boolean).length} 个节点${wired ? ` · ${wired} 条线` : ""}`, "ok");
  } catch (err) {
    toast("导入失败：" + err.message, "err");
  }
  e.target.value = "";
}

/* 调试钩子：F12 里敲 __xy.S / __xy.view 就能看当前状态，排查问题用 */
window.__xy = {
  S,
  save,
  renderNode,
  paintStatus,
  runNode,
  addWorkflowNode,
  addInputNode,
  addLibNode,
  makeContentNode,
  syncOutputs,
  uploadToNode,
  targetType,
  classify,
  buildFields,
  convertWorkflow,
  cnName,
  computeStages,
  loraCard,
  setLoraOff,
  reviveLora,
  bypassLoraInPrompt,
  grid2,
  libDeleteMany,
  libDeleteProject,
  libDeleteDir,
  libRename,
  applyDay,
  collectToLib,
  makeCollectBtn,
  LIB_KEPT,
  applyBgImg,
  shrinkImage,
  pickBgImg,
  bgIdb,
  renderLibItems,
  libLoadProjects,
  libLoadItems,
  collectAssetSlots,
  addAssetSlot,
  wireAssetSlots,
  setAssetOff,
  lockedKeysOf,
  lockMapOf,
  syncFromComfy,
  pushModesToComfy,
  followComfyChanges,
  markUnsynced,
  loraSyncChip,
  loraNameOf,
  checkWorkflowStale,
  queueParamPush,
  flushParamPush,
  flushNodePush,
  flushPendingPushes,
  queueTextPush,
  readUiWidget,
  setUiWidget,
  wfDigest,
  createPulledInput,
  openWfPicker,
  chainIntoWorkflow,
  intakeCandidates,
  pickIntake,
  intakeKindsOf,
  hasDurationParam,
  connectEdge,
  upstreamValue,
  directorOf,
  ensureDirectorVideoMode,
  applyDirectorVideo,
  patchTimeline,
  libProbeVideo,
  applyPulled,
  pulledUrl,
  removeNode,
  removeNodes,
  copySelection,
  pasteClip,
  duplicateSelection,
  updateSelBar,
  libInit,
  IN_KINDS,
  get view() { return view; },
};

init();
