/**
 * canvas.js —— 无限画布视图
 * 负责：平移 / 缩放 / 网格 / 节点拖动选中 / 框选 / 节点改大小 / 坐标换算
 * 节点内容由外部（app.js）创建，这里只管「摆在哪、多大、怎么动」。
 */

const MIN_W = 200;      // 节点最小宽（缩放到底也不会更窄）
const MIN_H = 84;       // 最小高：至少露出标题栏 + 一行

export class CanvasView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.stage   可视区域
   * @param {HTMLElement} o.world   参与变换的容器
   * @param {HTMLElement} o.nodesEl 节点层
   * @param {Function}    o.onSelect 选中变化 (ids:Set)
   * @param {Function}    o.onChange 视图或节点位置变化（用于持久化）
   */
  constructor({ stage, world, nodesEl, edgesEl, onSelect, onChange, onResize }) {
    this.stage = stage;
    this.world = world;
    this.nodesEl = nodesEl;          // 节点层容器
    this.edgesEl = edgesEl;
    this.nodes = new Map();          // id -> {el, x, y, w, h}
    this.edges = [];                 // [{from, to, key}]
    this._edgeEls = new Map();       // "from|to|key" -> {el, base, glow, flow, d}
    this._temp = null;               // 拖线时的临时曲线
    this._raf = null;
    this.view = { x: 0, y: 0, k: 1 };
    this.selected = new Set();
    this.onSelect = onSelect || (() => { });
    this.onChange = onChange || (() => { });
    /* 节点尺寸变了（拖右下角 / 双击还原）—— 内容要跟着重排，光靠 onChange 分不清是拖动还是改大小 */
    this.onResize = onResize || (() => { });
    this._drag = null;
    this._spaceDown = false;
    this._bind();
    this.apply();
  }

  /* ---------------- 视图 ---------------- */
  apply() {
    const { x, y, k } = this.view;
    /* zoom 是「布局级」缩放：文字按放大后的物理尺寸重新排版渲染，
       不会像 transform:scale 那样把位图拉伸糊掉。
       位移仍走 transform——但 zoom 会连 transform 的长度值一起缩放，
       所以这里除以 k，屏幕上看到的正好是 x/y 像素的平移。 */
    this.world.style.zoom = k;
    this.world.style.transform = `translate3d(${x / k}px, ${y / k}px, 0)`;
    const grid = 24 * k;
    this.stage.style.setProperty("--grid", grid + "px");
    this.stage.style.setProperty("--grid-x", x + "px");
    this.stage.style.setProperty("--grid-y", y + "px");
    document.getElementById("zoom-label") && (document.getElementById("zoom-label").textContent = Math.round(k * 100) + "%");
    this.scheduleEdges();
    this.onChange();
  }

  /* ---------------- 连线 ---------------- */
  setEdges(list) { this.edges = list || []; this.scheduleEdges(); }

  scheduleEdges() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.renderEdges(); });
  }

  /** 端口中心 → 世界坐标（用真实 DOM 位置算，折叠/换行都不会错位） */
  portWorld(el) {
    const r = el.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const k = this.view.k;
    return {
      x: (r.left + r.width / 2 - s.left - this.view.x) / k,
      y: (r.top + r.height / 2 - s.top - this.view.y) / k,
    };
  }

  renderEdges() {
    const svg = this.edgesEl;
    if (!svg) return;
    /* 端口用一次性的映射表找，别拼选择器：key 里带 | 和 . 拼进去容易歧义 */
    const ports = new Map();
    for (const p of document.querySelectorAll(".node .port")) {
      if (p.dataset.port && this._portVisible(p)) ports.set(p.dataset.port, p);
    }
    /* 拖线结束就撤掉那根跟随鼠标的曲线 */
    if (this._temp) { this._temp.remove(); this._temp = null; }

    const seen = new Set();
    for (const e of this.edges || []) {
      const a = ports.get("out:" + e.from);
      const b = ports.get("in:" + e.to + (e.key ? ":" + e.key : ""));
      if (!a || !b) continue;
      const key = e.from + "|" + e.to + "|" + (e.key || "");
      seen.add(key);
      const p1 = this.portWorld(a), p2 = this.portWorld(b);
      const dx = Math.max(50, Math.abs(p2.x - p1.x) * 0.45);
      const d = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
      /* 线元素复用，不整块重建 innerHTML —— 重建会让流光的动画每帧从头开始，
         拖动 / 缩放的时候看着就像卡住的虚线。 */
      let g = this._edgeEls.get(key);
      if (!g) {
        g = this._makeEdgeEls();
        this._edgeEls.set(key, g);
      }
      if (g.d !== d) {
        g.base.setAttribute("d", d);
        g.glow.setAttribute("d", d);
        g.flow.setAttribute("d", d);
        g.d = d;
      }
    }
    /* 删掉已经不存在的线 */
    for (const [k, g] of this._edgeEls) {
      if (seen.has(k)) continue;
      g.el.remove();
      this._edgeEls.delete(k);
    }
  }

  /** 一根线 = 底线 + 流光光晕 + 流光芯（同一段 dash，靠 CSS 动画往前跑） */
  _makeEdgeEls() {
    const NS = "http://www.w3.org/2000/svg";
    const mk = (cls, extra = {}) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("class", cls);
      for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v);
      return p;
    };
    const el = document.createElementNS(NS, "g");
    el.setAttribute("class", "edge");
    const base = mk("edge-base", { "vector-effect": "non-scaling-stroke" });
    /* pathLength=100：dash 按「整条线的百分比」算，线的长短不一也不会有的跑得快有的慢 */
    const glow = mk("edge-glow", { pathLength: "100" });
    const flow = mk("edge-flow", { pathLength: "100" });
    /* 错开相位，一堆线不会同步闪 */
    const delay = (-Math.random() * 2.6).toFixed(2) + "s";
    glow.style.animationDelay = delay;
    flow.style.animationDelay = delay;
    el.append(base, glow, flow);
    this.edgesEl.appendChild(el);
    return { el, base, glow, flow, d: "" };
  }

  /**
   * 端口是不是真的看得见：折叠的节点里 rect 是 0，
   * 节点缩小后滚动出可视区的端口也不该画线（否则线会飘到节点外面去）。
   */
  _portVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const node = el.closest(".node");
    if (!node) return true;
    const nb = node.getBoundingClientRect();
    if (r.bottom < nb.top + 4 || r.top > nb.bottom - 4) return false;
    const body = el.closest(".node-body");
    if (body && body.scrollHeight > body.clientHeight + 2) {
      const bb = body.getBoundingClientRect();
      if (r.bottom < bb.top + 2 || r.top > bb.bottom - 2) return false;
    }
    return true;
  }

  /** 拖线时的临时线（一根跟随鼠标的曲线） */
  showTempEdge(fromEl, clientX, clientY) {
    const svg = this.edgesEl;
    if (!svg) return;
    const p1 = this.portWorld(fromEl);
    const s = this.stage.getBoundingClientRect();
    const k = this.view.k;
    const p2 = { x: (clientX - s.left - this.view.x) / k, y: (clientY - s.top - this.view.y) / k };
    const dx = Math.max(50, Math.abs(p2.x - p1.x) * 0.45);
    if (!this._temp) {
      this._temp = document.createElementNS("http://www.w3.org/2000/svg", "path");
      this._temp.setAttribute("class", "temp");
      this._temp.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(this._temp);
    }
    this._temp.setAttribute("d",
      `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`);
  }


  setView(v) { this.view = { ...this.view, ...v }; this.apply(); }

  screenToWorld(cx, cy) {
    const r = this.stage.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }

  /** 以某个屏幕点为锚点缩放 */
  zoomAt(factor, cx, cy) {
    const k0 = this.view.k;
    const k = Math.min(2.5, Math.max(0.12, k0 * factor));
    if (k === k0) return;
    const r = this.stage.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    this.view.x = px - (px - this.view.x) * (k / k0);
    this.view.y = py - (py - this.view.y) * (k / k0);
    this.view.k = k;
    this.apply();
  }

  /** 把某个世界坐标点放到视图中心 */
  centerOn(wx, wy) {
    const r = this.stage.getBoundingClientRect();
    this.view.x = r.width / 2 - wx * this.view.k;
    this.view.y = r.height / 2 - wy * this.view.k;
    this.apply();
  }

  fitToContent(padding = 60) {
    if (!this.nodes.size) { this.view = { x: 0, y: 0, k: 1 }; this.apply(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes.values()) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.el.offsetWidth || 320));
      maxY = Math.max(maxY, n.y + (n.el.offsetHeight || 200));
    }
    const r = this.stage.getBoundingClientRect();
    const k = Math.min(1, Math.max(0.12,
      Math.min((r.width - padding * 2) / (maxX - minX), (r.height - padding * 2) / (maxY - minY))));
    this.view.k = k;
    this.view.x = r.width / 2 - ((minX + maxX) / 2) * k;
    this.view.y = r.height / 2 - ((minY + maxY) / 2) * k;
    this.apply();
  }

  /* ---------------- 节点 ---------------- */
  addNode(id, el, x, y, w, h) {
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    el.dataset.id = id;
    this.nodes.set(id, { el, x, y, w: w ?? null, h: h ?? null });
    this.nodesElAppend(el);
    this._watchDrag(el, id);
    this._watchResize(el, id);
    if (w != null || h != null) this.setSize(id, w, h);   // 恢复上次拖出来的尺寸
    return this.nodes.get(id);
  }

  nodesElAppend(el) { this.nodesEl.appendChild(el); }

  getPos(id) { const n = this.nodes.get(id); return n ? { x: n.x, y: n.y } : { x: 0, y: 0 }; }

  getSize(id) { const n = this.nodes.get(id); return n ? { w: n.w ?? null, h: n.h ?? null } : { w: null, h: null }; }

  /** 改节点尺寸；w/h 传 null 表示这一维不动 */
  setSize(id, w, h) {
    const n = this.nodes.get(id);
    if (!n) return;
    if (w != null) {
      n.w = Math.round(Math.max(MIN_W, w));
      n.el.style.width = n.w + "px";
    }
    if (h != null) {
      n.h = Math.round(Math.max(MIN_H, h));
      n.el.style.height = n.h + "px";
    }
    n.el.classList.add("resized");
    this.scheduleEdges();
    this.onResize(id);
    this.onChange();
  }

  /** 回到「按内容自适应」：去掉拖出来的宽高 */
  resetSize(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.w = null; n.h = null;
    n.el.style.width = "";
    n.el.style.height = "";
    n.el.classList.remove("resized");
    this.scheduleEdges();
    this.onResize(id);
    this.onChange();
  }

  setPos(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.x = x; n.y = y;
    n.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.scheduleEdges();
    this.onChange();
  }

  removeNode(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.el.remove();
    this.nodes.delete(id);
    this.selected.delete(id);
    this.scheduleEdges();
    this.onSelect(this.selected);
    this.onChange();
  }

  clear() {
    for (const id of [...this.nodes.keys()]) this.removeNode(id);
    this.selected.clear();
    this.onSelect(this.selected);
  }

  select(id, additive = false) {
    if (!additive) this.selected.clear();
    if (id) {
      if (additive && this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    }
    this._paintSelection();
    this.onSelect(this.selected);
  }

  /** 一次性选中一批（框选 / 全选 / 粘贴后用） */
  selectMany(ids, additive = false) {
    if (!additive) this.selected.clear();
    for (const id of ids || []) if (this.nodes.has(id)) this.selected.add(id);
    this._paintSelection();
    this.onSelect(this.selected);
  }

  clearSelection() { this.selectMany([]); }

  /** 内部用：只在真的变了才重画，框选时每移动一像素都调也不会卡 */
  _setSelection(set) {
    let same = set.size === this.selected.size;
    if (same) for (const id of set) if (!this.selected.has(id)) { same = false; break; }
    if (same) return;
    this.selected = set;
    this._paintSelection();
    this.onSelect(this.selected);
  }

  _paintSelection() {
    for (const [id, n] of this.nodes) n.el.classList.toggle("selected", this.selected.has(id));
  }

  /* ---------------- 交互 ---------------- */
  _bind() {
    /* 滚轮：
       · 节点内部 —— 只滚节点自己的内容。滚到顶 / 到底就停住，不再顺势把画布放大缩小
         （以前滚到底再滚一下，整个画布「唰」地缩放，手一滑就找不到自己刚才在看哪儿）
       · 节点外部空白画布 —— 滚轮缩放
       · 想在哪都能缩放：按住 Ctrl / ⌘ 滚滚轮（触控板捏合同样走这条） */
    this.stage.addEventListener("wheel", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        const sc = this._scrollableUnder(e.target);
        if (sc) {
          /* 有滑道就必须滚得动：先让浏览器原生滚（触控板的惯性、平滑滚动都留着），
             下一帧再看一眼 —— 要是压根没动，就自己按 deltaY 滚一格。
             以前这里只是「不拦」：浏览器一旦没接手，滚轮就彻底失效，
             滑道明明在那儿却拖不动。 */
          this._nudgeScroll(sc, e);
          return;
        }
        /* 节点里但确实没得滚：吃掉，别顺手把画布缩放了 */
        if (e.target?.closest?.(".node")) { e.preventDefault(); return; }
      }
      e.preventDefault();
      const f = Math.pow(1.0015, -e.deltaY);
      this.zoomAt(f, e.clientX, e.clientY);
    }, { passive: false });

    /* 平移：空白处左键拖 / 中键拖
       空格 + 左键 留给「框选」（见 _startMarquee），不再兼做平移 */
    this.stage.addEventListener("pointerdown", (e) => {
      const onBlank = e.target === this.stage || e.target === this.world || e.target.classList.contains("edges");
      const middle = e.button === 1;
      /* 空格 + 左键 = 框选：在节点上按下也算，方便从节点边上起手 */
      if (this._spaceDown && e.button === 0) {
        e.preventDefault();
        this._startMarquee(e);
        return;
      }
      if (!(onBlank && e.button === 0) && !middle) return;
      e.preventDefault();
      this.stage.classList.add("panning");
      const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      const move = (ev) => {
        this.view.x = start.vx + (ev.clientX - start.x);
        this.view.y = start.vy + (ev.clientY - start.y);
        this.apply();
      };
      const up = () => {
        this.stage.classList.remove("panning");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    /* 空格键：进入「框选态」（光标变十字），松开退出 */
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) {
        if (!this._spaceDown) {
          this._spaceDown = true;
          this.stage.classList.add("space-mode");
        }
        e.preventDefault();          // 别让空格把页面/按钮滚出去
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this._spaceDown = false;
        this.stage.classList.remove("space-mode");
      }
    });
    /* 切走窗口时空格 keyup 收不到，兜一下，免得光标一直卡在十字 */
    window.addEventListener("blur", () => {
      this._spaceDown = false;
      this.stage.classList.remove("space-mode");
    });
  }

  /**
   * 鼠标下面最近的一个「竖向能滚」的元素（且必须在节点里）。
   * 不只看 .node-body —— 提示词文本框、素材胶囊、下拉列表这些自己也能滚，
   * 滚它们的时候同样不该被画布顺手缩放。
   */
  _scrollableUnder(el) {
    for (let x = el; x && x !== this.stage; x = x.parentElement) {
      /* 走到节点外面就收手：画布本身的滚动不算数 */
      if (!x.closest?.(".node")) break;
      if (x.nodeType !== 1) continue;
      const tag = x.tagName;
      /* 表单控件（提示词 textarea 就是它）：overflow 由浏览器 UA 样式给，
         computed 有时读成 visible，光看 overflow 会把它漏掉。
         这里直接按「内容有没有超出」判，漏判就等于整块滚轮失灵。 */
      if (tag === "TEXTAREA" || tag === "INPUT" || x.isContentEditable) {
        if (x.scrollHeight > x.clientHeight + 1) return x;
        continue;
      }
      const cs = getComputedStyle(x);
      const canY = cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowY === "overlay";
      const canX = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const over = (canY && x.scrollHeight > x.clientHeight + 1)
        || (canX && x.scrollWidth > x.clientWidth + 1);
      if (over) return x;
    }
    return null;
  }

  /** 原生滚完兜底：这一帧里它没滚动，就自己滚一格（滚到边界自动停，不会外溢到画布） */
  _nudgeScroll(sc, e) {
    const before = sc.scrollTop;
    requestAnimationFrame(() => {
      try {
        if (sc.scrollTop !== before) return;          // 浏览器已经滚过了
        const max = sc.scrollHeight - sc.clientHeight;
        if (max <= 0) return;                         // 真的没得滚
        const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? sc.clientHeight : 1;
        sc.scrollTop = Math.max(0, Math.min(max, before + e.deltaY * unit));
      } catch { /* 元素已被重渲染掉，忽略 */ }
    });
  }

  /** 框选：按住空格 + 左键拉一个矩形，碰到的节点全选中 */
  _startMarquee(e) {
    const r = this.stage.getBoundingClientRect();
    const base = e.shiftKey ? new Set(this.selected) : new Set();
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;

    const box = document.createElement("div");
    box.className = "marquee hide";
    this.stage.appendChild(box);
    this.stage.classList.add("marqueeing");

    const apply = (cx, cy) => {
      const w = Math.abs(cx - x0), h = Math.abs(cy - y0);
      if (!moved && (w > 3 || h > 3)) { moved = true; box.classList.remove("hide"); }
      if (!moved) return;
      box.style.left = (Math.min(x0, cx) - r.left) + "px";
      box.style.top = (Math.min(y0, cy) - r.top) + "px";
      box.style.width = w + "px";
      box.style.height = h + "px";

      const l = Math.min(x0, cx), t = Math.min(y0, cy);
      const rr = Math.max(x0, cx), bb = Math.max(y0, cy);
      const sel = new Set(base);
      for (const [id, n] of this.nodes) {
        const b = n.el.getBoundingClientRect();
        if (b.right >= l && b.left <= rr && b.bottom >= t && b.top <= bb) sel.add(id);
      }
      this._setSelection(sel);
    };

    const move = (ev) => apply(ev.clientX, ev.clientY);
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      box.remove();
      this.stage.classList.remove("marqueeing");
      /* 只是点了一下没拖动 → 当成「取消选中」 */
      if (!moved) this._setSelection(base);
      else apply(ev.clientX, ev.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** 右下角拖动改大小；双击回到「按内容自适应」 */
  _watchResize(el, id) {
    const h = el.querySelector(".node-resize");
    if (!h) return;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this._spaceDown) return;
      e.preventDefault();
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
      const k = this.view.k || 1;
      el.classList.add("resizing");
      document.body.style.cursor = "nwse-resize";
      /* 拖动期间禁止选中文字 / 触发节点拖动 */
      const move = (ev) => {
        this.setSize(id,
          start.w + (ev.clientX - start.x) / k,
          start.h + (ev.clientY - start.y) / k);
      };
      const up = () => {
        el.classList.remove("resizing");
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.onChange();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    h.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetSize(id);
    });
  }

  _watchDrag(el, id) {
    const head = el.querySelector(".node-head");
    if (!head) return;
    head.addEventListener("pointerdown", (e) => {
      /* 空格按着 = 框选态，不要移动节点 */
      if (this._spaceDown) return;
      if (e.target.closest("button, input, textarea, select")) return;
      e.stopPropagation();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!this.selected.has(id) || additive) this.select(id, additive);
      const start = { x: e.clientX, y: e.clientY };
      /* 选了多个 → 一起拖（整组跟着鼠标走） */
      const group = this.selected.has(id)
        ? [...this.selected].filter(x => this.nodes.has(x))
        : [id];
      const origins = new Map(group.map(x => [x, { x: this.nodes.get(x).x, y: this.nodes.get(x).y }]));
      const k = this.view.k;
      el.classList.add("dragging");
      el.style.zIndex = 999;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / k, dy = (ev.clientY - start.y) / k;
        for (const [gid, o] of origins) this.setPos(gid, o.x + dx, o.y + dy);
      };
      const up = () => {
        el.classList.remove("dragging");
        el.style.zIndex = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.onChange();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    /* 点节点内容区：切到「只选这个」 */
    el.addEventListener("pointerdown", (e) => {
      if (this._spaceDown) return;
      if (e.target.closest(".node-head")) return;
      if (!this.selected.has(id)) this.select(id);
    });
  }

  /** 编辑控件的键盘事件不要冒泡成画布快捷键 */
  static isTyping(el) {
    return /INPUT|TEXTAREA|SELECT/.test(el?.tagName || "") || el?.isContentEditable;
  }
}
