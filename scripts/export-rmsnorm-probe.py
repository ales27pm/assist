#!/usr/bin/env python3
"""Export small, synthetic Core AI RMSNorm fixtures for the native diagnostic.

Use the reviewed Torch 2.9.0 / coreai-torch 0.4.3 / coreai-core 1.0.0b3
environment. The output directory must not exist. No model weights, native
runtime, specialization or backend selection are used. Example on Linux:

  systemd-run --user --wait --pipe --collect -p MemoryMax=2G \
    -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=128 \
    -p RuntimeMaxSec=120 -p LimitCORE=0 \
    --setenv=OMP_NUM_THREADS=1 --setenv=MKL_NUM_THREADS=1 \
    --setenv=OPENBLAS_NUM_THREADS=1 /path/to/python3 -I \
    scripts/export-rmsnorm-probe.py --output /new/NumericalProbe \
    --require-limits --report /new/private-export-report.json

Reread an existing output without modifying it using --verify. The manifest
contains raw little-endian Float16 arrays in logical row-major order. Its
SHA256 identifies main.mlirb, not a compiled/native executable. The six shapes
match the shipping q8 RMSNorm boundaries; the data and scales are synthetic.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
from importlib.metadata import version
import inspect
import json
from pathlib import Path
import re
import resource
import sys
import time

import numpy as np
import torch
from torch import nn
from coreai.authoring import AIModelAsset
from coreai._compiler.ir import ArrayAttr, DenseElementsAttr, DenseResourceElementsAttr, DictAttr, StringAttr
from coreai._compiler._mlir_libs._coreaiIR import _bindings
from coreai_torch import ExternalizeSpec, TorchConverter, get_decomp_table
from coreai_torch.composite_ops import RMSNormImpl


EPS = 1e-6
ASSET = "RMSNormProbe.aimodel"
SHAPES = ((256, 8), (256, 1), (512, 8), (512, 1), (1536, 1), (256, 35))
REFERENCE = "float64_rmsnorm_then_float16"
ROW_LABELS = ("signed_zero", "overflow_1733", "epsilon_sensitive", "typical",
              "small_and_subnormal", "sparse_1733", "mixed_magnitudes", "nonuniform")
PINS = {"torch": "2.9.0+cpu", "coreai-core": "1.0.0b3", "coreai-torch": "0.4.3"}
# Historical resources remain immutable. Their old generator did not record
# metadata.json, so its exact reviewed metadata bytes are pinned here instead.
LEGACY_GENERATOR_SHA256 = "49345988e2b01f0a5e624270cfa41cc6ca0563237f33384f014a5f80d8dd3ec0"
LEGACY_METADATA_SHA256 = "c3e05d4071e43d95ed140a9095a94714477cf1b6f121a199ff75842416c9c773"
SCALE_STORAGE = "float16-le; promoted exactly to float32 at the call site"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def verify_metadata(path, expected_digest):
    require(sha(path) == expected_digest, "Asset metadata SHA256 mismatch")
    metadata = json.loads(path.read_text())
    require(set(metadata) == {"assetVersion", "producer", "creationDate"}
            and metadata["assetVersion"] == "2.0"
            and metadata["producer"] == "coreai-core " + PINS["coreai-core"]
            and isinstance(metadata["creationDate"], str)
            and re.fullmatch(r"\d{8}T\d{6}Z", metadata["creationDate"]) is not None,
            "Unexpected asset metadata contract")


def verify_provenance(provenance, output, checks):
    fixed = {"schemaVersion": 1, "kind": "assistRMSNormFixtureProvenance",
             "generator": "scripts/export-rmsnorm-probe.py", "epsilon": EPS,
             "rowPatterns": list(ROW_LABELS), "scaleStorage": SCALE_STORAGE,
             "modelWeightsLoaded": False, "runtimeOrSpecializationInvoked": False,
             "nativeCorrectnessVerified": False, "aneExecutionVerified": False}
    require(all(type(provenance.get(key)) is type(value) and provenance[key] == value
                for key, value in fixed.items()), "Fixed generator provenance changed")
    require(provenance["generatorSHA256"] in {sha(Path(__file__)), LEGACY_GENERATOR_SHA256},
            "Generator changed since fixture creation")
    metadata_digest = provenance.get("assetMetadataSHA256")
    legacy = provenance["generatorSHA256"] == LEGACY_GENERATOR_SHA256
    require(metadata_digest is not None or legacy, "Missing asset metadata provenance")
    require(not legacy or metadata_digest in (None, LEGACY_METADATA_SHA256), "Historical asset metadata provenance changed")
    verify_metadata(output / ASSET / "metadata.json", metadata_digest if metadata_digest is not None else LEGACY_METADATA_SHA256)
    require(json.dumps(provenance["eagerChecks"], sort_keys=True, allow_nan=False)
            == json.dumps(checks, sort_keys=True, allow_nan=False), "Recorded eager checks differ from recomputed results")
    expected_scales = [{"file": f"scale_{width}.f16", "width": width,
                        "sha256": sha(output / f"scale_{width}.f16")}
                       for width in sorted({width for width, _ in SHAPES})]
    require(provenance["scales"] == expected_scales, "Scale provenance mismatch")
    allowed = set(fixed) | {"generatorSHA256", "versions", "sourceSHA256", "scales", "eagerChecks"}
    if metadata_digest is not None:
        allowed.add("assetMetadataSHA256")
    require(set(provenance) == allowed, "Unexpected generator provenance fields")


def write_f16(path, array):
    data = np.asarray(array, dtype="<f2", order="C").tobytes(order="C")
    with path.open("xb") as stream:
        stream.write(data)


def read_f16(path, shape):
    require(path.is_file() and not path.is_symlink(), f"Expected regular fixture: {path.name}")
    require(path.stat().st_size == 2 * int(np.prod(shape)), f"Wrong fixture length: {path.name}")
    result = np.frombuffer(path.read_bytes(), dtype="<f2").reshape(shape).copy()
    require(np.isfinite(result).all(), f"Nonfinite fixture: {path.name}")
    return result


def fixture_input(width, heads):
    """Eight fixed token rows repeated without changes across the head axis."""
    j = np.arange(width, dtype=np.int64)
    rows = np.empty((8, width), dtype=np.float64)
    rows[0] = np.where(j % 2 == 0, 0.0, -0.0)
    rows[1] = np.array([1733, -1536, 1024, -896, 512, -384, 256, -128])[j % 8]
    rows[2] = np.array([1e-4, -2e-4, 0, 3e-4, -4e-4, 1e-5, -1e-5, 0])[j % 8]
    rows[3] = -3.125 + j * (5.875 / (width - 1))
    rows[4] = np.array([2**-24, -2**-24, 2**-14, -2**-14,
                        2**-10, -2**-10, 0, 1e-3])[j % 8]
    rows[5] = np.where(j == 0, 1733.0, 0.0)
    rows[6] = np.array([0.125, -0.5, 1.75, -2, 3.5, -4.25, 0.75, -1.25])[j % 8]
    rows[7] = ((j * 37) % 251 - 125) / 32.0
    return np.broadcast_to(rows[None, :, None, :], (1, 8, heads, width)).astype("<f2").copy()


def fixture_scale(width):
    # Integer arithmetic followed by F16 storage makes the scale reproducible.
    values = 0.5 + ((np.arange(width, dtype=np.int64) * 29) % 97) / 64.0
    values[:8] = [1.5, 0.75, 1.25, 0.5, 1.375, 0.625, 2.25, 0]
    return values.astype("<f2")


def reference64(stored_input, stored_scale):
    """Independent NumPy oracle; its inputs have already been stored as F16."""
    x = stored_input.astype(np.float64)
    # F16 -> F32 is exact. Match the learned scale's promotion before using F64.
    scale = stored_scale.astype(np.float32).astype(np.float64)
    normalized = x / np.sqrt(np.mean(x * x, axis=-1, keepdims=True, dtype=np.float64) + EPS)
    return (normalized * scale).astype("<f2")


def half_ulp(actual, expected):
    require(np.isfinite(actual).all() and np.isfinite(expected).all(), "Cannot compare nonfinite outputs")
    def ordered(array):
        bits = np.asarray(array, dtype="<f2", order="C").view("<u2").astype(np.int32)
        magnitude = bits & 32767
        return np.where(bits & 32768, 32768 - magnitude, 32768 + magnitude)
    return int(np.max(np.abs(ordered(actual) - ordered(expected))))


class WeightedNorm(nn.Module):
    def __init__(self, stored_scale):
        super().__init__()
        self.weight = nn.Parameter(torch.from_numpy(stored_scale.copy()), requires_grad=False)
        self.norm = RMSNormImpl(eps=EPS)

    def forward(self, input):
        return self.norm(input, self.weight.float())


class OnesNorm(nn.Module):
    def __init__(self, width):
        super().__init__()
        self.register_buffer("ones", torch.ones(width, dtype=torch.float32), persistent=False)
        self.norm = RMSNormImpl(eps=EPS)

    def forward(self, input):
        return self.norm(input, self.ones)


def eager_check(module, stored_input, stored_scale, expected):
    with torch.inference_mode():
        actual_tensor = module(torch.from_numpy(stored_input.copy()))
    require(actual_tensor.dtype == torch.float16, "Eager output is not F16")
    actual = actual_tensor.numpy()
    max_ulp = half_ulp(actual, expected)
    require(max_ulp <= 1, f"Public eager RMSNorm differs by {max_ulp} F16 ULP")
    # The overflow row must distinguish this oracle from naive half squaring.
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        square = np.multiply(stored_input, stored_input, dtype=np.float16)
        mean = np.mean(square, axis=-1, keepdims=True, dtype=np.float16)
        denominator = np.sqrt(np.add(mean, np.float16(EPS), dtype=np.float16), dtype=np.float16)
        naive = np.multiply(np.divide(stored_input, denominator, dtype=np.float16),
                            stored_scale, dtype=np.float16)
    overflow_nonzero = np.count_nonzero(expected[:, 1])
    require(overflow_nonzero > 0 and np.count_nonzero(naive[:, 1]) == 0,
            "The overflow row no longer detects naive half squaring")
    rounded_eps = (stored_input.astype(np.float64) / np.sqrt(
        np.mean(stored_input.astype(np.float64)**2, axis=-1, keepdims=True)
        + float(np.float16(EPS))) * stored_scale.astype(np.float64)).astype("<f2")
    require(half_ulp(expected[:, 2], rounded_eps[:, 2]) > 1,
            "The small row no longer detects premature F16 epsilon rounding")
    return {"maxF16ULP": max_ulp, "finite": True,
            "naiveHalfOverflowLostNonzeroElements": int(overflow_nonzero),
            "prematureHalfEpsilonMaxULP": half_ulp(expected[:, 2], rounded_eps[:, 2])}


def plans():
    return [(f"rms_q8_{width}_{heads}_{mode}", (1, 8, heads, width), mode)
            for width, heads in SHAPES for mode in ("weighted", "ones")]


def export(output):
    output.mkdir(parents=True, exist_ok=False)
    converter = TorchConverter(mode=TorchConverter.Mode.RELEASE)
    spec = ExternalizeSpec(target_class=RMSNormImpl, composite_op_name="rms_norm",
                           composite_attrs=["axes", "eps"])
    scales = {}
    for width in sorted({width for width, _ in SHAPES}):
        path = output / f"scale_{width}.f16"
        write_f16(path, fixture_scale(width))
        scales[width] = read_f16(path, (width,))
    fixtures, checks, models = [], [], []
    for name, shape, mode in plans():
        input_name, expected_name = f"{name}.input.f16", f"{name}.expected.f16"
        write_f16(output / input_name, fixture_input(shape[-1], shape[-2]))
        stored_input = read_f16(output / input_name, shape)
        scale = scales[shape[-1]] if mode == "weighted" else np.ones(shape[-1], dtype="<f2")
        expected = reference64(stored_input, scale)
        write_f16(output / expected_name, expected)
        expected = read_f16(output / expected_name, shape)
        module = (WeightedNorm(scale) if mode == "weighted" else OnesNorm(shape[-1])).eval()
        models.append((module, scale.copy(), mode))
        checks.append({"id": name, **eager_check(module, stored_input, scale, expected)})
        sample = torch.from_numpy(stored_input.copy())
        def export_fn(target, sample=sample):
            with torch.no_grad():
                return torch.export.export(target, (sample,)).run_decompositions(get_decomp_table())
        converter.add_pytorch_module(module, export_fn=export_fn, externalize_modules=[spec],
                                     input_names=["input"], output_names=["output"], entrypoint_name=name)
        fixtures.append({"id": name, "function": name, "inputFile": input_name,
                         "inputSHA256": sha(output / input_name), "expectedFile": expected_name,
                         "expectedSHA256": sha(output / expected_name), "shape": list(shape),
                         "reference": REFERENCE, "maxULP": 1})
    program = converter.to_coreai()
    program.save_asset(output / ASSET)
    converter.clear()
    for module, scale, mode in models:
        require(not any(hasattr(child, "_original_forward") for child in module.modules()),
                "Externalization did not restore the eager modules")
        if mode == "weighted":
            require(module.weight.dtype == torch.float16
                    and np.array_equal(module.weight.detach().numpy().view(np.uint16), scale.view(np.uint16)),
                    "Export changed the original F16 Parameter")
        else:
            require(not list(module.parameters()) and not module.state_dict(),
                    "Ones normalization acquired persistent or learned state")
    manifest = {"schemaVersion": 1, "kind": "assistRMSNormFixtures", "asset": ASSET,
                "assetSHA256": sha(output / ASSET / "main.mlirb"), "fixtures": fixtures}
    write_json(output / "manifest.json", manifest)
    provenance = {"schemaVersion": 1, "kind": "assistRMSNormFixtureProvenance",
                  "generator": "scripts/export-rmsnorm-probe.py", "generatorSHA256": sha(Path(__file__)),
                  "assetMetadataSHA256": sha(output / ASSET / "metadata.json"),
                  "versions": {name: version(name) for name in (*PINS, "numpy")},
                  "sourceSHA256": {f"{obj.__module__}.{obj.__name__}": sha(Path(inspect.getfile(obj)))
                                   for obj in (TorchConverter, ExternalizeSpec, RMSNormImpl)},
                  "epsilon": EPS, "rowPatterns": list(ROW_LABELS),
                  "scaleStorage": SCALE_STORAGE,
                  "scales": [{"file": f"scale_{width}.f16", "width": width,
                              "sha256": sha(output / f"scale_{width}.f16")} for width in scales],
                  "eagerChecks": checks, "modelWeightsLoaded": False,
                  "runtimeOrSpecializationInvoked": False, "nativeCorrectnessVerified": False,
                  "aneExecutionVerified": False}
    write_json(output / "generator-provenance.json", provenance)
    return verify(output)


def inspect_asset(asset_path, expected):
    asset = AIModelAsset.load(asset_path)
    summary = asset.summary(include_statistics=False)
    require(set(summary.function_names) == set(expected), "Asset public function set changed")
    graphs = {}
    def walk(op):
        if str(op.name) == "coreai.graph":
            name = StringAttr(op.attributes["sym_name"]).value
            require(name not in graphs, "Duplicate graph symbol")
            blocks = [block for region in op.regions for block in region.blocks]
            require(len(blocks) == 1, "Unexpected graph block count")
            children = [child.operation for child in blocks[0].operations]
            args = ArrayAttr(op.attributes["arg_attrs"]) if "arg_attrs" in op.attributes else []
            argument_names = [StringAttr(DictAttr(arg)["coreai.name"]).value
                              if "coreai.name" in DictAttr(arg) else None for arg in args]
            graphs[name] = {"op": op, "children": children,
                            "inputs": [str(arg.type) for arg in blocks[0].arguments],
                            "argumentNames": argument_names,
                            "outputs": [[str(value.type) for value in child.operands]
                                        for child in children if str(child.name) == "coreai.output"],
                            "counts": dict(Counter(str(child.name) for child in children)),
                            "declaration": str(op.attributes["composite_decl"])
                                           if "composite_decl" in op.attributes else None}
        for region in op.regions:
            for block in region.blocks:
                for child in block.operations:
                    walk(child.operation)
    # AIModelAsset.program returns a fresh owning facade. Keep it alive while
    # inspecting the borrowed MLIR operations retained below.
    program = asset.program
    walk(program._module._mlir_module.operation)
    rms = {name: graph for name, graph in graphs.items() if graph["declaration"] is not None}
    require(len(rms) == len(SHAPES) and len(graphs) == len(expected) + len(SHAPES),
            "Expected six shared RMSNorm composite bodies and twelve public functions")
    for graph in rms.values():
        decl, op = graph["declaration"], graph["op"]
        require(decl.startswith('#coreai.composite_declaration<"rms_norm" = ')
                and 'input_names = ["input", "scale"]' in decl
                and 'output_names = ["output"]' in decl
                and re.search(r"version\s*=\s*1\s*:\s*si64", decl)
                and re.search(r"axes\s*=\s*-1\s*:\s*si64", decl), "RMSNorm identity changed")
        eps = re.search(r"eps\s*=\s*([-+0-9.eE]+)\s*:\s*f32", decl)
        require(eps is not None and np.float32(float(eps.group(1))) == np.float32(EPS),
                "RMSNorm epsilon is not the expected F32 value")
        require("priv" in op.attributes and "no_inline" in op.attributes, "RMSNorm lost its named boundary")
        require(len(graph["inputs"]) == 2 and graph["inputs"][0].endswith("xf16>")
                and graph["inputs"][1].endswith("xf32>")
                and graph["outputs"] == [[graph["inputs"][0]]], "RMSNorm F16/F32 boundary changed")
        require(graph["counts"] == {"coreai.constant": 2, "coreai.cast": 2,
                "coreai.decomposable.broadcasting_mul": 3, "coreai.reduce_mean": 1,
                "coreai.decomposable.broadcasting_add": 1, "coreai.rsqrt": 1, "coreai.output": 1},
                "RMSNorm reference body changed")
        for child in graph["children"]:
            if str(child.name) in {"coreai.reduce_mean", "coreai.rsqrt",
                                   "coreai.decomposable.broadcasting_mul"}:
                require(all(str(value.type).endswith("xf32>") for value in child.results),
                        "RMSNorm arithmetic is no longer F32")
    for name, (shape, scale) in expected.items():
        graph = graphs[name]
        tensor_type = "tensor<" + "x".join(map(str, shape)) + "xf16>"
        require(graph["declaration"] is None and graph["inputs"] == [tensor_type]
                and graph["outputs"] == [[tensor_type]] and graph["argumentNames"] == ["input"],
                f"Public F16 IO changed: {name}")
        require(summary.function_inputs(name) == [("input", "NDArray (Float16, " + " × ".join(map(str, shape)) + ")")]
                and summary.function_outputs(name) == [("output", "NDArray (Float16, " + " × ".join(map(str, shape)) + ")")]
                and not summary.function_states(name), f"Public names/state changed: {name}")
        require(graph["counts"] == {"coreai.constant": 1, "coreai.invoke": 1, "coreai.output": 1},
                f"Public function gained arithmetic/casts: {name}")
        matches = [g for g in rms.values() if g["inputs"] == [tensor_type, f"tensor<{shape[-1]}xf32>"]]
        require(len(matches) == 1, f"Missing shape-compatible RMSNorm body: {name}")
        invoke = next(child for child in graph["children"] if str(child.name) == "coreai.invoke")
        require("@" + StringAttr(matches[0]["op"].attributes["sym_name"]).value + ">"
                in str(invoke.attributes["callee"]), f"Wrong RMSNorm callee: {name}")
        constant = next(child for child in graph["children"] if str(child.name) == "coreai.constant")
        require(str(constant.results[0].type) == f"tensor<{shape[-1]}xf32>", "Scale is not baked as F32")
        value = constant.attributes["value"]
        if DenseElementsAttr.isinstance(value):
            baked = np.array(DenseElementsAttr(value))
        else:
            require(DenseResourceElementsAttr.isinstance(value), "Unknown baked scale storage")
            # The installed coreai-opt reader uses this compiler API for dense
            # resources. Only the already-checked, tiny F32 scale is copied.
            buffer = np.empty(shape[-1] * 4, dtype=np.uint8)
            _bindings.compiler.copy_constant_value_to_array(constant_op=constant, destination=buffer)
            baked = np.frombuffer(buffer, dtype=np.float32)
        require(baked.dtype == np.float32 and np.array_equal(baked.view(np.uint32), scale.astype(np.float32).view(np.uint32)),
                f"Baked scale differs from stored original F16 scale: {name}")
        require(invoke.operands[1] == constant.results[0], f"RMSNorm does not receive its recorded scale: {name}")
    return {"publicFunctions": list(expected), "recognizedRMSNormBodies": len(rms),
            "publicIO": "input/output Float16, identical static shape, no state",
            "rmsNormVersion": 1, "epsilonType": "Float32", "scaleType": "Float32",
            "reductionAndRsqrtType": "Float32", "postExportCastsAdded": False}


def verify(output):
    require(output.is_dir() and not output.is_symlink(), "Expected a regular fixture directory")
    require(not any(path.is_symlink() for path in output.rglob("*")), "Fixture tree contains a symlink")
    manifest = json.loads((output / "manifest.json").read_text())
    require(set(manifest) == {"schemaVersion", "kind", "asset", "assetSHA256", "fixtures"}
            and manifest["schemaVersion"] == 1 and manifest["kind"] == "assistRMSNormFixtures"
            and manifest["asset"] == ASSET, "Unknown fixture manifest")
    expected_plan = plans()
    require(len(manifest["fixtures"]) == len(expected_plan), "Expected exactly twelve fixtures")
    require((output / ASSET).is_dir() and sha(output / ASSET / "main.mlirb") == manifest["assetSHA256"],
            "Asset SHA256 differs from manifest")
    require((output / ASSET / "main.hash").read_bytes().hex() == manifest["assetSHA256"], "Asset main.hash mismatch")
    expected, checks, allowed = {}, [], {"manifest.json", "generator-provenance.json"}
    for fixture, (name, shape, mode) in zip(manifest["fixtures"], expected_plan, strict=True):
        require(set(fixture) == {"id", "function", "inputFile", "inputSHA256", "expectedFile",
                                "expectedSHA256", "shape", "reference", "maxULP"}
                and fixture["id"] == fixture["function"] == name and fixture["shape"] == list(shape)
                and fixture["reference"] == REFERENCE and fixture["maxULP"] == 1,
                "Fixture identity/shape/reference changed")
        for field, suffix in (("inputFile", "input"), ("expectedFile", "expected")):
            require(fixture[field] == f"{name}.{suffix}.f16", "Unexpected fixture filename")
            require(sha(output / fixture[field]) == fixture[f"{suffix}SHA256"], "Fixture SHA256 mismatch")
            allowed.add(fixture[field])
        x = read_f16(output / fixture["inputFile"], shape)
        require(np.array_equal(x.view(np.uint16), fixture_input(shape[-1], shape[-2]).view(np.uint16)),
                "Stored deterministic input changed")
        scale_file = f"scale_{shape[-1]}.f16"
        scale = read_f16(output / scale_file, (shape[-1],))
        allowed.add(scale_file)
        require(np.array_equal(scale.view(np.uint16), fixture_scale(shape[-1]).view(np.uint16)), "Stored scale changed")
        if mode == "ones":
            scale = np.ones(shape[-1], dtype="<f2")
        expected_output = read_f16(output / fixture["expectedFile"], shape)
        oracle = reference64(x, scale)
        require(np.array_equal(oracle.view(np.uint16), expected_output.view(np.uint16)), "Stored independent oracle changed")
        module = (WeightedNorm(scale) if mode == "weighted" else OnesNorm(shape[-1])).eval()
        checks.append({"id": name, **eager_check(module, x, scale, expected_output)})
        expected[name] = (shape, scale)
    provenance = json.loads((output / "generator-provenance.json").read_text())
    verify_provenance(provenance, output, checks)
    require(provenance["versions"] == {name: version(name) for name in (*PINS, "numpy")}
            and provenance["sourceSHA256"] == {
                f"{obj.__module__}.{obj.__name__}": sha(Path(inspect.getfile(obj)))
                for obj in (TorchConverter, ExternalizeSpec, RMSNormImpl)}, "Export environment changed")
    contract = inspect_asset(output / ASSET, expected)
    allowed |= {f"{ASSET}/main.hash", f"{ASSET}/main.mlirb", f"{ASSET}/metadata.json"}
    files = sorted(path for path in output.rglob("*") if path.is_file())
    require({path.relative_to(output).as_posix() for path in files} == allowed, "Unexpected resource tree contents")
    total = sum(path.stat().st_size for path in files)
    require(total < 2 * 1024**2, "Synthetic diagnostic resources exceed 2 MiB")
    return {"status": "passed", "scope": "Synthetic CPU eager, independent Float64 oracle and saved source only",
            "assetSHA256": manifest["assetSHA256"], "manifestSHA256": sha(output / "manifest.json"),
            "fixtureCount": len(expected), "resourceFiles": len(files), "resourceBytes": total,
            "allFixtureHashesReread": True, "assetMainHashVerified": True, "assetMetadataHashVerified": True,
            "assetMetadataSHA256": sha(output / ASSET / "metadata.json"), "contract": contract,
            "eagerChecks": checks, "modelWeightsLoaded": False, "runtimeOrSpecializationInvoked": False,
            "nativeCorrectnessVerified": False, "aneExecutionVerified": False}


def resource_limits(required):
    if sys.platform != "linux":
        require(not required, "Linux cgroup limits were required")
        return None
    try:
        group = next((line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines()
                      if line.startswith("0::")), None)
        if group is None:
            require(not required, "Required cgroup v2 resource limits unavailable")
            return None
        root = Path("/sys/fs/cgroup") / group.lstrip("/")
        actual = {key: (root / key).read_text().strip()
                  for key in ("memory.max", "memory.swap.max", "cpu.max", "pids.max")}
    except OSError as exc:
        require(not required, f"Required cgroup v2 resource limits unavailable: {exc}")
        return None
    if required:
        require(actual == {"memory.max": str(2 * 1024**3), "memory.swap.max": "0",
                           "cpu.max": "200000 100000", "pids.max": "128"}, "Requested resource limits absent")
    return actual


def max_rss_bytes():
    # getrusage reports bytes on macOS and KiB on Linux.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify", action="store_true", help="Reread existing resources without writing to them")
    parser.add_argument("--require-limits", action="store_true", help="Require the documented Linux cgroup limits")
    parser.add_argument("--report", type=Path, help="New private JSON report, outside the resource directory")
    args = parser.parse_args()
    require(args.verify or not args.output.exists(), "Refusing to overwrite an output directory")
    if args.report:
        require(not args.report.exists() and not args.report.is_symlink(), "Refusing to overwrite a report")
        require(not args.report.resolve().is_relative_to(args.output.resolve()), "Report must be outside the resources")
    started = time.monotonic()
    result = {"status": "failed", "generatorSHA256": sha(Path(__file__)), "verifyOnly": args.verify}
    try:
        result["cgroupLimits"] = resource_limits(args.require_limits)
        installed = {name: version(name) for name in PINS}
        require(installed == PINS, f"Use the reviewed export environment; got {installed}")
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        result.update(verify(args.output) if args.verify else export(args.output))
    except Exception as exc:
        result.update(errorType=type(exc).__name__, error=str(exc))
        raise
    finally:
        result["elapsedSeconds"] = time.monotonic() - started
        result["maxRSSBytes"] = max_rss_bytes()
        if args.report:
            write_json(args.report, result)
        print(json.dumps({key: result[key] for key in ("status", "elapsedSeconds", "maxRSSBytes")}), flush=True)


if __name__ == "__main__":
    main()
