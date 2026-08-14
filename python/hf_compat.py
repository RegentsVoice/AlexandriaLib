"""Strip deprecated huggingface_hub kwargs used by older callers (ruaccent/transformers)."""
from __future__ import annotations

import os

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

_DEPRECATED = ("local_dir_use_symlinks",)


def _strip_kwargs(kwargs: dict) -> dict:
    for k in _DEPRECATED:
        kwargs.pop(k, None)
    return kwargs


def apply() -> None:
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

    # file_download module often holds the real implementations
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
