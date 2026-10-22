/* 最小 CDP 客户端：连一个 page target，提供 ev / 鼠标 / 键盘 / 截图 */
import fs from "node:fs";

export async function openCdp(port = 9335, match = "127.0.0.1:830") {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter(t => t.type === "page" && t.url.includes(match));
  const page = pages[pages.length - 1] || list.find(t => t.type === "page");
  if (!page) throw new Error("没有 page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map();
  let id = 0;
  const events = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) {
      const { res, rej } = pend.get(d.id); pend.delete(d.id);
      if (d.error) rej(new Error(JSON.stringify(d.error))); else res(d.result);
    } else if (d.method) {
      for (const h of events) if (h.method === d.method) h.fn(d.params);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error("超时 " + method)); } }, 120000);
  });
  const on = (method, fn) => events.push({ method, fn });

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS 出错: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expr, timeout = 15000, label = "") => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await ev(`!!(${expr})`)) return true; } catch { }
      await sleep(120);
    }
    throw new Error("等待超时" + (label ? "：" + label : "") + " ← " + expr);
  };
  const rectIn = (sel, sub) => ev(`(()=>{const a=document.querySelector(${JSON.stringify(sel)});
    if(!a) return null; const e=${sub ? `a.querySelector(${JSON.stringify(sub)})` : "a"};
    if(!e) return null; const r=e.getBoundingClientRect();
    if(r.width<2||r.height<2) return null; return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
  const scrollInto = (sel) => ev(`(()=>{const e=${JSON.stringify(sel)};const n=document.querySelector(e);
    if(!n) return false; n.scrollIntoView({block:"center"}); return true;})()`);
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", {
    type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, ...extra
  });
  const moveTo = async (p, steps = 20) => {
    const cur = await ev("[window.__mx||0,window.__my||0]");
    for (let i = 1; i <= steps; i++) {
      const x = cur[0] + (p.cx - cur[0]) * i / steps;
      const y = cur[1] + (p.cy - cur[1]) * i / steps;
      await mouse("mouseMoved", x, y, { button: "none" });
      await sleep(12);
    }
    await ev(`[window.__mx=${p.cx},window.__my=${p.cy}]`);
  };
  const clickAt = async (p) => {
    await mouse("mousePressed", p.cx, p.cy);
    await sleep(40);
    await mouse("mouseReleased", p.cx, p.cy);
  };
  const wheelAt = async (p, dy, ctrl = false) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: Math.round(p.cx), y: Math.round(p.cy),
      deltaX: 0, deltaY: dy, modifiers: ctrl ? 2 : 0
    });
  };
  const dragTo = async (from, to, ms = 600) => {
    await mouse("mouseMoved", from.cx, from.cy, { button: "none" });
    await sleep(60);
    await mouse("mousePressed", from.cx, from.cy);
    const n = Math.max(8, Math.round(ms / 40));
    for (let i = 1; i <= n; i++) {
      await mouse("mouseMoved", from.cx + (to.cx - from.cx) * i / n, from.cy + (to.cy - from.cy) * i / n);
      await sleep(ms / n);
    }
    await sleep(120);
    await mouse("mouseReleased", to.cx, to.cy);
  };
  const key = async (k, code, vk, mod = 0) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mod });
    await sleep(30);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mod });
  };
  const typeText = async (s) => {
    for (const ch of s) await send("Input.insertText", { text: ch });
  };
  const shot = async (file, quality = 80) => {
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality, fromSurface: true });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  };
  const targetId = page.id;
  const activate = async () => {
    try { await send("Target.activateTarget", { targetId }); } catch { }
  };
  /** 把别的页面（下载气泡之类）都关掉：后台页会被节流，输入派发会卡住 */
  const closeOthers = async () => {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const t of l) {
        if (t.type === "page" && t.id !== targetId) {
          try { await send("Target.closeTarget", { targetId: t.id }); } catch { }
        }
      }
    } catch { }
  };
  return { send, on, ev, sleep, waitFor, rectIn, scrollInto, mouse, moveTo, clickAt, wheelAt, dragTo, key, typeText, shot, targetId, activate, closeOthers, close: () => ws.close() };
}
