"""
serve.py —— 本地无限画布的静态服务器 + 素材库 API

为什么用 Python 而不是直接 python -m http.server：
  1. 服务真正就绪后才打开浏览器（避免 ERR_CONNECTION_REFUSED）；
  2. 端口被占用时给中文提示并直接打开已有服务；
  3. start.bat 可以保持纯 ASCII，绕开 cmd 按 GBK 解析 UTF-8 中文导致的命令被切碎问题。

素材库为什么要后端：
  ComfyUI 官方 HTTP 接口只提供 /view（按文件名取文件），没有「列目录」和「删文件」。
  所以这里直接读本机 ComfyUI 的 input / output 目录，提供：
    GET    /api/lib/root                   探测到的 ComfyUI 根目录
    POST   /api/lib/root   {root}          手动指定根目录（写进 comfy-root.txt）
    GET    /api/lib/projects?kind=input    按一级子目录分「项目」
    GET    /api/lib/items?kind=input&project=xxx
    POST   /api/lib/project {kind,name}    新建子库（一级目录）
    POST   /api/lib/rename {kind,sub,name,to}  改文件名（扩展名不动）
    DELETE /api/lib/file?kind=&sub=&name=  删文件
    POST   /api/lib/delete {kind,items:[{sub,name}]}   批量删文件
    DELETE /api/lib/project?kind=&name=    整个子库（含子目录）一起删
  所有路径都做越界校验，只允许动 input / output 里面。
"""

import argparse
import http.server
import json
import os
import posixpath
import shutil
import socket
import socketserver
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
ROOT_CFG = os.path.join(ROOT, "comfy-root.txt")


def _read_version():
    """版本号只认 VERSION 这一个文件，打包脚本也读它，避免两处对不上"""
    try:
        with open(os.path.join(ROOT, "VERSION"), "r", encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except Exception:
        return "0.0.0"


VERSION = _read_version()
PORT = int(os.environ.get("WY_CANVAS_PORT", "8277"))
HOST = os.environ.get("WY_CANVAS_HOST", "127.0.0.1")

KINDS = ("input", "output")

MEDIA_EXT = {
    "image": (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"),
    "video": (".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"),
    "audio": (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus"),
    "text": (".txt", ".md", ".json", ".csv", ".log"),
}

MAX_ITEMS = 400          # 单个子库最多列这么多条（按修改时间倒序）
COUNT_CAP = 4000         # 统计子库文件数时最多数这么多，防止超大树卡住

# 改文件名时要挡掉的东西：Windows 不允许的字符 + 保留设备名
BAD_CHARS = '<>:"/\\|?*'
WIN_RESERVED = {"CON", "PRN", "AUX", "NUL",
                *("COM%d" % i for i in range(1, 10)),
                *("LPT%d" % i for i in range(1, 10))}


# ----------------------------------------------------------------------------
# ComfyUI 根目录探测
# ----------------------------------------------------------------------------
def _load_cfg_root():
    try:
        with open(ROOT_CFG, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _candidates():
    out = []
    env = os.environ.get("WY_COMFY_ROOT", "").strip()
    if env:
        out.append(env)
    cfg = _load_cfg_root()
    if cfg:
        out.append(cfg)
    # 常见位置：秋叶整合包 / 官方包 / 各盘符根目录
    for base in ("E:", "D:", "C:", "F:", "G:"):
        out.append(base + "/ComfyUI-aki-v3.2/ComfyUI")
        out.append(base + "/ComfyUI-aki-v3.2")
        out.append(base + "/ComfyUI")
        out.append(base + "/ComfyUI_windows_portable/ComfyUI")
    return out


def _is_comfy(p):
    return bool(p) and os.path.isdir(os.path.join(p, "input")) and os.path.isdir(os.path.join(p, "output"))


def comfy_root():
    for c in _candidates():
        c = (c or "").replace("\\", "/").rstrip("/")
        if _is_comfy(c):
            return c
    return ""


def kind_dir(kind):
    """input / output 的绝对路径；不合法返回 None"""
    if kind not in KINDS:
        return None
    r = comfy_root()
    if not r:
        return None
    return os.path.join(r, kind)


def safe_join(base, *parts):
    """拼路径并确保没跑出 base（防 ../../ 越界）"""
    clean = [p for p in parts if p not in ("", None)]
    target = os.path.abspath(os.path.join(base, *[p.replace("\\", "/") for p in clean]))
    b = os.path.abspath(base)
    if target != b and not target.startswith(b + os.sep):
        raise ValueError("路径越界")
    return target


def kind_of(name):
    ext = os.path.splitext(name)[1].lower()
    for k, exts in MEDIA_EXT.items():
        if ext in exts:
            return k
    return "other"


# ----------------------------------------------------------------------------
# 素材库操作
# ----------------------------------------------------------------------------
def lib_projects(kind):
    d = kind_dir(kind)
    if not d or not os.path.isdir(d):
        return []
    out = []
    try:
        names = os.listdir(d)
    except OSError:
        return []
    for n in names:
        p = os.path.join(d, n)
        if not os.path.isdir(p):
            continue
        cnt, mt = 0, os.path.getmtime(p)
        for dirpath, _dirs, files in os.walk(p):
            for fn in files:
                if kind_of(fn) == "other":
                    continue
                cnt += 1
                try:
                    mt = max(mt, os.path.getmtime(os.path.join(dirpath, fn)))
                except OSError:
                    pass
                if cnt >= COUNT_CAP:
                    break
            if cnt >= COUNT_CAP:
                break
        out.append({"name": n, "count": cnt, "mtime": int(mt)})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def lib_items(kind, project, limit=MAX_ITEMS):
    d = kind_dir(kind)
    if not d or not os.path.isdir(d):
        return []
    base = safe_join(d, project)
    if not os.path.isdir(base):
        return []
    out = []
    if project:
        # 子库里递归（output/图片/Qwen2.1/2026-10-20/x.png 这种层级要能看到）
        for dirpath, _dirs, files in os.walk(base):
            for fn in files:
                p = os.path.join(dirpath, fn)
                out.append(_item(d, p))
    else:
        # 根目录只看第一层，不然会把整个 input 翻出来
        for fn in os.listdir(base):
            p = os.path.join(base, fn)
            if os.path.isfile(p):
                out.append(_item(d, p))
    out = [x for x in out if x]
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out[:limit]


def _item(root_dir, path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    name = os.path.basename(path)
    k = kind_of(name)
    if k == "other":
        return None
    rel = os.path.relpath(path, root_dir).replace("\\", "/")
    sub = posixpath.dirname(rel)
    return {"name": name, "sub": sub, "kind": k, "size": st.st_size, "mtime": int(st.st_mtime)}


def lib_delete(kind, sub, name):
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    base = safe_join(d, sub)
    p = safe_join(base, name)
    if not os.path.isfile(p):
        raise ValueError("文件不存在")
    os.remove(p)
    return True


def lib_rename(kind, sub, name, to):
    """改素材的文件名：目录不动、扩展名不动。

    前端传上来的 `to` 是**不带扩展名的名字**（界面上扩展名拆成固定后缀，改不了），
    这里仍兜一层：万一把 "abc.png" 整串送进来，别拼成 "abc.png.png"。
    扩展名不改是有意的 —— 库里靠后缀区分图片 / 视频 / 音频，缩略图也靠它决定怎么画。
    """
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    base = safe_join(d, sub)
    src = safe_join(base, name)
    if not os.path.isfile(src):
        raise ValueError("文件不存在")
    ext = os.path.splitext(name)[1]
    new = (to or "").strip()
    if ext and new.lower().endswith(ext.lower()):
        new = new[:-len(ext)]
    new = new.strip()
    if not new or new in (".", ".."):
        raise ValueError("新名字不能为空")
    if any(ch in BAD_CHARS for ch in new) or any(ord(ch) < 32 for ch in new):
        raise ValueError('新名字不能带 \\ / : * ? " < > | 这些字符')
    if new[-1] in ". ":
        raise ValueError("新名字不能以点或空格结尾")
    if new.split(".")[0].upper() in WIN_RESERVED:
        raise ValueError("「%s」是 Windows 的保留名，换一个" % new)
    dst = safe_join(base, new + ext)
    if dst.lower() == src.lower():                 # 只改了大小写，仍要真的改
        if dst != src:
            tmp = safe_join(base, "_wy_rename_tmp_" + name)
            os.rename(src, tmp)
            os.rename(tmp, dst)
            return {"ok": True, "name": new + ext, "from": name}
        return {"ok": True, "name": name, "unchanged": True}
    if os.path.exists(dst):
        raise ValueError("这个子库里已经有叫「%s」的文件了" % (new + ext))
    os.rename(src, dst)
    return {"ok": True, "name": new + ext, "from": name}


def probe_video(kind, sub, name):
    """读视频的帧数 / 帧率 / 宽高。

    导演台的分段模式切到 v2v（视频转视频）时，时间线里必须写死源视频的长度，
    填错了 ComfyUI 会去读超出片尾的帧。浏览器拿不到帧数（只能拿到时长），
    所以这一格必须由后端用 OpenCV 探一次。
    """
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    p = safe_join(safe_join(d, sub), name)
    if not os.path.isfile(p):
        raise ValueError("文件不存在")
    try:
        import cv2
    except Exception:
        raise ValueError("这台机器的 python 没装 opencv，探不了时长；请在导演台的时间线面板里直接选视频")
    cap = cv2.VideoCapture(p)
    if not cap.isOpened():
        cap.release()
        raise ValueError("这个文件解不开（不是视频 / 编码不支持）")
    try:
        frames = int(round(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0))
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        w = int(round(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0))
        h = int(round(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0))
    finally:
        cap.release()
    if frames <= 0:
        raise ValueError("这个视频读不出帧数（可能是可变帧率），请在导演台面板里直接选")
    return {"ok": True, "frames": frames, "fps": round(fps or 24, 3),
            "width": w, "height": h, "path": p}


def lib_mkproject(kind, name):
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    name = (name or "").strip().replace("\\", "/").strip("/")
    if not name or "/" in name or name in (".", ".."):
        raise ValueError("子库名不合法（不能带斜杠）")
    p = safe_join(d, name)
    os.makedirs(p, exist_ok=True)
    return p


def lib_delete_many(kind, items):
    """批量删文件。items = [{"sub": "...", "name": "..."}]
    逐个删，单个失败不影响其他；返回删掉几个、哪些没删掉、为什么。"""
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    done, failed = 0, []
    for it in items or []:
        try:
            sub = (it.get("sub") or "").strip("/")
            name = (it.get("name") or "").strip()
            if not name:
                raise ValueError("文件名为空")
            p = safe_join(safe_join(d, sub), name)
            if not os.path.isfile(p):
                raise ValueError("文件不存在")
            os.remove(p)
            done += 1
        except Exception as e:
            failed.append({"name": it.get("name", ""), "sub": it.get("sub", ""), "error": str(e)})
    return {"deleted": done, "failed": failed}


def lib_collect(kind, sub, name, lib="成品库"):
    """把一个产出文件收进成品库（output/<lib>/）。源可以在 input / output / temp。
    同名不覆盖：自动加 _1、_2 后缀，绝不静默盖掉已收的成品。"""
    r = comfy_root()
    if not r:
        raise ValueError("没找到 ComfyUI 目录")
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("文件名不合法")
    sub = (sub or "").strip().replace("\\", "/").strip("/")
    src_dir = {
        "input": os.path.join(r, "input"),
        "output": os.path.join(r, "output"),
        "temp": os.path.join(r, "temp"),
    }.get(kind)
    if not src_dir:
        raise ValueError("来源类型不对（只支持 input / output / temp）")
    src = safe_join(src_dir, sub, name) if sub else safe_join(src_dir, name)
    if not os.path.isfile(src):
        raise ValueError("源文件不存在")
    lib = (lib or "成品库").strip().replace("\\", "/").strip("/")
    if not lib or "/" in lib or lib in (".", ".."):
        raise ValueError("库名不合法")
    dst_dir = os.path.join(kind_dir("output"), lib)
    os.makedirs(dst_dir, exist_ok=True)
    base, ext = os.path.splitext(name)
    final, i = name, 1
    while os.path.exists(os.path.join(dst_dir, final)):
        final = f"{base}_{i}{ext}"
        i += 1
    dst = safe_join(dst_dir, final)
    shutil.copy2(src, dst)
    return {"name": final, "lib": lib, "path": dst, "size": os.path.getsize(dst)}


def lib_delete_project(kind, name):
    """整个子库一起删（含里面的子目录）。只允许删一级子目录，根目录永远不碰。"""
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    name = (name or "").strip().replace("\\", "/").strip("/")
    if not name or "/" in name or name in (".", ".."):
        raise ValueError("子库名不合法")
    base = os.path.abspath(d)
    p = safe_join(base, name)
    if p == base:
        raise ValueError("不能删根目录")
    if not os.path.isdir(p):
        raise ValueError("子库不存在")
    # 先数一遍，好让界面把「要删多少」说清楚
    files = 0
    for _dirpath, _dirs, fs in os.walk(p):
        files += len(fs)
    shutil.rmtree(p)
    return {"deleted_files": files, "path": p}


def lib_delete_dir(kind, sub):
    """删素材库内部的一个文件夹（含里面的文件和子目录）。
    sub 是相对 input / output 的路径，可以是多级（图片/Qwen2.1/2026-10-08）。"""
    d = kind_dir(kind)
    if not d:
        raise ValueError("没找到 ComfyUI 目录")
    sub = (sub or "").strip().replace("\\", "/").strip("/")
    if not sub:
        raise ValueError("没说要删哪个文件夹")
    if any(seg in ("", ".", "..") for seg in sub.split("/")):
        raise ValueError("路径不合法")
    base = os.path.abspath(d)
    p = safe_join(base, sub)
    if p == base:
        raise ValueError("不能删根目录")
    if not os.path.isdir(p):
        raise ValueError("文件夹不存在")
    files = 0
    for _dirpath, _dirs, fs in os.walk(p):
        files += len(fs)
    shutil.rmtree(p)
    return {"deleted_files": files, "path": p}


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件 + 素材库 API（静态文件禁缓存，改完 JS 刷新即生效）"""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else ""
        if str(code).startswith(("4", "5")):
            sys.stderr.write("  [%s] %s\n" % (code, args[0]))

    # ---------- 工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            # 浏览器已经把页面关了 / 跳走了还回来取结果，别在控制台糊一段 traceback
            pass

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def _q(self, u):
        return {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}

    # ---------- 路由 ----------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/lib/"):
            return self._lib_get(u)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/lib/"):
            return self._lib_post(u)
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/lib/"):
            return self._lib_delete(u)
        self._json({"error": "not found"}, 404)

    def _lib_get(self, u):
        q = self._q(u)
        tail = u.path[len("/api/lib/"):]
        try:
            if tail == "root":
                r = comfy_root()
                return self._json({
                    "ok": bool(r), "root": r,
                    "input": os.path.join(r, "input") if r else "",
                    "output": os.path.join(r, "output") if r else "",
                    "candidates": [c for c in _candidates() if c],
                })
            if tail == "projects":
                kind = q.get("kind", "input")
                return self._json({"projects": lib_projects(kind), "root": comfy_root()})
            if tail == "items":
                kind = q.get("kind", "input")
                project = q.get("project", "")
                return self._json({"items": lib_items(kind, project), "project": project})
            if tail == "probe":                      # 视频帧数 / 帧率 / 宽高
                return self._json(probe_video(q.get("kind", "input"),
                                              q.get("sub", ""), q.get("name", "")))
            return self._json({"error": "unknown endpoint"}, 404)
        except Exception as e:
            return self._json({"error": str(e)}, 500)

    def _lib_post(self, u):
        tail = u.path[len("/api/lib/"):]
        body = self._body()
        try:
            if tail == "root":
                root = (body.get("root") or "").strip().replace("\\", "/").rstrip("/")
                if not _is_comfy(root):
                    return self._json({"ok": False, "error": "这个目录下没有 input / output 子目录"}, 400)
                with open(ROOT_CFG, "w", encoding="utf-8") as f:
                    f.write(root)
                return self._json({"ok": True, "root": root})
            if tail == "project":
                kind = body.get("kind", "input")
                p = lib_mkproject(kind, body.get("name", ""))
                return self._json({"ok": True, "path": p})
            if tail == "delete":                       # 批量删文件
                kind = body.get("kind", "input")
                return self._json({"ok": True, **lib_delete_many(kind, body.get("items") or [])})
            if tail == "rename":                       # 改文件名（扩展名不动）
                return self._json({"ok": True, **lib_rename(
                    body.get("kind", "input"), body.get("sub", ""),
                    body.get("name", ""), body.get("to", ""))})
            if tail == "collect":                      # 收进成品库（复制，不删源）
                return self._json({"ok": True, **lib_collect(
                    body.get("kind", "output"), body.get("sub", ""),
                    body.get("name", ""), body.get("lib", "成品库"))})
            return self._json({"error": "unknown endpoint"}, 404)
        except Exception as e:
            return self._json({"error": str(e)}, 400)

    def _lib_delete(self, u):
        q = self._q(u)
        try:
            if u.path.rstrip("/").endswith("/project"):   # 整个子库一起删
                r = lib_delete_project(q.get("kind", "input"), q.get("name", ""))
                return self._json({"ok": True, **r})
            if u.path.rstrip("/").endswith("/dir"):      # 素材库内部的文件夹一起删
                r = lib_delete_dir(q.get("kind", "input"), q.get("sub", ""))
                return self._json({"ok": True, **r})
            lib_delete(q.get("kind", "input"), q.get("sub", ""), q.get("name", ""))
            return self._json({"ok": True})
        except Exception as e:
            return self._json({"error": str(e)}, 400)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def port_busy(port, host=None):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host or HOST, port)) == 0


def is_ours(port, host=None):
    """端口上跑的是不是本画布（重复双击时别又起一个，直接开已有的）"""
    url = "http://%s:%d/api/lib/root" % (host or HOST, port)
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(url, timeout=1.2) as r:
            data = json.loads(r.read().decode("utf-8"))
        return isinstance(data, dict) and "root" in data and "candidates" in data
    except Exception:
        return False


def bind_server(host, want, span=20):
    """从 want 开始往后找一个能绑上的端口。返回 (server, port)，找不到给 (None, None)"""
    err = None
    for p in range(want, want + span):
        try:
            return Server((host, p), Handler), p
        except OSError as e:
            err = e
    sys.stderr.write("  %d-%d 都绑不上：%s\n" % (want, want + span - 1, err))
    return None, None


def banner(url, comfy):
    line = "  " + "-" * 54
    print()
    print(line)
    print("   本地无限画布   v%s" % VERSION)
    print(line)
    print("   地址      %s" % url)
    print("   ComfyUI   %s" % (comfy or "未找到"))
    print("   Python    %s" % sys.version.split()[0])
    if not comfy:
        print()
        print("   ! 没找到 ComfyUI 的 input / output 目录，素材库会显示未就绪。")
        print("     在页面「素材库」里指定一次 ComfyUI 目录即可，之后会记住。")
    print()
    print("   关闭本窗口（或按 Ctrl+C）即停止服务")
    print(line)
    print()
    sys.stdout.flush()


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="serve.py",
        description="本地无限画布：静态服务器 + 素材库 API（对接本机 ComfyUI）",
    )
    ap.add_argument("-p", "--port", type=int, default=PORT,
                    help="监听端口，默认 %d，被占用时自动往后找" % PORT)
    ap.add_argument("--host", default=HOST, help="监听地址，默认 %s" % HOST)
    ap.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    ap.add_argument("-v", "--version", action="version", version="wy-canvas " + VERSION)
    a = ap.parse_args(argv)

    # 0.0.0.0 只用于监听，探测/自检还得走回环地址
    host = a.host
    probe = "127.0.0.1" if host in ("0.0.0.0", "") else host
    show = "127.0.0.1" if host in ("0.0.0.0", "") else host

    if port_busy(a.port, probe):
        url = "http://%s:%d/" % (show, a.port)
        if is_ours(a.port, probe):
            print("\n  画布已经在 %s 跑着了，直接给你打开它。" % url)
            if not a.no_browser:
                webbrowser.open(url)
            return 0
        httpd, port = bind_server(host, a.port + 1)
        if not httpd:
            return 1
        print("\n  ! 端口 %d 被别的程序占着，这次改用 %d。" % (a.port, port))
    else:
        httpd, port = bind_server(host, a.port)
        if not httpd:
            return 1

    url = "http://%s:%d/" % (show, port)
    banner(url, comfy_root())

    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
