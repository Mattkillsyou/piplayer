"""Projection5000 SD Flasher: write Raspberry Pi OS Lite to a card and pre-configure the Pi.

Run: python flasher.py            (relaunches itself elevated if needed)
     python flasher.py --selfcheck (prints the generated first-boot scripts, exits 0)
     python flasher.py --dry-run   (no admin needed; Flash stops before touching the card)
"""
import ctypes
import json
import os
import queue
import secrets
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import console
import firstboot
import imagefetch
import windisk

APP_TITLE = "Projection5000 SD Flasher"
SETTINGS_KEYS = ("name", "device_id", "console_url", "reg_mode", "console_user", "ssid", "wifi_country",
                 "wifi_hidden", "ethernet_only", "username", "ssh", "timezone", "keymap", "image_mode",
                 "image_path")
COUNTRIES = ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "ES", "IT", "NL", "SE", "NO", "DK", "FI", "IE", "JP", "MX", "BR"]
TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix",
             "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "America/Mexico_City",
             "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
             "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Australia/Sydney", "Australia/Melbourne",
             "Pacific/Auckland", "Asia/Tokyo", "Asia/Singapore", "UTC"]


# ---------------------------------------------------------------- elevation

def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_elevated() -> bool:
    """ShellExecuteW 'runas' this program with --elevated. False when the UAC prompt was declined."""
    if getattr(sys, "frozen", False):
        exe, params = sys.executable, "--elevated"
    else:
        exe, params = sys.executable, f'"{os.path.abspath(__file__)}" --elevated'
    # Values <= 32 are errors (5 = SE_ERR_ACCESSDENIED: the user declined the UAC prompt).
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, None, 1)
    return rc > 32


def not_admin_message() -> None:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(APP_TITLE, "Run as administrator.\n\nWriting an SD card needs administrator rights. "
                         "Right-click the program and choose \"Run as administrator\".")
    root.destroy()


def ensure_admin(argv) -> bool:
    """True when we may continue. Otherwise the elevated copy is running (or the user declined)."""
    if is_admin():
        return True
    if "--elevated" not in argv and relaunch_elevated():
        return False
    not_admin_message()
    return False


# ---------------------------------------------------------------- settings

def settings_path() -> Path:
    return imagefetch.app_dir() / "flasher.json"


def load_settings() -> dict:
    try:
        return json.loads(settings_path().read_text("utf-8"))
    except Exception:
        return {}


def save_settings(values: dict) -> None:
    try:
        settings_path().parent.mkdir(parents=True, exist_ok=True)
        settings_path().write_text(json.dumps({k: values[k] for k in SETTINGS_KEYS if k in values}, indent=2), "utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- GUI

class App:
    def __init__(self, root: tk.Tk, dry_run: bool = False):
        self.root = root
        root.title(APP_TITLE)
        root.minsize(720, 640)
        self.dry_run_default = dry_run
        self.cancel = threading.Event()
        self.worker = None
        self.q = queue.Queue()
        self.disks = []
        self.v = {}  # tk variables by key
        self._build()
        self._apply_settings(load_settings())
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._pump()
        self.refresh_disks()

    # ----- form
    def _var(self, key, default="", kind=tk.StringVar):
        self.v[key] = kind(value=default)
        return self.v[key]

    def _entry(self, parent, row, label, key, default="", show=None, width=40):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=4, pady=2)
        e = ttk.Entry(parent, textvariable=self._var(key, default), width=width, show=show)
        e.grid(row=row, column=1, sticky="we", padx=4, pady=2)
        return e

    def _build(self):
        outer = ttk.Frame(self.root, padding=8)
        outer.pack(fill="both", expand=True)
        form = ttk.Frame(outer)
        form.pack(fill="x")
        form.columnconfigure(0, weight=1)
        form.columnconfigure(1, weight=1)

        dev = ttk.LabelFrame(form, text="Device", padding=6)
        dev.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)
        dev.columnconfigure(1, weight=1)
        self._entry(dev, 0, "Device name", "name")
        self._entry(dev, 1, "device_id (hostname)", "device_id")
        self.v["name"].trace_add("write", self._derive_id)
        self._id_manual = False
        self.v["device_id"].trace_add("write", self._id_edited)

        con = ttk.LabelFrame(form, text="Console", padding=6)
        con.grid(row=1, column=0, sticky="nsew", padx=4, pady=4)
        con.columnconfigure(1, weight=1)
        self._entry(con, 0, "Console URL", "console_url", "https://projectors.photogen5000.com")
        self._var("reg_mode", "register")
        ttk.Radiobutton(con, text="Register this device for me", variable=self.v["reg_mode"],
                        value="register").grid(row=1, column=0, columnspan=2, sticky="w", padx=4)
        self._entry(con, 2, "Console username", "console_user", "admin")
        self._entry(con, 3, "Console password", "console_password", show="*")
        ttk.Radiobutton(con, text="I already have a device token", variable=self.v["reg_mode"],
                        value="token").grid(row=4, column=0, columnspan=2, sticky="w", padx=4)
        self._entry(con, 5, "Device token", "token")

        wifi = ttk.LabelFrame(form, text="Wi-Fi", padding=6)
        wifi.grid(row=0, column=1, sticky="nsew", padx=4, pady=4)
        wifi.columnconfigure(1, weight=1)
        self._entry(wifi, 0, "SSID", "ssid")
        pw = self._entry(wifi, 1, "Password", "wifi_password", show="*")
        self._var("show_wifi", False, tk.BooleanVar)
        ttk.Checkbutton(wifi, text="Show", variable=self.v["show_wifi"],
                        command=lambda: pw.configure(show="" if self.v["show_wifi"].get() else "*")
                        ).grid(row=1, column=2, padx=2)
        ttk.Label(wifi, text="Country").grid(row=2, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(wifi, textvariable=self._var("wifi_country", "US"), values=COUNTRIES, width=8
                     ).grid(row=2, column=1, sticky="w", padx=4, pady=2)
        ttk.Checkbutton(wifi, text="Hidden network", variable=self._var("wifi_hidden", False, tk.BooleanVar)
                        ).grid(row=3, column=0, columnspan=2, sticky="w", padx=4)
        ttk.Checkbutton(wifi, text="Ethernet only (no Wi-Fi)", variable=self._var("ethernet_only", False, tk.BooleanVar)
                        ).grid(row=4, column=0, columnspan=2, sticky="w", padx=4)

        pi = ttk.LabelFrame(form, text="Pi login", padding=6)
        pi.grid(row=1, column=1, sticky="nsew", padx=4, pady=4)
        pi.columnconfigure(1, weight=1)
        self._entry(pi, 0, "Username", "username", "pi")
        self._entry(pi, 1, "Password", "password", secrets.token_urlsafe(12))
        ttk.Checkbutton(pi, text="Enable SSH", variable=self._var("ssh", True, tk.BooleanVar)
                        ).grid(row=2, column=0, columnspan=2, sticky="w", padx=4)
        ttk.Label(pi, text="Timezone").grid(row=3, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(pi, textvariable=self._var("timezone", "America/Los_Angeles"), values=TIMEZONES
                     ).grid(row=3, column=1, sticky="we", padx=4, pady=2)
        self._entry(pi, 4, "Keyboard layout", "keymap", "us", width=8)

        img = ttk.LabelFrame(form, text="Image", padding=6)
        img.grid(row=2, column=0, sticky="nsew", padx=4, pady=4)
        img.columnconfigure(1, weight=1)
        self._var("image_mode", "latest")
        ttk.Radiobutton(img, text="Raspberry Pi OS Lite (64-bit), latest (downloaded and cached)",
                        variable=self.v["image_mode"], value="latest").grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Radiobutton(img, text="Local image file (.img or .img.xz)", variable=self.v["image_mode"],
                        value="local").grid(row=1, column=0, columnspan=3, sticky="w")
        ttk.Entry(img, textvariable=self._var("image_path")).grid(row=2, column=0, columnspan=2, sticky="we", padx=4)
        ttk.Button(img, text="Browse...", command=self.browse_image).grid(row=2, column=2, padx=4)

        tgt = ttk.LabelFrame(form, text="Target SD card", padding=6)
        tgt.grid(row=2, column=1, sticky="nsew", padx=4, pady=4)
        tgt.columnconfigure(0, weight=1)
        self.disk_box = ttk.Combobox(tgt, textvariable=self._var("disk"), state="readonly")
        self.disk_box.grid(row=0, column=0, sticky="we", padx=4, pady=2)
        ttk.Button(tgt, text="Refresh", command=self.refresh_disks).grid(row=0, column=1, padx=4)
        ttk.Label(tgt, text="Everything on the selected card will be erased.").grid(row=1, column=0, columnspan=2,
                                                                                    sticky="w", padx=4)

        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=4)
        self.flash_btn = ttk.Button(buttons, text="Flash", command=self.on_flash)
        self.flash_btn.pack(side="left", padx=4)
        self.cancel_btn = ttk.Button(buttons, text="Cancel", command=self.on_cancel, state="disabled")
        self.cancel_btn.pack(side="left", padx=4)
        ttk.Checkbutton(buttons, text="Dry run (register + resolve image, do not write)",
                        variable=self._var("dry_run", self.dry_run_default, tk.BooleanVar)).pack(side="left", padx=4)
        self.progress = ttk.Progressbar(buttons, maximum=100)
        self.progress.pack(side="left", fill="x", expand=True, padx=8)
        self.status = ttk.Label(buttons, text="")
        self.status.pack(side="left", padx=4)

        self.log_text = tk.Text(outer, height=12, wrap="word", state="disabled")
        self.log_text.pack(fill="both", expand=True, pady=4)

    def _derive_id(self, *_):
        if not self._id_manual:
            self._setting_id = True
            self.v["device_id"].set(firstboot.derive_device_id(self.v["name"].get()))
            self._setting_id = False

    def _id_edited(self, *_):
        if not getattr(self, "_setting_id", False):
            self._id_manual = bool(self.v["device_id"].get())

    def _apply_settings(self, s: dict):
        for k in SETTINGS_KEYS:
            if k in s and k in self.v:
                try:
                    self.v[k].set(s[k])
                except tk.TclError:
                    pass
        self._id_manual = bool(s.get("device_id")) and s.get("device_id") != firstboot.derive_device_id(s.get("name", ""))

    def values(self) -> dict:
        return {k: var.get() for k, var in self.v.items()}

    # ----- actions
    def browse_image(self):
        p = filedialog.askopenfilename(title="Choose image", filetypes=[("Disk images", "*.img *.xz"), ("All", "*")])
        if p:
            self.v["image_path"].set(p)
            self.v["image_mode"].set("local")

    def refresh_disks(self):
        self.disk_box.set("Scanning...")

        def work():
            try:
                disks = windisk.list_disks()
            except Exception as e:
                disks, err = [], str(e)
            else:
                err = None
            self.post(lambda: self._show_disks(disks, err))

        threading.Thread(target=work, daemon=True).start()

    def _show_disks(self, disks, err):
        self.disks = disks
        self.disk_box["values"] = [d["label"] for d in disks]
        if err:
            self.log(f"Disk scan failed: {err}")
        if disks:
            self.disk_box.current(0)
        else:
            self.disk_box.set("(no removable disks found)")

    def selected_disk(self):
        label = self.v["disk"].get()
        return next((d for d in self.disks if d["label"] == label), None)

    def post(self, fn):
        """Queue fn for the Tk thread (workers must not touch widgets directly)."""
        self.q.put(fn)

    def _pump(self):
        # after() itself is not safe to call from worker threads before mainloop runs, so
        # workers only enqueue and this 50 ms poll on the Tk thread drains the queue.
        try:
            while True:
                self.q.get_nowait()()
        except queue.Empty:
            pass
        self.root.after(50, self._pump)

    def log(self, line: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line.rstrip("\n") + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def set_progress(self, pct, text=""):
        self.progress["value"] = max(0, min(100, pct))
        self.status.configure(text=text)

    def on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP_TITLE, "A flash is in progress. Quit anyway?"):
                return
        save_settings(self.values())
        self.root.destroy()

    def on_cancel(self):
        self.cancel.set()
        self.log("Cancelling...")

    def validate(self) -> dict:
        v = self.values()
        problems = []
        if not v["name"].strip():
            problems.append("Device name is required.")
        if not firstboot.valid_device_id(v["device_id"]):
            problems.append("device_id must be lowercase letters, digits and hyphens (1-63 chars).")
        if not v["console_url"].strip().startswith(("http://", "https://")):
            problems.append("Console URL must start with http:// or https://.")
        if v["reg_mode"] == "register" and not (v["console_user"] and v["console_password"]):
            problems.append("Console username and password are required to register the device.")
        if v["reg_mode"] == "token" and not v["token"].strip():
            problems.append("Device token is required.")
        if not v["ethernet_only"] and not v["ssid"]:
            problems.append("Wi-Fi SSID is required (or tick Ethernet only).")
        if not v["username"].strip() or not v["password"]:
            problems.append("Pi username and password are required.")
        if len(v["wifi_country"].strip()) != 2:
            problems.append("Wi-Fi country must be a 2-letter code.")
        if v["image_mode"] == "local" and not Path(v["image_path"]).is_file():
            problems.append("Local image file not found.")
        disk = self.selected_disk()
        if not v["dry_run"]:  # a dry run never touches the card, so none is needed
            if disk is None:
                problems.append("Select a target SD card.")
            elif disk["size"] == 0:
                problems.append("The selected reader has no card inserted.")
            elif disk["size"] > windisk.MAX_CARD_BYTES:
                problems.append("Refusing to write a disk larger than 512 GB.")
        if problems:
            messagebox.showerror(APP_TITLE, "\n".join(problems))
            return None
        v["disk_info"] = disk
        return v

    def on_flash(self):
        v = self.validate()
        if not v:
            return
        d = v["disk_info"]
        if not v["dry_run"]:
            if not messagebox.askyesno(APP_TITLE, f"Flash {v['name']} ({v['device_id']}) to:\n\n{d['label']}\n\n"
                                       "Everything on that card will be erased. Continue?"):
                return
            if not messagebox.askokcancel(APP_TITLE, f"FINAL CONFIRMATION\n\nDisk {d['number']}: {d['name']}\n"
                                          f"Size: {windisk.human_size(d['size'])}\n\nAll data on this disk will be "
                                          "destroyed.", icon="warning"):
                return
        save_settings(v)
        self.cancel.clear()
        self.flash_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.set_progress(0, "")
        self.worker = threading.Thread(target=self._run_flash, args=(v,), daemon=True)
        self.worker.start()

    # ----- worker
    def _run_flash(self, v: dict):
        log = lambda s: self.post(lambda: self.log(s))
        try:
            run_flash(v, log, lambda pct, text: self.post(lambda: self.set_progress(pct, text)), self.cancel,
                      dry_run=v["dry_run"])
            log("Done.")
        except (windisk.Cancelled, imagefetch.Cancelled):
            log("Cancelled. The card is NOT usable; flash it again.")
        except Exception as e:
            log(f"FAILED: {e}")
            self.post(lambda: messagebox.showerror(APP_TITLE, str(e)))
        finally:
            self.post(self._finished)

    def _finished(self):
        self.flash_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        self.status.configure(text="")


# ---------------------------------------------------------------- flash sequence (no widgets here)

def run_flash(v: dict, log, progress, cancel: threading.Event, dry_run: bool = False):
    """The flash sequence. dry_run stops after registration and image resolution, before any disk access."""
    d = v["disk_info"]
    cfg = {k: v[k] for k in ("device_id", "name", "username", "password", "ssh", "ssid", "wifi_password",
                              "wifi_hidden", "ethernet_only", "timezone", "keymap")}
    cfg["wifi_country"] = v["wifi_country"].strip().upper()
    cfg["console_url"] = v["console_url"].strip().rstrip("/")

    # 1. token
    if v["reg_mode"] == "register":
        log(f"Registering {v['device_id']} on {cfg['console_url']} ...")
        cfg["token"] = console.register_device(cfg["console_url"], v["console_user"], v["console_password"],
                                               v["device_id"], v["name"].strip())
        log("Registered, token received.")
    else:
        cfg["token"] = v["token"].strip()
    firstrun = firstboot.render_firstrun(cfg)
    provision = firstboot.render_provision(cfg)

    # 2. image
    image = obtain_image(v, log, progress, cancel, dry_run)
    if cancel.is_set():
        raise windisk.Cancelled()
    if dry_run:
        target = f"Disk {d['number']} ({d['name']})" if d else "the selected card (none chosen)"
        log(f"Dry run: would write {Path(image).name} to {target}. Nothing was written.")
        return

    # 3-4. clear + write
    log(f"Removing partitions from disk {d['number']} ...")
    windisk.clear_disk(d["number"])
    log(f"Writing {Path(image).name} to disk {d['number']} ...")
    drive = windisk.open_physical_drive(d["number"])
    try:
        start = time.monotonic()

        def on_write(written, consumed, total):
            pct = consumed * 100 / total if total else 0
            rate = written / max(time.monotonic() - start, 1e-6) / 1e6
            progress(pct, f"{written / 1e6:.0f} MB written, {rate:.1f} MB/s")

        written = windisk.write_image(image, drive, on_write, cancel)
        drive.flush()
        drive.refresh_partitions()
        log(f"Wrote {written / 1e6:.0f} MB. Verifying first {windisk.VERIFY_BYTES >> 20} MiB ...")
        # 5. verify
        if not windisk.verify_head(image, drive):
            raise windisk.DiskError("read-back verification failed: the card did not store what was written")
    finally:
        drive.close()
    progress(100, "written and verified")

    # 6. boot volume
    log("Waiting for the boot partition to mount ...")
    letter = windisk.find_boot_volume(d["number"])
    boot = Path(f"{letter}:/")
    log(f"Boot partition is {letter}:")

    # 7. first-boot files
    write_firstboot_files(boot, firstrun, provision)
    log("First-boot files written. Ejecting ...")
    try:
        windisk.eject(letter)
    except Exception as e:
        log(f"Eject failed ({e}); remove the card safely from Explorer.")

    # 8. summary
    log("")
    log("SUMMARY")
    log(f"  Device: {v['name'].strip()} ({v['device_id']}), hostname {v['device_id']}")
    log("  Network: Ethernet only" if v["ethernet_only"] else f"  Wi-Fi: {v['ssid']} ({cfg['wifi_country']})")
    log(f"  Pi user: {v['username']}   SSH: {'on' if v['ssh'] else 'off'}")
    log(f"  Console: {cfg['console_url']}")
    log("  Insert the card into the Pi and power on. It appears on the console's Devices page within about")
    log("  5 minutes on first boot (it installs the player from GitHub, so it needs internet access).")


def obtain_image(v: dict, log, progress, cancel, dry_run: bool = False) -> str:
    if v["image_mode"] == "local":
        log(f"Using local image {v['image_path']}")
        return v["image_path"]
    log("Resolving latest Raspberry Pi OS Lite (64-bit) ...")
    url, name = imagefetch.resolve_latest()
    expected = imagefetch.fetch_sha256(url)
    dest = imagefetch.cached_path(name)
    if dest.exists():
        log(f"Checking cached {name} ...")
        if imagefetch.verify_sha256(dest, expected):
            log("Cached image is valid.")
            return str(dest)
        log("Cached image is stale or corrupt, downloading again.")
    if dry_run:
        log(f"Dry run: would download {url}")
        return str(dest)
    log(f"Downloading {name} ...")

    def on_dl(done, total, rate):
        pct = done * 100 / total if total else 0
        progress(pct, f"downloading {done / 1e6:.0f} MB, {rate / 1e6:.1f} MB/s")

    imagefetch.download(url, dest, on_dl, cancel)
    log("Verifying download ...")
    if not imagefetch.verify_sha256(dest, expected):
        dest.unlink(missing_ok=True)
        raise imagefetch.FetchError("downloaded image failed sha256 verification")
    log("Download verified.")
    return str(dest)


def write_firstboot_files(boot: Path, firstrun: str, provision: str) -> None:
    (boot / "firstrun.sh").write_bytes(firstrun.encode("utf-8"))
    (boot / "projection5000-provision.sh").write_bytes(provision.encode("utf-8"))
    cmdline = boot / "cmdline.txt"
    cmdline.write_bytes(firstboot.patch_cmdline(cmdline.read_text("utf-8")).encode("utf-8"))


# ---------------------------------------------------------------- entry points

def selfcheck() -> int:
    cfg = firstboot.sample_config()
    text = "\n".join([
        "=== firstrun.sh ===", firstboot.render_firstrun(cfg),
        "=== projection5000-provision.sh ===", firstboot.render_provision(cfg),
        "=== cmdline.txt ===", firstboot.patch_cmdline("console=tty1 root=PARTUUID=x rootfstype=ext4 rootwait\n"),
    ])
    if getattr(sys, "frozen", False):
        # --windowed exe has no console: leave the output next to the exe, and also print it when
        # launched from a console (AttachConsole succeeds when the parent process has one).
        Path(sys.executable).with_name("selfcheck.txt").write_text(text, "utf-8")
        if ctypes.windll.kernel32.AttachConsole(-1):
            sys.stdout = open("CONOUT$", "w", encoding="utf-8")
    if sys.stdout:
        print(text)
        sys.stdout.flush()
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selfcheck" in argv:
        return selfcheck()
    dry_run = "--dry-run" in argv
    # A dry run never opens the disk, so it does not need (or ask for) elevation.
    if not dry_run and not ensure_admin(argv):
        return 1
    root = tk.Tk()
    App(root, dry_run=dry_run)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
