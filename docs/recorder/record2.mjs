/* ==================================================================
   录制《无限画布 · 完整功能演示》（正式版 v2）
   真页面 + 真鼠标键盘（CDP）+ 真本机推理
   DRY=1 → 只走流程不抓帧
================================================================== */
import { openCdp } from "./cdp.mjs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const DRY = !!process.env.DRY;
const W = 1440, H = 900;
const FR = "F:/xy-wxhb/.tmp-video/frames-" + Date.now();
const OUT = "F:/xy-wxhb/docs/xy-wxhb-full-demo.mp4";
const PORT = 8302, CDP = 9335;

if (!DRY) { fs.mkdirSync(FR, { recursive: true }); }

const c = await openCdp(CDP, "127.0.0.1:830");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await c.activate();
await c.closeOthers();
await c.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: "F:/xy-wxhb/.tmp-video/dl" });
await c.send("Target.setDiscoverTargets", { discover: true });
c.on("Target.targetCreated", async (p) => {
  if (p?.targetInfo?.url?.startsWith("edge://downloads")) {
    await c.sleep(500);
    try { await c.send("Target.closeTarget", { targetId: p.targetInfo.targetId }); } catch { }
  }
});

/* ---------------- 字幕 / 卡片 ---------------- */
const UI = () => c.ev(`(()=>{
  if (document.getElementById('demoui')) return;
  const s = document.createElement('style'); s.id='democss';
  s.textContent = \`
  #democap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(14px);
    z-index:99999;min-width:560px;max-width:1100px;padding:15px 30px 17px;opacity:0;
    transition:opacity .3s ease,transform .3s ease;pointer-events:none;
    background:rgba(9,11,15,.93);border:1px solid rgba(120,180,255,.32);border-radius:14px;
    box-shadow:0 18px 50px rgba(0,0,0,.6);backdrop-filter:blur(10px);font-family:inherit}
  #democap.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #democap .ch{display:inline-block;font-size:12px;letter-spacing:.12em;color:#7fd1ff;
    border:1px solid rgba(127,209,255,.45);border-radius:999px;padding:2px 9px;margin-bottom:8px}
  #democap .t{font-size:22px;line-height:1.35;color:#f3f7ff;font-weight:600}
  #democap .s{font-size:14.5px;line-height:1.5;color:#a9b6c9;margin-top:6px}
  #democap .bar{position:absolute;left:0;top:0;height:2px;width:100%;border-radius:14px 14px 0 0;
    background:linear-gradient(90deg,#4ea1ff,#7ff0d0)}
  #democard{position:fixed;inset:0;z-index:999999;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px;opacity:0;transition:opacity .5s ease;
    background:radial-gradient(circle at 50% 42%,#111a29 0%,#070a0e 66%,#04060a 100%);pointer-events:none}
  #democard.on{opacity:1}
  #democard .big{font-size:62px;font-weight:700;color:#fff;letter-spacing:.06em;
    text-shadow:0 0 46px rgba(78,161,255,.55)}
  #democard .sub{font-size:19px;color:#9fb6d6;letter-spacing:.04em}
  #democard .line{width:120px;height:3px;border-radius:2px;background:linear-gradient(90deg,#4ea1ff,#7ff0d0)}
  \`;
  document.head.appendChild(s);
  const cap = document.createElement('div'); cap.id='democap';
  cap.innerHTML = '<div class="bar"></div><span class="ch"></span><div class="t"></div><div class="s"></div>';
  document.body.appendChild(cap);
  const card = document.createElement('div'); card.id='democard';
  card.innerHTML = '<div class="big"></div><div class="line"></div><div class="sub"></div>';
  document.body.appendChild(card);
  window.__D = {
    cap(ch,t,s){const e=document.getElementById('democap');e.querySelector('.ch').textContent=ch||'';
      e.querySelector('.t').textContent=t||'';e.querySelector('.s').textContent=s||'';
      e.classList.add('on');},
    capOff(){document.getElementById('democap').classList.remove('on');},
    card(big,sub){const e=document.getElementById('democard');e.querySelector('.big').textContent=big;
      e.querySelector('.sub').textContent=sub||'';e.classList.add('on');},
    cardOff(){document.getElementById('democard').classList.remove('on');},
    /* 把若干节点框进画面：按真实屏幕矩形校正，侧栏和底部字幕都不会挡住 */
    frame(ids, pad, maxK, ms){
      const v=__xy.view, st=v.stage.getBoundingClientRect();
      const from={...v.view};
      const box=(id)=>{const e=document.querySelector('.node[data-id="'+id+'"]'); const m=v.nodes.get(id);
        return {x:m.x, y:m.y, w:e.offsetWidth, h:e.offsetHeight};};
      const rs=ids.map(box);
      let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
      for(const r of rs){x1=Math.min(x1,r.x);y1=Math.min(y1,r.y);x2=Math.max(x2,r.x+r.w);y2=Math.max(y2,r.y+r.h);}
      const w=Math.max(60,x2-x1), h=Math.max(60,y2-y1);
      const padB=118;
      const k=Math.min(maxK||1, (st.width-pad*2)/w, (st.height-padB-pad)/h);
      v.view={k, x:from.x, y:from.y}; v.apply();
      const rc=ids.map(id=>document.querySelector('.node[data-id="'+id+'"]').getBoundingClientRect());
      const bx=Math.min(...rc.map(r=>r.left)), by=Math.min(...rc.map(r=>r.top));
      const bx2=Math.max(...rc.map(r=>r.right)), by2=Math.max(...rc.map(r=>r.bottom));
      const tx=st.left+st.width/2, ty=st.top+(st.height-padB)/2;
      const to={k, x: from.x + (tx-(bx+bx2)/2), y: from.y + (ty-(by+by2)/2)};
      v.view={...from}; v.apply();
      const ms2=ms||600;
      return new Promise(r=>{const t0=performance.now();
        const step=()=>{const p=Math.min(1,(performance.now()-t0)/ms2); const e=1-Math.pow(1-p,3);
          v.view={k:from.k+(to.k-from.k)*e, x:from.x+(to.x-from.x)*e, y:from.y+(to.y-from.y)*e};
          v.apply(); if(p<1) requestAnimationFrame(step); else r(1);};
        requestAnimationFrame(step);});
    },
    pan(dx,dy,ms){const v=__xy.view, from={...v.view};
      return new Promise(r=>{const t0=performance.now();
        const step=()=>{const p=Math.min(1,(performance.now()-t0)/ms); const e=1-Math.pow(1-p,3);
          v.view={k:from.k, x:from.x+dx*e, y:from.y+dy*e}; v.apply();
          if(p<1) requestAnimationFrame(step); else r(1);};
        requestAnimationFrame(step);});},
    nodeScroll(id,top,ms){const b=document.querySelector('.node[data-id="'+id+'"] .node-body');
      if(!b) return 0; b.scrollTo({top,behavior:ms?'smooth':'auto'}); return 1;},
    boxCenter(sel){const e=document.querySelector(sel); if(!e) return null;
      const r=e.getBoundingClientRect(); return {cx:r.x+r.width/2, cy:r.y+r.height/2};}
  };
  const m=document.createElement('div'); m.id='demoui'; m.style.display='none';
  document.body.appendChild(m);
  return true;})()`);

const marks = [];
const cap = async (ch, t, s) => { await UI();
  marks.push({ t: +vts.toFixed(2), ch });
  await c.ev(`__D.cap(${JSON.stringify(ch)},${JSON.stringify(t)},${JSON.stringify(s || "")})`); };
const capOff = async () => c.ev("__D.capOff()");
const card = async (big, sub) => { await UI(); await c.ev(`__D.card(${JSON.stringify(big)},${JSON.stringify(sub || "")})`); };

const frame = async (ids, pad = 60, maxK = 1, ms = 620) => { await UI(); await c.ev(`__D.frame(${JSON.stringify(ids)},${pad},${maxK},${ms})`); await c.sleep(ms * 0.35); };
const nodeCenter = (id) => c.ev(`__D.boxCenter('.node[data-id="${id}"]')`);

/** 直接落到世界坐标（不拖，构图稳定） */
async function putNode(id, x, y) {
  const got = await c.ev(`(()=>{const n=__xy.S.nodes.find(v=>v.id==='${id}'); if(!n) return 0;
    n.x=${x}; n.y=${y};
    const el=document.querySelector('.node[data-id="'+n.id+'"]');
    if(el) el.style.transform='translate3d(${x}px,${y}px,0)';
    try{ __xy.renderNode(n); }catch(e){}
    return 1;})()`);
  if(!got) throw new Error('putNode 找不到 ' + id);
  await c.sleep(280);
}

/** 把某一格挪到画面中间 */
async function focusEl(sel, tx = 745, ty = 400, ms = 560) {
  await UI();
  await c.ev(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); if(!f) return 0;
    const b=f.closest('.node-body'); if(b){const r=f.getBoundingClientRect(), rb=b.getBoundingClientRect();
      b.scrollTop += (r.top-rb.top) - b.clientHeight*0.26;} return 1;})()`);
  await c.sleep(240);
  const r = await c.rectIn(sel);
  if (!r) throw new Error("focusEl 找不到 " + sel);
  await c.ev(`__D.pan(${(tx - r.cx).toFixed(1)},${(ty - r.cy).toFixed(1)},${ms})`);
  await c.sleep(ms + 160);
}

/** 点某一格：被盖住就挪一下再试 */
async function focusAndClick(sel, sub, tx = 760, ty = 380) {
  for (let i = 0; i < 7; i++) {
    await focusEl(sel, tx, ty, 480);
    let r = await c.rectIn(sel, sub);
    for (let s = 0; s < 6 && r; s++) {
      await c.sleep(130);
      const r2 = await c.rectIn(sel, sub);
      if (r2 && Math.abs(r2.cx - r.cx) < 2 && Math.abs(r2.cy - r.cy) < 2) { r = r2; break; }
      r = r2;
    }
    if (r) {
      const hit = await c.ev(`(()=>{const e=document.elementFromPoint(${Math.round(r.cx)},${Math.round(r.cy)});
        if(!e) return 'none'; return e.closest(${JSON.stringify(sel)}) ? 'ok' : 'blocked:'+e.tagName;})()`);
      if (hit === "ok") return r;
      log("  被挡住(" + hit + ")，挪一下");
      await c.ev(`__D.pan(${i % 2 ? 260 : -260},${i < 2 ? -110 : 110},300)`);
      await c.sleep(400);
    } else { await c.ev(`__D.pan(0,-120,300)`); await c.sleep(400); }
  }
  throw new Error("点不到：" + sel);
}

/** 给按钮临时打标：先清掉上一次的标，避免 querySelector("#demobtn") 命中旧按钮 */
async function tagBtn(expr) {
  return c.ev(`(()=>{document.querySelectorAll("#demobtn").forEach(e=>e.removeAttribute("id"));
    const b=${expr}; if(!b) return false; b.id="demobtn"; return true;})()`);
}

/** 点一下按钮并等对应 toast；点空了自动重试 */
async function clickToast(expr, reSrc, label, tries = 3, tx = 700, ty = 380) {
  for (let i = 1; i <= tries; i++) {
    if (!await tagBtn(expr)) throw new Error("没找到按钮：" + label);
    const r = await focusAndClick("#demobtn", null, tx, ty);
    await c.moveTo(r, 14);
    await c.sleep(320);
    await c.clickAt(r);
    for (let t = 0; t < 26; t++) {
      await c.sleep(300);
      if (await c.ev(`[...document.querySelectorAll("#toast-wrap .toast")].some(e=>${reSrc}.test(e.textContent))`)) return true;
    }
    log(`  ${label} 第 ${i} 次没反应，重点一次`);
  }
  throw new Error("等不到 toast：" + label);
}

/* ---------------- 抓帧 ---------------- */
let capturing = false, frames = [], vts = 0, speed = 1, capMs = 88, lastT = 0, fi = 0;
async function loop() {
  while (capturing) {
    const a = Date.now();
    try { await c.shot(`${FR}/f${String(fi).padStart(5, "0")}.jpg`, 84); } catch { }
    const b = Date.now();
    if (lastT) vts += (b - lastT) / 1000 / speed;
    lastT = b;
    frames.push({ i: fi, ts: vts }); fi++;
    const rest = capMs - (Date.now() - a);
    if (rest > 0) await c.sleep(rest);
  }
}
const startRec = async () => { if (DRY) return; lastT = Date.now(); vts = 0; capturing = true; loop(); };
const stopRec = async () => { capturing = false; await c.sleep(350); };

/* ---------------- 小工具 ---------------- */
const sel = (s) => c.rectIn(s);
const clickSel = async (s) => {
  const r = await c.rectIn(s);
  if (!r) throw new Error("找不到元素：" + s);
  await c.moveTo(r, 14); await c.sleep(60); await c.clickAt(r); await c.sleep(130);
  return r;
};
const byText = (css, re) => c.ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(css)})]
  .find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent.trim()));
  if(!e) return null; const r=e.getBoundingClientRect();
  if(r.width<2||r.height<2) return null; return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
const clickText = async (css, re) => {
  const r = await byText(css, re);
  if (!r) throw new Error("找不到：[" + css + "] /" + re + "/");
  await c.moveTo(r, 14); await c.sleep(70); await c.clickAt(r); await c.sleep(170);
  return r;
};
const clearInput = async (s) => {
  await clickSel(s);
  await c.key("a", "KeyA", 65, 2); await c.sleep(80);
  await c.key("Backspace", "Backspace", 8); await c.sleep(180);
};
const typeSel = async (s, text, per = 45) => {
  await clearInput(s);
  for (const ch of text) { await c.send("Input.insertText", { text: ch }); await c.sleep(per); }
};

/* 构图：文本 → 生图 → 图片 → 图生视频，一字排开 */
const P_TEXT = { x: -560, y: 150 }, P_WF = { x: -240, y: 0 };
const P_IMG = { x: 200, y: 70 }, P_VID = { x: 560, y: -30 };

/* ---------------- 0. 起手 ---------------- */
await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await c.waitFor("window.__xy && __xy.S && __xy.S.workflows!==undefined", 30000, "页面就绪");
await c.ev(`localStorage.clear();
  localStorage.setItem("xy-wxhb.base","http://127.0.0.1:8199");
  localStorage.setItem("xy-wxhb.libkind","output");`);
await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?d=${Date.now()}` });
await c.sleep(2200);
await c.waitFor("window.__xy && __xy.S && __xy.S.workflows!==undefined", 30000, "页面就绪2");
log("连接状态:", await c.ev("document.querySelector('#conn-state').textContent"));
await c.ev(`(()=>{const e=document.querySelector('#conn-state'); e.className='conn off'; e.textContent='未连接';})()`);

await UI();
await card("本地无限画布", "xy-wxhb · ComfyUI 的前端画布");
await startRec();
await c.sleep(4200);
await c.ev("__D.cardOff()");
await c.sleep(600);

/* ================= ① 连接 ComfyUI ================= */
log("① 连接");
await cap("① 先有 ComfyUI，再有画布", "画布不加载模型、不占显存 —— 它只是你自己 ComfyUI 的前端");
await c.sleep(3000);
const urlBox = await sel("#comfy-url");
await c.moveTo(urlBox, 16); await c.sleep(300);
await clickSel("#btn-connect");
await c.waitFor(`/失败/.test(document.querySelector('#conn-state').textContent)`, 12000, "连接失败");
log("  失败态 OK");
await c.sleep(1700);
await cap("地址填你自己 ComfyUI 的", "默认 127.0.0.1:8188，改过端口就填你的");
await c.sleep(1400);
await typeSel("#comfy-url", "http://127.0.0.1:8188", 28);
await c.sleep(300);
await clickSel("#btn-connect");
await c.waitFor(`/已连接/.test(document.querySelector('#conn-state').textContent)`, 30000, "连上");
await c.sleep(800);
log("  已连接:", await c.ev("document.querySelector('#gpu-info').textContent"));
await cap("连接状态 + 显卡 + 显存", "都是现场从本机 ComfyUI 读回来的，不是画布自己编的");
await c.sleep(2700);

/* ================= ② 工作流库 ================= */
log("② 工作流库");
await cap("② 左栏 · 工作流库", "直接扫 ComfyUI 的 workflows 目录，30 个都在，不用导出再导入");
await c.sleep(2700);
const list = await sel("#wf-list");
await c.moveTo(list, 10);
await c.wheelAt(list, 280); await c.sleep(800);
await c.wheelAt(list, -280); await c.sleep(700);
await cap("搜一下，或者按类型筛", "生图 / 视频的标签是按工作流内容自动判的");
await typeSel("#wf-search", "qwen", 55);
await c.sleep(1500);
await clearInput("#wf-search");
await c.sleep(500);
await clickText("#wf-filter .chip", "^视频$");
await c.sleep(1700);
await clickText("#wf-filter .chip", "^全部$");
await c.sleep(800);
const rr = await sel("#btn-refresh-wf");
await c.moveTo(rr, 12); await c.sleep(500);
await cap("ComfyUI 里新存的，点 ⟳ 就在", "列表和 ComfyUI 的 workflows 目录是同一份文件");
await c.sleep(2400);

/* ================= ③ 素材库 ================= */
log("③ 素材库");
await clickText(".side-tab", "素材库");
await c.sleep(1600);
await cap("③ 素材库：素材只有两个来源", "ComfyUI 的 input 素材、output 结果 —— 画布不另存一份");
await c.sleep(2600);
const sub0 = await byText("#lib-projects .lib-chip", "成品库");
if (sub0) { await c.moveTo(sub0, 12); await c.sleep(300); await c.clickAt(sub0); await c.sleep(1400); }
await cap("子库 = 目录下的文件夹", "上传 ⤴ 写进 input，新建子库 ＋ 就是建一个文件夹");
await c.sleep(2500);
await clickText("#lib-kinds .chip", "input");
await c.sleep(1200);
await clickText("#lib-projects .lib-chip", "minimax_h3_unified");
await c.sleep(1600);
await cap("input 里放的是要喂进去的素材", "缩略图点开就是原图 —— 和 ComfyUI 看到的是同一个文件");
await c.sleep(2600);
await clickText("#lib-kinds .chip", "output");
await c.sleep(900);
const subKeep = await byText("#lib-projects .lib-chip", "成品库");
if (subKeep) { await c.moveTo(subKeep, 12); await c.sleep(250); await c.clickAt(subKeep); await c.sleep(1200); }

/* ================= ④ 顶栏 ================= */
log("④ 顶栏");
await cap("④ 顶栏右边这一排", "适配 / 日间 / 背景 / 导出 / 导入 / 清空");
await c.sleep(2400);
await clickSel("#btn-day"); await c.sleep(1600);
await cap("日间 / 夜间两套配色", "画布底色跟着换，长时间看片子眼睛舒服点");
await c.sleep(1800);
await clickSel("#btn-day"); await c.sleep(900);
await clickSel("#btn-export"); await c.sleep(1300);
await cap("导出的是「画布布局」", "一份本地 json：节点摆在哪、连了谁。模型和素材始终在 ComfyUI 那边");
await c.sleep(2800);

/* ================= ⑤ 工作流节点 ================= */
log("⑤ 工作流节点");
await clickText(".side-tab", "工作流");
await c.sleep(900);
await cap("⑤ 点一个工作流 → 节点落到画布上", "这个节点等于把那份工作流摊开，摆到画布上");
await typeSel("#wf-search", "演示-文生图", 40);
await c.sleep(900);
const itemRect = await c.ev(`(()=>{const n=[...document.querySelectorAll('.wf-item')][0];
  if(!n) return null; const r=n.getBoundingClientRect(); return {cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
await c.moveTo(itemRect, 14); await c.sleep(160); await c.clickAt(itemRect);
await c.waitFor("__xy.S.nodes.filter(n=>n.kind==='workflow').length===1", 25000, "工作流节点");
await c.sleep(900);
const wfId = await c.ev("__xy.S.nodes.find(n=>n.kind==='workflow').id");
await clearInput("#wf-search");
await c.sleep(400);
await putNode(wfId, P_WF.x, P_WF.y);
await frame([wfId], 70, 0.6, 800);
await c.sleep(400);
log("  k=", await c.ev("__xy.view.view.k"));
await cap("左边输入口，右边输出口", "端口是从 ComfyUI 的节点定义里认出来的，不是画布手写的表单");
await c.sleep(2900);
await frame([wfId], 40, 0.95, 700);
await c.ev(`__D.nodeScroll('${wfId}',0,0)`);
await c.sleep(500);
await cap("素材槽 / 参数 / LoRA / 模型 分四段", "提示词口、画幅、步数、CFG、模型下拉，都是这份工作流里真实存在的格子");
await c.sleep(2900);
await c.ev(`__D.nodeScroll('${wfId}',540,700)`);
await c.sleep(1600);
const det1 = await byText(`.node[data-id="${wfId}"] details summary`, "更多参数");
if (det1) { await c.moveTo(det1, 12); await c.sleep(250); await c.clickAt(det1); await c.sleep(900); }
await cap("每一格都对着文件里的一个字段", "节点头上的 ⟳ 是「和磁盘再同步一次」");
await c.sleep(2400);
await c.ev(`__D.nodeScroll('${wfId}',0,700)`);
await c.sleep(800);

/* ================= ⑥ 文本节点 → 提示词口 ================= */
log("⑥ 文本节点");
await cap("⑥ 新建一个文本素材节点", "文 / 图 / 视 / 音 四种输入，就是往画布上摆一个「源」");
await c.sleep(2400);
await clickSel('.add-btn[data-inkind="text"]');
await c.sleep(1000);
const txtId = await c.ev("__xy.S.nodes.filter(n=>n.kind!=='workflow').slice(-1)[0].id");
await putNode(txtId, P_TEXT.x, P_TEXT.y);
await frame([txtId], 60, 1, 600);
await c.sleep(300);
await cap("写这一句要生成什么", "这个框就是提示词，不用点保存");
await c.sleep(2000);
const ta = await c.rectIn(`.node[data-id="${txtId}"]`, "textarea.in-text");
await c.moveTo(ta, 10); await c.sleep(150); await c.clickAt(ta); await c.sleep(250);
const PROMPT = process.env.PROMPT
  || "a brass pocket watch on a dark walnut desk, soft window light, shallow depth of field";
for (const ch of PROMPT) { await c.send("Input.insertText", { text: ch }); await c.sleep(11); }
await c.sleep(900);
await cap("把线从文本节点，拖到工作流的提示词口", "这条线的意思：这段提示词，喂给这个工作流");
await frame([txtId, wfId], 60, 0.72, 700);
await c.sleep(500);
const outP = await c.rectIn(`.node[data-id="${txtId}"]`, '.port[data-kind="out"]');
const inP = await c.rectIn(`.node[data-id="${wfId}"]`, '.port[data-kind="in"][data-itype="text"][data-port$="43|prompt"]');
if (!outP || !inP) throw new Error("端口不可见 out=" + !!outP + " in=" + !!inP);
await c.dragTo(outP, inP, 820);
await c.sleep(900);
log("  连线数:", await c.ev("__xy.S.edges.length"));
await cap("接上了：端口按类型亮", "文本只能接文本口，图只能接图口，接错会直接告诉你");
await c.sleep(2400);

/* ================= ⑦ 图像节点 + 真跑一次 ================= */
log("⑦ 出图");
await cap("⑦ 再接一个图像节点，接住产出", "拖工作流右边那个圆点，落到图像节点的左边缘");
await c.sleep(2400);
await clickSel('.add-btn[data-inkind="image"]');
await c.sleep(900);
const imgId = await c.ev("__xy.S.nodes.filter(n=>n.kind!=='workflow').slice(-1)[0].id");
await putNode(imgId, P_IMG.x, P_IMG.y);
await frame([txtId, wfId, imgId], 60, 0.78, 700);
await c.sleep(500);
const outP2 = await c.rectIn(`.node[data-id="${wfId}"]`, '.port[data-kind="out"]');
const edgeP = await c.rectIn(`.node[data-id="${imgId}"]`, ".port.in-edge");
if (!outP2 || !edgeP) throw new Error("产出端口不可见 " + !!outP2 + "/" + !!edgeP);
await c.dragTo(outP2, edgeP, 850);
await c.sleep(1000);
log("  产出线:", await c.ev("__xy.S.edges.filter(e=>e.key==null).length"));
await cap("跑完的图，会直接落在这个节点里", "下面就开跑 —— 真的在本机 GPU 上跑，不是剪一段假动画");
await c.sleep(2600);

const runBtn = await c.rectIn(`.node[data-id="${wfId}"]`, ".nbtn.run");
await c.moveTo(runBtn, 12); await c.sleep(250);
const tRun = Date.now();
await c.clickAt(runBtn);
await c.waitFor(`document.querySelector('.node[data-id="${wfId}"] .nbtn.run').classList.contains('stop')`, 12000, "进入运行态");
log("  开跑");
await c.moveTo({ cx: 760, cy: 828 }, 12);
speed = 9; capMs = 360;
await cap("正在本机推理…（这段 9× 加速）", "采样、显存、模型全在 ComfyUI 那边，画布只负责发这一单");
await c.waitFor(`__xy.S.nodes.find(n=>n.id==='${wfId}').status==='done'`, 420000, "出图完成");
const dur = ((Date.now() - tRun) / 1000).toFixed(0);
log("  完成，用时", dur, "s");
speed = 1; capMs = 88;
await c.sleep(800);
await frame([txtId, wfId, imgId], 60, 0.78, 700);
await c.sleep(500);
await cap(`跑完了：${dur} 秒（本机真实耗时）`, "图直接出现在画布上的图像节点里，不用去 ComfyUI 的 output 里翻");
await c.sleep(3000);

/* ================= ⑧ 图片接视频 ================= */
log("⑧ 接视频");
await clickText(".side-tab", "工作流");
await c.sleep(700);
await cap("⑧ 同一张图，接进「图生视频」", "视频这类工作流，输入口里就有「参考图」");
await typeSel("#wf-search", "演示-图生视频", 40);
await c.sleep(1000);
const item2 = await c.ev(`(()=>{const n=[...document.querySelectorAll('.wf-item')][0];
  if(!n) return null; const r=n.getBoundingClientRect(); return {cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
await c.moveTo(item2, 12); await c.sleep(180); await c.clickAt(item2);
await c.waitFor("__xy.S.nodes.filter(n=>n.kind==='workflow').length===2", 30000, "视频工作流");
await c.sleep(1000);
const vidId = await c.ev("__xy.S.nodes.filter(n=>n.kind==='workflow').slice(-1)[0].id");
await clearInput("#wf-search");
await c.sleep(400);
await putNode(vidId, P_VID.x, P_VID.y);
await frame([imgId, vidId], 60, 0.8, 700);
await c.sleep(600);
const imgOut = await c.rectIn(`.node[data-id="${imgId}"]`, '.port[data-kind="out"]');
const vIn = await c.rectIn(`.node[data-id="${vidId}"]`, '.port[data-kind="in"][data-itype="image"]');
log("  imgOut/vIn:", !!imgOut, !!vIn);
if (!imgOut || !vIn) throw new Error("视频参考图口不可见");
await c.dragTo(imgOut, vIn, 900);
await c.sleep(1000);
await cap("图 → 视频 → 再接一个视频节点，就是一条链", "每一环的产出都留在画布上，随时能回头改中间那一步");
await c.sleep(2400);
await frame([txtId, wfId, imgId, vidId], 50, 0.62, 800);
await c.sleep(1600);

/* ================= ⑨ 双向同步 ================= */
log("⑨ 双向同步");
await cap("⑨ 先在画布上改一格：步数 8 → 20", "停手别按回车，看它自己写回去");
await c.sleep(1800);
await frame([wfId], 40, 0.9, 600);
const stepsIn = await focusAndClick(`.node[data-id="${wfId}"] .field[data-key$="|steps"]`, 'input[type="number"]', 760, 370);
await c.moveTo(stepsIn, 10); await c.sleep(150); await c.clickAt(stepsIn); await c.sleep(300);
log("  焦点:", await c.ev("document.activeElement.tagName+'/'+document.activeElement.type"));
await c.key("a", "KeyA", 65, 2); await c.sleep(100);
for (const ch of "20") { await c.send("Input.insertText", { text: ch }); await c.sleep(110); }
await c.waitFor(`[...document.querySelectorAll('#toast-wrap .toast')].some(e=>/已写回/.test(e.textContent))`, 12000, "已写回");
log("  已写回 toast OK");
await c.sleep(1200);
await cap("停手 3 秒：值写进工作流文件本身", "写回的是 ComfyUI 的 workflows 文件 —— 那边打开就是 20");
await c.sleep(2600);
const fval = await readWfSteps("演示-文生图.json");
log("  文件里 steps =", fval);
await cap(`磁盘上那份文件，现在真的是 steps = ${fval}`, "不是画布自己记着，是真改了文件");
await c.sleep(2500);

/* 反方向：ComfyUI 那边改完保存 → 点 ⟳ 读回来 */
const headRect2 = await c.rectIn(`.node[data-id="${wfId}"] .node-head`);
await c.moveTo(headRect2, 12); await c.sleep(200); await c.clickAt(headRect2);
await c.sleep(1700);
log("  焦点:", await c.ev("document.activeElement.tagName"), "文件基线:", await readWfSteps("演示-文生图.json"));
for (let i = 0; i < 3; i++) {
  await patchWfExternally("演示-文生图.json", 26);
  await c.sleep(600);
  const v = await readWfSteps("演示-文生图.json");
  log("  外部改成 26 →", v);
  if (String(v) === "26") break;
  await c.sleep(800);
}
await frame([wfId], 40, 0.62, 600);
await cap("反向：ComfyUI 那边改成 26 并保存", "画布不用刷新，点节点头上的 ⟳ 把文件读回来");
await c.sleep(2300);
await clickToast(`document.querySelector('.node[data-id="${wfId}"] .nbtn.sync')`,
  "/已同步 ComfyUI/", "已同步", 3, 700, 300);
log("  已同步 toast OK");
await c.sleep(1400);
await focusEl(`.node[data-id="${wfId}"] .field[data-key$="|steps"]`, 760, 390, 600);
await c.sleep(600);
const nowSteps = await c.ev(`(()=>{const i=document.querySelector('.node[data-id="${wfId}"] .field[data-key$="|steps"] input[type="number"]'); return i? i.value : '?';})()`);
log("  同步后输入框:", nowSteps);
await cap("26 回来了（文件里就是 26）", "同一格两边都能改：谁后改算谁的，不互相盖掉");
await c.sleep(2900);

/* ================= ⑩ 存产出 ================= */
log("⑩ 存产出");
await frame([imgId], 60, 0.85, 650);
await c.ev(`__D.nodeScroll('${imgId}',0,0)`);
await c.sleep(500);
await cap("⑩ 产出存下来", "节点上那颗 ⭐ 存到成品库");
await c.sleep(2000);
await clickToast(`[...document.querySelectorAll('.node[data-id="${imgId}"] button')].find(x=>/成品库/.test(x.textContent))`,
  "/已存到成品库/", "存成品库", 2, 700, 380);
log("  已存 toast OK");
await c.sleep(1300);
await cap("文件进了 output/成品库", "源文件不动，另存一份；画布记住「这张已经存过」");
await c.sleep(2300);
await clickText(".side-tab", "素材库");
await c.sleep(1500);
const kept = await byText("#lib-projects .lib-chip", "成品库");
if (kept) { await c.moveTo(kept, 12); await c.sleep(250); await c.clickAt(kept); await c.sleep(1600); }
await cap("素材库只是这些目录的索引", "文件始终在你自己的硬盘上，画布不藏东西");
await c.sleep(2800);

/* ================= 收尾 ================= */
log("收尾");
await capOff();
await c.sleep(700);
await card("全部本地", "模型 · 显存 · 素材 · 产出 · 推理 —— 都在你自己的 ComfyUI 里");
await c.sleep(4400);
await c.ev("__D.cardOff()");
await c.sleep(700);
await stopRec();

/* ================= 编码 ================= */
log("抓帧", frames.length, "张；片长", frames.length ? frames[frames.length - 1].ts.toFixed(1) + "s" : "-");
if (!DRY) fs.writeFileSync("F:/xy-wxhb/.tmp-video/marks.json", JSON.stringify({
  total: frames.length ? +frames[frames.length - 1].ts.toFixed(2) : 0, marks }, null, 1));
marks.forEach(m => log(`  ${String(Math.floor(m.t / 60)).padStart(2, "0")}:${m.t % 60 < 10 ? "0" : ""}${(m.t % 60).toFixed(1)}  ${m.ch}`));
if (!DRY && frames.length) {
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], next = frames[i + 1];
    lines.push(`file '${FR}/f${String(f.i).padStart(5, "0")}.jpg'`);
    lines.push(`duration ${(next ? Math.max(0.008, next.ts - f.ts) : 0.04).toFixed(4)}`);
  }
  lines.push(`file '${FR}/f${String(frames[frames.length - 1].i).padStart(5, "0")}.jpg'`);
  fs.writeFileSync("F:/xy-wxhb/.tmp-video/list.txt", lines.join("\n"), "utf8");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", "F:/xy-wxhb/.tmp-video/list.txt",
    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-movflags", "+faststart", OUT], { stdio: "inherit" });
  log("成片:", OUT);
}
c.close();

/* ---------------- 与 ComfyUI 文件来往 ---------------- */
async function readWfSteps(name) {
  const r = await fetch("http://127.0.0.1:8188/api/userdata/" + encodeURIComponent("workflows/" + name) + "?_=" + Date.now());
  const wf = await r.json();
  return wf.nodes.find(x => String(x.id) === "6")?.widgets_values?.[2];
}
async function patchWfExternally(name, steps) {
  const url = "http://127.0.0.1:8188/api/userdata/" + encodeURIComponent("workflows/" + name);
  const wf = await (await fetch(url + "?_=" + Date.now())).json();
  for (const n of wf.nodes) {
    if (String(n.id) === "6") {
      if (Array.isArray(n.widgets_values)) n.widgets_values[2] = steps;
      if (n.widgets_values_named) n.widgets_values_named.steps = steps;
    }
  }
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(wf) });
  return r.status;
}
