"""HF download: strip deprecated kwargs, quieter xet, single-line progress bar."""
from __future__ import annotations

import logging
import os
import sys

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
    """Allow \\r progress updates in Windows consoles (PowerShell / cmd)."""
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


def _route_progress() -> None:
    _enable_windows_vt()

    # tqdm needs a TTY that supports \\r — stderr is reliable on Windows.
    bar_file = sys.stderr if sys.stderr.isatty() else (
        sys.stdout if sys.stdout.isatty() else sys.stderr
    )

    try:
        import tqdm as tqdm_mod

        _Tqdm = tqdm_mod.tqdm

        class _TqdmBar(_Tqdm):
            def __init__(self, *args, **kwargs):
                kwargs["file"] = bar_file
                kwargs.setdefault("dynamic_ncols", True)
                kwargs.setdefault("mininterval", 0.3)
                kwargs.setdefault("maxinterval", 2.0)
                kwargs.setdefault("leave", True)
                super().__init__(*args, **kwargs)

        tqdm_mod.tqdm = _TqdmBar
        try:
            import tqdm.auto as tqdm_auto

            tqdm_auto.tqdm = _TqdmBar
        except Exception:
            pass
    except Exception:
        pass

    class _StdoutHandler(logging.StreamHandler):
        def __init__(self):
            super().__init__(stream=sys.stdout)

    for name in ("huggingface_hub", "huggingface_hub.file_download"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.addHandler(_StdoutHandler())
        lg.setLevel(logging.INFO)
        lg.propagate = False

    try:
        from huggingface_hub.utils import enable_progress_bars

        enable_progress_bars()
    except Exception:
        pass


def apply() -> None:
    _route_progress()

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
