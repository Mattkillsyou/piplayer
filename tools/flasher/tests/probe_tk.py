"""Temporary CI probe: which part of the flasher window makes Tk's update() hang on the GitHub macOS runners.
Usage: python tests/probe_tk.py <stage> <mode>; prints progress, exits 0 (a hang is caught by `timeout`)."""
import sys
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import flasher  # noqa: E402
from conftest import fake_wifi  # noqa: E402

stage, mode = sys.argv[1], sys.argv[2]
flasher.disk.list_disks = lambda: []
flasher.wifi = fake_wifi()
flasher.sshkey.ensure_keypair = lambda log=None: "ssh-ed25519 AAAA x"


def make_root():
    base = tk.Tk()
    base.withdraw()
    if mode == "toplevel":
        r = tk.Toplevel(base)
    elif mode == "second":
        base.destroy()
        r = tk.Tk()
    else:
        r = base
    r.withdraw()
    return r


def pump(r, label, n=15):
    for i in range(n):
        a = time.monotonic()
        r.update()
        d = time.monotonic() - a
        if d > 0.5:
            print(f"  {label}: update #{i} took {d:.2f}s", flush=True)
        time.sleep(0.02)
    print(f"  {label}: {n} updates ok", flush=True)


root = make_root()
print(f"stage {stage} mode {mode}: root made", flush=True)
if stage == "theme":
    flasher.apply_theme(root)
    pump(root, "theme")
elif stage == "labels":
    flasher.apply_theme(root)
    ttk.Label(root, text="MATT BROWN'S", style="Eyebrow.TLabel").pack()
    ttk.Label(root, text="PROJECTION5000", style="Wordmark.TLabel").pack()
    logo = flasher.load_logo(root)
    ttk.Label(root, image=logo).pack()
    pump(root, "labels")
elif stage == "widgets":
    flasher.apply_theme(root)
    ttk.Entry(root).pack()
    ttk.Combobox(root, values=["a", "b"], state="readonly").pack()
    ttk.Combobox(root, values=["a", "b"]).pack()
    ttk.Checkbutton(root, text="x").pack()
    ttk.Button(root, text="FLASH", style="Primary.TButton").pack()
    ttk.Progressbar(root, maximum=100).pack()
    t = tk.Text(root, height=3)
    t.pack()
    ttk.Scrollbar(root, orient="vertical", command=t.yview).pack()
    pump(root, "widgets")
elif stage == "brackets":
    flasher.apply_theme(root)
    panel = tk.Frame(root, bg=flasher.GROUND)
    panel.pack(fill="x")
    ttk.Frame(panel, padding=(16, 14)).pack(fill="x")
    flasher.draw_brackets(panel)
    m = flasher.hatch_marker(root)
    ttk.Label(root, text="err", image=m, compound="left").pack()
    pump(root, "brackets")
elif stage == "app":
    t0 = time.monotonic()
    app = flasher.App(root)
    print(f"  App built in {time.monotonic() - t0:.2f}s", flush=True)
    pump(root, "app")
    print(f"  disks={app.disks} hint={app.ssid_hint.cget('text')!r}", flush=True)
elif stage == "app-size":
    flasher.App._fit_to_screen = lambda self: None  # no geometry call
    app = flasher.App(root)
    pump(root, "app-size")
elif stage == "app-threads":
    flasher.App.refresh_disks = lambda self: None
    flasher.App.refresh_networks = lambda self: None
    app = flasher.App(root)
    pump(root, "app-threads")
elif stage in ("idle", "geom", "geompos", "minsize-geom", "reqsize", "update-geom"):
    flasher.apply_theme(root)
    ttk.Label(root, text="x").pack()
    if stage == "idle":
        root.update_idletasks()
    elif stage == "geom":
        root.geometry("700x460")
    elif stage == "geompos":
        root.geometry("700x460+50+100")
    elif stage == "minsize-geom":
        root.minsize(700, 460)
        root.geometry("700x460")
    elif stage == "reqsize":
        root.update_idletasks()
        print(f"  req {root.winfo_reqwidth()}x{root.winfo_reqheight()} rooty={root.winfo_rooty()} y={root.winfo_y()} viewable={root.winfo_viewable()}", flush=True)
    elif stage == "update-geom":
        root.update_idletasks()
        root.geometry(f"{max(root.winfo_reqwidth(), 700)}x{max(root.winfo_reqheight(), 460)}")
    pump(root, stage)
elif stage == "twice":
    app = flasher.App(root)
    pump(root, "first app", 5)
    root.destroy()
    root = make_root()
    app = flasher.App(root)
    pump(root, "second app", 5)
print(f"stage {stage} mode {mode}: DONE", flush=True)
