"""
build-release.py —— 打一个「解压即用」的绿色包

用法：
    python build-release.py                # dist/wy-canvas-v1.0.0.zip
    python build-release.py --with-docs    # 连 docs/ 截图一起收（当前 README 未引用，默认不收）
    python build-release.py --out D:/tmp   # 换输出目录

规则：
  * 只收白名单里的文件，不靠「排除法」——仓库里多出个临时脚本也不会被打进去；
  * comfy-root.txt / __pycache__ / dist / .git 一律不收（前者是别人机器上的路径）；
  * 版本号只读 VERSION，压缩包名和包内目录名都从它来，不手写第二份。
"""

import argparse
import hashlib
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))

# 必带的单个文件
FILES = [
    "index.html",
    "serve.py",
    "start.bat",
    "start.sh",
    "VERSION",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
]

# 必带的目录（整棵收，按下面的 SKIP 过滤）
DIRS = ["css", "js"]

# docs/ 里是早期界面截图，README 目前没有引用，新旧版本也对不上，
# 默认不进发布包（体积从 4.6 MB 降到 0.5 MB）。要带就 --with-docs。
OPTIONAL_DIRS = ["docs"]

# 任何层级出现都不要的
SKIP_NAMES = {"__pycache__", ".git", "dist", "comfy-root.txt", ".tmp",
              ".DS_Store", "Thumbs.db", ".vscode", ".idea"}
SKIP_EXT = {".pyc", ".pyo", ".zip", ".sha256", ".log"}

# 打完必须能在包里找到，少一个就报错
MUST_HAVE = ["index.html", "serve.py", "start.bat", "start.sh", "VERSION", "LICENSE"]


def read_version():
    try:
        with open(os.path.join(ROOT, "VERSION"), "r", encoding="utf-8") as f:
            v = f.read().strip()
    except OSError:
        sys.exit("  找不到 VERSION 文件，没法定版本号")
    if not v:
        sys.exit("  VERSION 是空的")
    return v


def collect(with_docs=False):
    """返回 [(绝对路径, 包内相对路径)]"""
    picked = []
    for name in FILES:
        p = os.path.join(ROOT, name)
        if os.path.isfile(p):
            picked.append((p, name))
        else:
            sys.stderr.write("  ! 缺少 %s，跳过\n" % name)

    dirs = DIRS + (OPTIONAL_DIRS if with_docs else [])
    for d in dirs:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in SKIP_NAMES]
            for fn in filenames:
                if fn in SKIP_NAMES or os.path.splitext(fn)[1].lower() in SKIP_EXT:
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT).replace("\\", "/")
                picked.append((full, rel))
    return picked


def main():
    ap = argparse.ArgumentParser(description="打包 wy-canvas 绿色版")
    ap.add_argument("--with-docs", action="store_true", help="连 docs/ 截图一起收（默认不收）")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="输出目录")
    a = ap.parse_args()

    ver = read_version()
    top = "wy-canvas-v%s" % ver
    os.makedirs(a.out, exist_ok=True)
    zip_path = os.path.join(a.out, "%s.zip" % top)

    items = collect(with_docs=a.with_docs)
    have = {rel for _full, rel in items}
    missing = [m for m in MUST_HAVE if m not in have]
    if missing:
        sys.exit("  打包中止，缺少关键文件：%s" % ", ".join(missing))

    # 可执行位：解压后 start.sh 仍能直接 ./start.sh
    exec_names = {"start.sh"}
    total = 0

    # 固定时间戳 → 同一份源码每次打出来的 zip 逐字节相同（SHA256 可复现），
    # 否则每个条目带着各自的 mtime，连打两次校验和都不一样，没法对账
    STAMP = (1980, 1, 1, 0, 0, 0)

    def entry(name, mode):
        info = zipfile.ZipInfo(name, date_time=STAMP)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = mode << 16
        info.create_system = 3          # 标成 Unix，解压端才认权限位
        return info

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in items:
            total += os.path.getsize(full)
            info = entry("%s/%s" % (top, rel), 0o755 if rel in exec_names else 0o644)
            with open(full, "rb") as src, z.open(info, "w") as dst:
                dst.write(src.read())

        # 解压后一眼能看懂的落地说明
        z.writestr(entry("%s/包内说明.txt" % top, 0o644), (
            "wy-canvas v%s\r\n"
            "\r\n"
            "1. 先把 ComfyUI 跑起来（默认 http://127.0.0.1:8188）\r\n"
            "2. Windows 双击 start.bat；macOS / Linux 执行 ./start.sh\r\n"
            "3. 浏览器会自动打开 http://127.0.0.1:8277/\r\n"
            "\r\n"
            "没装 Python 也能用——若已装 ComfyUI，启动脚本会自动借用它自带的 Python。\r\n"
            "端口被占用时会自动往后找（8278、8279…），控制台会打印实际地址。\r\n"
            "\r\n"
            "详细说明见 README.md，许可证见 LICENSE（MIT）。\r\n"
            % ver
        ).encode("utf-8"))

    size = os.path.getsize(zip_path)
    sha = hashlib.sha256()
    with open(zip_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    with open(zip_path + ".sha256", "w", encoding="utf-8", newline="\n") as f:
        f.write("%s  %s\n" % (digest, os.path.basename(zip_path)))

    print()
    print("  %s" % os.path.basename(zip_path))
    print("  版本    v%s" % ver)
    print("  文件    %d 个，原始 %.1f KB → 压缩后 %.1f KB" % (len(items), total / 1024, size / 1024))
    print("  SHA256  %s" % digest)
    print()
    print("  包内清单：")
    for _full, rel in sorted(items, key=lambda x: x[1]):
        print("    %-38s %7.1f KB" % (rel, os.path.getsize(_full) / 1024))
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
