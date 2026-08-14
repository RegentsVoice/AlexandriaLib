"""HF/torch download helpers: quiet xet, strip deprecated kwargs, single-line progress."""
from __future__ import annotations

import logging
import os
import sys
import threading
import time
from pathlib import Path

os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "0"
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("RUST_LOG", "error")
os.environ.setdefault("HF_XET_LOG_LEVEL", "error")

_DEPRECATED = ("local_dir_use_symlinks",)


def _strip_kwargs(kwargs: dict) -> dict:
    for k in _DEPRECATED:
        kwargs.pop(k, None)
    return kwargs


def _enable_windows_vt() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        for handle_id in (-11, -12):
            handle = kernel32.GetStdHandle(handle_id)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | 0x0001 | 0x0002 | 0x0004)
    except Exception:
        pass


def _write_bar(msg: str) -> None:
    try:
        sys.stderr.write("\r" + msg[:110].ljust(110))
        sys.stderr.flush()
    except Exception:
        pass


def _end_bar() -> None:
    try:
        sys.stderr.write("\n")
        sys.stderr.flush()
    except Exception:
        pass


def patch_torch_hub_progress() -> None:
    """Disable torch tqdm spam; show one updating line with downloaded MB."""
    try:
        import torch.hub as hub
    except Exception:
        return

    if getattr(hub.download_url_to_file, "_al_patched", False):
        return

    _orig = hub.download_url_to_file

    def download_url_to_file(url, dst, hash_prefix=None, progress=True):
        name = str(url).rstrip("/").split("/")[-1]
        dst_p = Path(str(dst))
        parent = dst_p.parent
        parent.mkdir(parents=True, exist_ok=True)
        stop = threading.Event()

        def _partial_size() -> int:
            size = 0
            try:
                if dst_p.is_file():
                    size = max(size, dst_p.stat().st_size)
                for p in parent.glob("*"):
                    if not p.is_file():
                        continue
                    n = p.name
                    if n.startswith(dst_p.name) or n.endswith(".partial") or n.endswith(".tmp"):
                        try:
                            size = max(size, p.stat().st_size)
                        except OSError:
                            pass
            except OSError:
                pass
            return size

        def watcher():
            while not stop.wait(0.4):
                size = _partial_size()
                if size > 0:
                    _write_bar(f"AL: {name}  {size/1024/1024:6.1f} MB")
                else:
                    _write_bar(f"AL: downloading {name}...")

        th = threading.Thread(target=watcher, daemon=True)
        if progress:
            th.start()
        try:
            result = _orig(url, str(dst), hash_prefix=hash_prefix, progress=False)
            if progress:
                final = _partial_size()
                if final:
                    _write_bar(f"AL: {name}  {final/1024/1024:6.1f} MB  done")
                else:
                    _write_bar(f"AL: {name}  done")
                _end_bar()
            return result
        except Exception:
            if progress:
                _end_bar()
            raise
        finally:
            stop.set()

    download_url_to_file._al_patched = True  # type: ignore[attr-defined]
    hub.download_url_to_file = download_url_to_file


def _patch_tqdm() -> None:
    _enable_windows_vt()
    try:
        import tqdm as tqdm_mod
        import tqdm.std as tqdm_std
    except ImportError:
        return

    _Base = tqdm_std.tqdm

    class _TqdmBar(_Base):
        @staticmethod
        def status_printer(file):
            def print_status(s):
                _write_bar(s)

            return print_status

        def __init__(self, *args, **kwargs):
            kwargs.setdefault("file", sys.stderr)
            kwargs.setdefault("dynamic_ncols", False)
            kwargs.setdefault("ncols", 88)
            kwargs.setdefault("mininterval", 0.3)
            kwargs.setdefault("leave", True)
            kwargs.setdefault("ascii", True)
            super().__init__(*args, **kwargs)

        def close(self):
            super().close()
            _end_bar()

    tqdm_mod.tqdm = _TqdmBar
    tqdm_std.tqdm = _TqdmBar
    try:
        import tqdm.auto as tqdm_auto

        tqdm_auto.tqdm = _TqdmBar
    except Exception:
        pass

    try:
        from huggingface_hub.utils import enable_progress_bars

        enable_progress_bars()
    except Exception:
        pass


def _route_hf_logs() -> None:
    class _StdoutHandler(logging.StreamHandler):
        def __init__(self):
            super().__init__(stream=sys.stdout)

    for name in ("huggingface_hub", "huggingface_hub.file_download"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.addHandler(_StdoutHandler())
        lg.setLevel(logging.INFO)
        lg.propagate = False


def apply() -> None:
    _enable_windows_vt()
    _patch_tqdm()
    _route_hf_logs()

    try:
        import huggingface_hub as hub
    except ImportError:
        return

    for name in (
        "hf_hub_download",
        "snapshot_download",
        "try_to_load_from_cache",
    ):
        fn = getattr(hub, name, None)
        if not callable(fn) or getattr(fn, "_al_patched", False):
            continue

        def _wrap(orig):
            def wrapped(*args, **kwargs):
                return orig(*args, **_strip_kwargs(kwargs))

            wrapped._al_patched = True  # type: ignore[attr-defined]
            return wrapped

        setattr(hub, name, _wrap(fn))

    try:
        from huggingface_hub import file_download as fd

        for name in ("hf_hub_download", "snapshot_download"):
            fn = getattr(fd, name, None)
            if not callable(fn) or getattr(fn, "_al_patched", False):
                continue

            def _wrap2(orig):
                def wrapped(*args, **kwargs):
                    return orig(*args, **_strip_kwargs(kwargs))

                wrapped._al_patched = True  # type: ignore[attr-defined]
                return wrapped

            setattr(fd, name, _wrap2(fn))
            if hasattr(hub, name):
                setattr(hub, name, getattr(fd, name))
    except Exception:
        pass


apply()
