"""ONNX Runtime backend for CUDA-free inference (CPU, Qualcomm GPU/NPU).

The exported graph covers exactly one fixed-size tile: the tiling, flip TTA,
multi-scale fusion, thresholds, and component filters stay in
``inference.py`` so every backend shares the calibrated scoring path.

Precision per device:

* ``gpu`` - Qualcomm Adreno through QNN, FP32 (matches PyTorch FP32).
* ``cpu`` - ONNX Runtime CPU kernels, FP32 (matches PyTorch FP32).
* ``npu`` - Qualcomm Hexagon HTP through QNN, FP16 (the same numeric regime
  as the CUDA FP16 autocast used for calibration).
"""

from __future__ import annotations

import hashlib
import json
import logging
import platform
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

import numpy as np
import torch

LOGGER = logging.getLogger(__name__)

EXPORT_FORMAT_VERSION = 1
DEVICES = ("gpu", "npu", "cpu")
# FP32 devices first: the GPU is both fast and bit-for-bit close to the
# PyTorch reference, while the NPU trades a small FP16 error for speed.
AUTO_DEVICE_ORDER = ("gpu", "npu", "cpu")
QNN_EP = "QNNExecutionProvider"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def default_onnx_path(checkpoint_path: str | Path, checkpoint_sha256: str, tile_size: int) -> Path:
    checkpoint_path = Path(checkpoint_path)
    return (
        checkpoint_path.parent
        / "onnx"
        / f"{checkpoint_path.stem}-{checkpoint_sha256[:12]}-tile{tile_size}.onnx"
    )


def _metadata_path(onnx_path: Path) -> Path:
    return onnx_path.with_suffix(".json")


@contextmanager
def _static_position_embedding(backbone: torch.nn.Module, tile_size: int) -> Iterator[None]:
    """Freeze timm's dynamic position-embedding resize for one tile size.

    ``resample_abs_pos_embed`` uses antialiased bicubic interpolation, which
    has no ONNX operator. The tile size is fixed by calibration, so the resized
    table is computed once in PyTorch (identical values) and baked in.
    """
    import timm.models.vision_transformer as vision_transformer

    patch_height, patch_width = backbone.patch_embed.patch_size
    grid = (-(-tile_size // patch_height), -(-tile_size // patch_width))
    original = vision_transformer.resample_abs_pos_embed
    with torch.no_grad():
        table = original(
            backbone.pos_embed,
            new_size=grid,
            old_size=backbone.patch_embed.grid_size,
            num_prefix_tokens=0 if backbone.no_embed_class else backbone.num_prefix_tokens,
        ).detach()

    def resample(*args, new_size, **kwargs):
        if tuple(new_size) != grid:
            raise RuntimeError(f"export traced grid {tuple(new_size)}, expected {grid}")
        return table

    vision_transformer.resample_abs_pos_embed = resample
    try:
        yield
    finally:
        vision_transformer.resample_abs_pos_embed = original


class _OutputTuple(torch.nn.Module):
    def __init__(self, model: torch.nn.Module, names: Sequence[str]) -> None:
        super().__init__()
        self.model = model
        self.names = tuple(names)

    def forward(self, images: torch.Tensor) -> tuple[torch.Tensor, ...]:
        outputs = self.model(images)
        return tuple(outputs[name] for name in self.names)


def export_onnx(
    checkpoint_path: str | Path,
    output_path: str | Path | None = None,
    *,
    tile_size: int = 768,
    opset: int = 17,
    verify: bool = True,
) -> Path:
    """Export one tile of a DINOv2 checkpoint and record hash-bound metadata."""
    from .model import load_checkpoint

    checkpoint_path = Path(checkpoint_path)
    checkpoint_sha256 = _sha256(checkpoint_path)
    output = Path(
        output_path or default_onnx_path(checkpoint_path, checkpoint_sha256, tile_size)
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    model, checkpoint = load_checkpoint(str(checkpoint_path), "cpu")
    if not hasattr(model.backbone, "pos_embed"):
        raise ValueError("ONNX export currently supports the DINOv2 checkpoints only")
    example = torch.randn(
        1, 3, tile_size, tile_size, generator=torch.Generator().manual_seed(0)
    ) * 0.8
    with torch.inference_mode():
        reference = model(example)
    names = [name for name, value in reference.items() if value.ndim == 4]
    if "case_logits" in reference:
        names.append("case_logits")
    with _static_position_embedding(model.backbone, tile_size):
        torch.onnx.export(
            _OutputTuple(model, names).eval(),
            (example,),
            str(output),
            input_names=["image"],
            output_names=names,
            opset_version=opset,
            dynamo=False,
            do_constant_folding=True,
        )
    metadata: dict[str, object] = {
        "format_version": EXPORT_FORMAT_VERSION,
        "checkpoint_sha256": checkpoint_sha256,
        "checkpoint_bytes": checkpoint_path.stat().st_size,
        "architecture": checkpoint.get(
            "architecture", checkpoint.get("config", {}).get("architecture")
        ),
        "classes": list(checkpoint["classes"]),
        "tile_size": tile_size,
        "input": "image",
        "outputs": names,
        "role_split": hasattr(model, "triage_presence_head"),
        "opset": opset,
        "onnx_sha256": _sha256(output),
        "exported_with": {
            "torch": torch.__version__,
            "platform": platform.platform(),
            "machine": platform.machine(),
        },
    }
    if verify:
        session = _create_session(output, "cpu")
        produced = session.run(None, {"image": example.numpy()})
        metadata["cpu_parity_max_abs_logit_error"] = {
            name: float(np.abs(value - reference[name].numpy()).max())
            for name, value in zip(names, produced)
        }
    _metadata_path(output).write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return output


def _qnn_devices(device: str):
    import onnxruntime as ort

    _register_qnn()
    wanted = {"gpu": "GPU", "npu": "NPU"}[device]
    return [
        entry
        for entry in ort.get_ep_devices()
        if entry.ep_name == QNN_EP and entry.device.type.name == wanted
    ]


_QNN_REGISTERED = False


def _register_qnn() -> bool:
    """Register the onnxruntime-qnn plugin execution provider once."""
    global _QNN_REGISTERED
    if _QNN_REGISTERED:
        return True
    try:
        import onnxruntime as ort
        import onnxruntime_qnn
    except ImportError:
        return False
    try:
        ort.register_execution_provider_library(QNN_EP, onnxruntime_qnn.get_library_path())
    except Exception as exc:  # already registered or unusable driver
        if "already" not in str(exc).lower():
            LOGGER.warning("QNN execution provider unavailable: %s", exc)
            return False
    _QNN_REGISTERED = True
    return True


def available_devices() -> list[str]:
    devices = [device for device in ("gpu", "npu") if _register_qnn() and _qnn_devices(device)]
    return [*devices, "cpu"]


def _valid_context_cache(context_cache: Path, source_sha256: str) -> bool:
    """Accept a compiled NPU graph only if it is bound to the verified export."""
    record = context_cache.with_suffix(".json")
    if not context_cache.is_file() or not record.is_file():
        return False
    try:
        metadata = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        metadata.get("source_onnx_sha256") == source_sha256
        and metadata.get("context_sha256") == _sha256(context_cache)
    )


def _create_session(
    model_path: Path,
    device: str,
    *,
    context_cache: Path | None = None,
    source_sha256: str | None = None,
):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    if device == "cpu":
        return ort.InferenceSession(
            str(model_path), options, providers=["CPUExecutionProvider"]
        )
    devices = _qnn_devices(device)
    if not devices:
        raise RuntimeError(f"no Qualcomm {device.upper()} is exposed by onnxruntime-qnn")
    # Refuse silent partial offload: every node must run on the accelerator
    # so the reported device and the measured latency are truthful.
    options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    provider_options: dict[str, str] = {}
    source = model_path
    write_cache = False
    if device == "npu":
        # HTP defaults to integer quantization; FP16 keeps the unquantized
        # FP32 graph within the same error regime as CUDA FP16 autocast.
        provider_options = {
            "htp_performance_mode": "burst",
            "enable_htp_fp16_precision": "1",
        }
        if context_cache is not None and source_sha256 is not None:
            if _valid_context_cache(context_cache, source_sha256):
                source = context_cache
            else:
                # Compiling for HTP takes ~1 minute; persist the compiled graph.
                context_cache.unlink(missing_ok=True)
                options.add_session_config_entry("ep.context_enable", "1")
                options.add_session_config_entry("ep.context_file_path", str(context_cache))
                options.add_session_config_entry("ep.context_embed_mode", "1")
                write_cache = True
    options.add_provider_for_devices(devices, provider_options)
    session = ort.InferenceSession(str(source), options)
    if write_cache and context_cache is not None and context_cache.is_file():
        context_cache.with_suffix(".json").write_text(
            json.dumps(
                {
                    "source_onnx_sha256": source_sha256,
                    "context_sha256": _sha256(context_cache),
                    "precision": "fp16",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    return session


class OnnxTileModel:
    """Callable stand-in for the PyTorch model on one calibrated tile size.

    Returns the same logits dict as ``model(tile)`` so ``inference.py`` needs
    no backend-specific tiling logic. Precision is fixed by the device, so the
    PyTorch autocast flag is ignored (``manages_precision``).
    """

    manages_precision = True

    def __init__(
        self,
        onnx_path: str | Path,
        *,
        device: str = "auto",
        expected_checkpoint_sha256: str | None = None,
    ) -> None:
        self.onnx_path = Path(onnx_path)
        metadata_path = _metadata_path(self.onnx_path)
        if not self.onnx_path.is_file() or not metadata_path.is_file():
            raise FileNotFoundError(f"missing ONNX export or metadata: {self.onnx_path}")
        self.metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if self.metadata.get("format_version") != EXPORT_FORMAT_VERSION:
            raise ValueError("ONNX export format is outdated; re-export the checkpoint")
        if (
            expected_checkpoint_sha256 is not None
            and self.metadata["checkpoint_sha256"] != expected_checkpoint_sha256
        ):
            raise ValueError("ONNX export was produced from a different checkpoint")
        if _sha256(self.onnx_path) != self.metadata["onnx_sha256"]:
            raise ValueError("ONNX export failed its integrity check")
        self.tile_size = int(self.metadata["tile_size"])
        self.output_names = list(self.metadata["outputs"])
        self.classes = list(self.metadata["classes"])
        self.num_classes = len(self.classes)
        if self.metadata.get("role_split"):
            # ``predict_profile_probabilities`` detects role-split models by
            # this attribute; the graph always emits both branches.
            self.triage_presence_head = True

        candidates = AUTO_DEVICE_ORDER if device == "auto" else (device,)
        if any(candidate not in DEVICES for candidate in candidates):
            raise ValueError(f"device must be 'auto' or one of {DEVICES}")
        errors = []
        for candidate in candidates:
            try:
                self.session = _create_session(
                    self.onnx_path,
                    candidate,
                    context_cache=self.onnx_path.with_name(
                        f"{self.onnx_path.stem}.npu-fp16.ctx.onnx"
                    ),
                    source_sha256=self.metadata["onnx_sha256"],
                )
            except Exception as exc:
                errors.append(f"{candidate}: {exc}")
                LOGGER.warning("ONNX %s backend unavailable: %s", candidate, exc)
                continue
            self.device = candidate
            break
        else:
            raise RuntimeError("no ONNX Runtime device could load the model: " + "; ".join(errors))
        self.precision = "fp16" if self.device == "npu" else "fp32"
        self.input_name = self.session.get_inputs()[0].name

    @property
    def description(self) -> str:
        return f"onnx:{self.device}:{self.precision}"

    def __call__(self, images: torch.Tensor) -> dict[str, torch.Tensor]:
        if images.ndim != 4 or tuple(images.shape[-2:]) != (self.tile_size, self.tile_size):
            raise ValueError(
                f"ONNX tile model expects Nx3x{self.tile_size}x{self.tile_size} input, "
                f"got {tuple(images.shape)}"
            )
        batch = np.ascontiguousarray(images.detach().cpu().numpy(), dtype=np.float32)
        results = [
            self.session.run(None, {self.input_name: batch[index : index + 1]})
            for index in range(batch.shape[0])
        ]
        return {
            name: torch.from_numpy(np.concatenate([row[position] for row in results]))
            for position, name in enumerate(self.output_names)
        }

    def forward_roles(
        self,
        images: torch.Tensor,
        *,
        include_main: bool = True,
        include_triage: bool = True,
    ) -> dict[str, torch.Tensor]:
        outputs = self(images)
        if not include_main:
            outputs = {k: v for k, v in outputs.items() if k.startswith("triage_")}
        if not include_triage:
            outputs = {k: v for k, v in outputs.items() if not k.startswith("triage_")}
        return outputs


def load_onnx_model(
    checkpoint_path: str | Path,
    *,
    tile_size: int,
    device: str = "auto",
    checkpoint_sha256: str | None = None,
) -> OnnxTileModel:
    """Load (exporting on first use) the ONNX tile model bound to a checkpoint."""
    checkpoint_sha256 = checkpoint_sha256 or _sha256(Path(checkpoint_path))
    path = default_onnx_path(checkpoint_path, checkpoint_sha256, tile_size)
    if not path.is_file() or not _metadata_path(path).is_file():
        LOGGER.warning("exporting %s to ONNX (one-time, ~30 s)", checkpoint_path)
        export_onnx(checkpoint_path, path, tile_size=tile_size)
    return OnnxTileModel(path, device=device, expected_checkpoint_sha256=checkpoint_sha256)


def main(argv: Sequence[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Export a checkpoint tile model to ONNX")
    parser.add_argument("checkpoint")
    parser.add_argument("--output")
    parser.add_argument("--tile-size", type=int, default=768)
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args(argv)
    path = export_onnx(
        args.checkpoint, args.output, tile_size=args.tile_size, verify=not args.no_verify
    )
    print(_metadata_path(path).read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
