"""HF download: strip deprecated kwargs, quieter xet, progress on stdout (not red stderr)."""
from __future__ import annotations

import logging
import os
import sys

# progress bars ON
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "0"
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# mute hf_xet JSON spam
os.environ.setdefault("RUST_LOG", "error")
os.environ.setdefault("HF_XET_LOG_LEVEL", "error")

_DEPRECATED = ("local_dir_use_symlinks",)


def _strip_kwargs(kwargs: dict) -> dict:
    for k in _DEPRECATED:
        kwargs.pop(k, None)
    return kwargs


def _route_progress_to_stdout() -> None:
    """PowerShell paints stderr red — send tqdm + HF log lines to stdout."""
    try:
        import tqdm as tqdm_mod

        _Tqdm = tqdm_mod.tqdm

        class _TqdmOut(_Tqdm):
            def __init__(self, *args, **kwargs):
                kwargs.setdefault("file", sys.stdout)
                kwargs.setdefault("dynamic_ncols", True)
                super().__init__(*args, **kwargs)

        tqdm_mod.tqdm = _TqdmOut
        try:
            import tqdm.auto as tqdm_auto

            tqdm_auto.tqdm = _TqdmOut
        except Exception:
            pass
    except Exception:
        pass

    # HF "Downloading …" messages go through logging → often stderr
    class _StdoutHandler(logging.StreamHandler):
        def __init__(self):
            super().__init__(stream=sys.stdout)

    for name in ("huggingface_hub", "huggingface_hub.file_download", "httpx"):
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
    _route_progress_to_stdout()

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
