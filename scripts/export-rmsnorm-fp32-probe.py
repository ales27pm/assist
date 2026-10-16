#!/usr/bin/env python3
"""Export the RMSNorm diagnostic with an explicit F32 composite boundary.

The original F16-boundary generator and fixture directory are immutable inputs.
Public functions still take/return F16; their wrappers cast to F32 before the
named RMSNorm composite and back to F16 afterwards. No trained weights, native
runtime, specialization or Gemma backend changes are involved.

Use the same pinned environment and systemd limits documented by
export-rmsnorm-probe.py. Pass --output /new/NumericalProbeFP32 and optionally
--source-fixtures /existing/NumericalProbe. --verify rereads an existing output
without changing either resource directory. --report writes a new private JSON
report outside both resource directories.
"""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
from importlib.metadata import version
import json
from pathlib import Path
import re
import shutil
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


ORIGINAL_GENERATOR_SHA256 = "1fcec3addd69f222e640ce09de0bb22b99bab0340e38c072744d476e01869a6e"
BASELINE_GENERATOR_SHA256 = "49345988e2b01f0a5e624270cfa41cc6ca0563237f33384f014a5f80d8dd3ec0"
LEGACY_GENERATOR_SHA256 = "2b03b0ba1c80cd890d80d9b86d2aacb6c4aafd405d1ca4bc58c138509e08eeaf"
LEGACY_METADATA_SHA256 = "333021a0bb292530ba506815e8dd4b683bce66791e585224fde7827e21615671"
ORIGINAL_MANIFEST_SHA256 = "134b093a1c2b189c37458fa3776f4193feacf4c6d251e52dc69d5cee10be3c29"
ORIGINAL_ASSET_SHA256 = "46932657bf6ea3e4a3e99abba91b377b1ddbfb731a8553a4d5728fc414f54c8c"
VARIANT = "F16 public wrapper; cast F32 before named RMSNorm; cast F16 after named RMSNorm"


def load_original():
    path = Path(__file__).with_name("export-rmsnorm-probe.py")
    import hashlib
    if hashlib.sha256(path.read_bytes()).hexdigest() != ORIGINAL_GENERATOR_SHA256:
        raise RuntimeError("The original diagnostic generator changed; review the baseline explicitly")
    spec = importlib.util.spec_from_file_location("assist_original_rmsnorm_probe", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


original = load_original()
require, sha, write_json = original.require, original.sha, original.write_json


class WeightedNormFP32(nn.Module):
    def __init__(self, stored_scale):
        super().__init__()
        self.weight = nn.Parameter(torch.from_numpy(stored_scale.copy()), requires_grad=False)
        self.norm = RMSNormImpl(eps=original.EPS)

    def forward(self, input):
        return self.norm(input.float(), self.weight.float()).to(input.dtype)


class OnesNormFP32(nn.Module):
    def __init__(self, width):
        super().__init__()
        self.register_buffer("ones", torch.ones(width, dtype=torch.float32), persistent=False)
        self.norm = RMSNormImpl(eps=original.EPS)

    def forward(self, input):
        return self.norm(input.float(), self.ones).to(input.dtype)


def tree_snapshot(root):
    return {path.relative_to(root).as_posix(): sha(path)
            for path in sorted(root.rglob("*")) if path.is_file()}


def require_disjoint_resources(output, source):
    output, source = output.resolve(), source.resolve()
    require(not output.is_relative_to(source) and not source.is_relative_to(output),
            "Output and original fixtures must not overlap")


def verify_provenance(provenance, output, source, checks):
    fixed = {"schemaVersion": 1, "kind": "assistRMSNormFP32FixtureProvenance",
             "generator": "scripts/export-rmsnorm-fp32-probe.py", "variant": VARIANT,
             "fixtureInputsExpectedAndScalesUnchanged": True, "modelWeightsLoaded": False,
             "runtimeOrSpecializationInvoked": False, "nativeCorrectnessVerified": False,
             "aneExecutionVerified": False, "originalManifestSHA256": ORIGINAL_MANIFEST_SHA256,
             "originalAssetSHA256": ORIGINAL_ASSET_SHA256}
    require(all(type(provenance.get(key)) is type(value) and provenance[key] == value
                for key, value in fixed.items()), "Fixed generator provenance changed")
    legacy = provenance["generatorSHA256"] == LEGACY_GENERATOR_SHA256
    require(provenance["generatorSHA256"] in {sha(Path(__file__)), LEGACY_GENERATOR_SHA256}
            and provenance["originalGeneratorSHA256"] == (BASELINE_GENERATOR_SHA256 if legacy else ORIGINAL_GENERATOR_SHA256),
            "Generator provenance mismatch")
    metadata_digest = provenance.get("assetMetadataSHA256")
    require(metadata_digest is not None or legacy, "Missing asset metadata provenance")
    require(not legacy or metadata_digest in (None, LEGACY_METADATA_SHA256), "Historical asset metadata provenance changed")
    original.verify_metadata(output / original.ASSET / "metadata.json",
                             metadata_digest if metadata_digest is not None else LEGACY_METADATA_SHA256)
    require(json.dumps(provenance["eagerChecks"], sort_keys=True, allow_nan=False)
            == json.dumps(checks, sort_keys=True, allow_nan=False), "Recorded eager checks differ from recomputed results")
    require(provenance["versions"] == {name: version(name) for name in (*original.PINS, "numpy")}
            and provenance["originalSourceSHA256"] == json.loads((source / "generator-provenance.json").read_text())["sourceSHA256"],
            "Export environment provenance mismatch")
    allowed = set(fixed) | {"generatorSHA256", "originalGeneratorSHA256", "versions", "originalSourceSHA256", "eagerChecks"}
    if metadata_digest is not None:
        allowed.add("assetMetadataSHA256")
    require(set(provenance) == allowed, "Unexpected generator provenance fields")


def verified_source(source):
    require(sha(source / "manifest.json") == ORIGINAL_MANIFEST_SHA256,
            "Expected the immutable build 5 fixture manifest")
    result = original.verify(source)
    require(result["assetSHA256"] == ORIGINAL_ASSET_SHA256, "Expected the immutable build 5 source asset")
    return result


def inspect_asset(path, fixtures, source):
    asset = AIModelAsset.load(path)
    program = asset.program
    module = program._module._mlir_module  # Keep both owning facades alive for borrowed operations.
    summary = asset.summary(include_statistics=False)
    require(set(summary.function_names) == {row["function"] for row in fixtures}, "Unexpected public function set")
    graphs = {}
    def walk(op):
        if str(op.name) == "coreai.graph":
            name = StringAttr(op.attributes["sym_name"]).value
            require(name not in graphs, "Duplicate graph symbol")
            blocks = [block for region in op.regions for block in region.blocks]
            require(len(blocks) == 1, "Unexpected graph block count")
            children = [child.operation for child in blocks[0].operations]
            attrs = ArrayAttr(op.attributes["arg_attrs"]) if "arg_attrs" in op.attributes else []
            graphs[name] = {"op": op, "children": children, "block": blocks[0],
                            "inputs": [str(arg.type) for arg in blocks[0].arguments],
                            "argumentNames": [StringAttr(DictAttr(raw)["coreai.name"]).value
                                              if "coreai.name" in DictAttr(raw) else None for raw in attrs],
                            "outputs": [[str(value.type) for value in child.operands]
                                        for child in children if str(child.name) == "coreai.output"],
                            "counts": dict(Counter(str(child.name) for child in children)),
                            "declaration": str(op.attributes["composite_decl"])
                                           if "composite_decl" in op.attributes else None}
        for region in op.regions:
            for block in region.blocks:
                for child in block.operations:
                    walk(child.operation)
    walk(module.operation)
    norms = {name: graph for name, graph in graphs.items() if graph["declaration"] is not None}
    require(len(norms) == 6 and len(graphs) == 18, "Expected six RMSNorm bodies and twelve public wrappers")
    composite_body = {"coreai.constant": 2, "coreai.decomposable.broadcasting_mul": 3,
                      "coreai.reduce_mean": 1, "coreai.decomposable.broadcasting_add": 1,
                      "coreai.rsqrt": 1, "coreai.output": 1}
    for graph in norms.values():
        op, decl = graph["op"], graph["declaration"]
        require(decl.startswith('#coreai.composite_declaration<"rms_norm" = ')
                and 'input_names = ["input", "scale"]' in decl
                and 'output_names = ["output"]' in decl
                and re.search(r"version\s*=\s*1\s*:\s*si64", decl)
                and re.search(r"axes\s*=\s*-1\s*:\s*si64", decl), "RMSNorm identity changed")
        eps = re.search(r"eps\s*=\s*([-+0-9.eE]+)\s*:\s*f32", decl)
        require(eps is not None and np.float32(float(eps.group(1))) == np.float32(original.EPS), "RMSNorm epsilon changed")
        require("priv" in op.attributes and "no_inline" in op.attributes, "RMSNorm lost its named boundary")
        require(len(graph["inputs"]) == 2 and all(value.endswith("xf32>") for value in graph["inputs"])
                and graph["outputs"] == [[graph["inputs"][0]]], "Composite IO is not entirely F32")
        require(graph["counts"] == composite_body, "F32 RMSNorm body changed or contains an unexpected cast")
        for child in graph["children"]:
            require(all("f16" not in str(value.type) for value in (*child.operands, *child.results)),
                    "A hidden F16 value remains inside the F32 RMSNorm body")
            if str(child.name) in {"coreai.reduce_mean", "coreai.rsqrt", "coreai.decomposable.broadcasting_mul"}:
                require(all(str(value.type).endswith("xf32>") for value in child.results), "RMS arithmetic is not F32")
    public_reports = []
    for fixture in fixtures:
        name, shape = fixture["function"], fixture["shape"]
        graph = graphs[name]
        geometry = "x".join(map(str, shape))
        f16, f32 = f"tensor<{geometry}xf16>", f"tensor<{geometry}xf32>"
        descriptor = "NDArray (Float16, " + " × ".join(map(str, shape)) + ")"
        require(graph["declaration"] is None and graph["inputs"] == [f16] and graph["outputs"] == [[f16]]
                and graph["argumentNames"] == ["input"], "Public F16 IO changed")
        require(summary.function_inputs(name) == [("input", descriptor)]
                and summary.function_outputs(name) == [("output", descriptor)]
                and not summary.function_states(name), "Public names/state changed")
        require(graph["counts"] == {"coreai.constant": 1, "coreai.cast": 2, "coreai.invoke": 1, "coreai.output": 1},
                "Public wrapper is not exactly scale + two casts + RMSNorm invoke")
        matching = [g for g in norms.values() if g["inputs"] == [f32, f"tensor<{shape[-1]}xf32>"]]
        require(len(matching) == 1, "Missing unique shape-compatible F32 composite")
        invoke = next(child for child in graph["children"] if str(child.name) == "coreai.invoke")
        symbol = StringAttr(matching[0]["op"].attributes["sym_name"]).value
        require("@" + symbol + ">" in str(invoke.attributes["callee"]), "Wrong F32 composite callee")
        casts = [child for child in graph["children"] if str(child.name) == "coreai.cast"]
        upcast = [child for child in casts if [str(value.type) for value in child.results] == [f32]]
        downcast = [child for child in casts if [str(value.type) for value in child.results] == [f16]]
        require(len(upcast) == len(downcast) == 1
                and upcast[0].operands[0] == graph["block"].arguments[0]
                and invoke.operands[0] == upcast[0].results[0]
                and downcast[0].operands[0] == invoke.results[0], "Wrapper cast order changed")
        output = next(child for child in graph["children"] if str(child.name) == "coreai.output")
        require(output.operands[0] == downcast[0].results[0], "Public output does not use the final F16 cast")
        constant = next(child for child in graph["children"] if str(child.name) == "coreai.constant")
        require(str(constant.results[0].type) == f"tensor<{shape[-1]}xf32>"
                and invoke.operands[1] == constant.results[0], "Wrong baked F32 scale boundary")
        scale = (original.read_f16(source / f"scale_{shape[-1]}.f16", (shape[-1],))
                 if name.endswith("_weighted") else np.ones(shape[-1], dtype="<f2"))
        value = constant.attributes["value"]
        if DenseElementsAttr.isinstance(value):
            baked = np.array(DenseElementsAttr(value))
        else:
            require(DenseResourceElementsAttr.isinstance(value), "Unknown baked scale storage")
            buffer = np.empty(shape[-1] * 4, dtype=np.uint8)
            _bindings.compiler.copy_constant_value_to_array(constant_op=constant, destination=buffer)
            baked = np.frombuffer(buffer, dtype=np.float32)
        require(baked.dtype == np.float32 and np.array_equal(baked.view(np.uint32), scale.astype(np.float32).view(np.uint32)),
                "Baked F32 scale differs from stored F16 scale")
        public_reports.append({"function": name, "inputType": f16, "outputType": f16,
                               "operationCounts": graph["counts"], "compositeInputType": f32,
                               "compositeOutputType": f32})
    return {"publicFunctions": public_reports, "recognizedRMSNormBodies": len(norms),
            "compositeBodyOperationCounts": composite_body, "compositeDataIO": "Float32",
            "compositeScaleReductionRsqrtEpsilon": "Float32", "compositeContainsFloat16": False,
            "publicIO": "Float16 input/output without state", "wrapperCastOrderVerified": True,
            "postExportIRMutations": False}


def export(output, source):
    require_disjoint_resources(output, source)
    output.mkdir(parents=True, exist_ok=False)
    baseline = json.loads((source / "manifest.json").read_text())
    files = {row[field] for row in baseline["fixtures"] for field in ("inputFile", "expectedFile")}
    files |= {f"scale_{width}.f16" for width, _ in original.SHAPES}
    for name in files:
        shutil.copyfile(source / name, output / name)
    converter = TorchConverter(mode=TorchConverter.Mode.RELEASE)
    spec = ExternalizeSpec(target_class=RMSNormImpl, composite_op_name="rms_norm", composite_attrs=["axes", "eps"])
    checks, models = [], []
    for fixture in baseline["fixtures"]:
        name, shape = fixture["function"], fixture["shape"]
        x = original.read_f16(output / fixture["inputFile"], shape)
        expected = original.read_f16(output / fixture["expectedFile"], shape)
        scale = (original.read_f16(output / f"scale_{shape[-1]}.f16", (shape[-1],))
                 if name.endswith("_weighted") else np.ones(shape[-1], dtype="<f2"))
        module = (WeightedNormFP32(scale) if name.endswith("_weighted") else OnesNormFP32(shape[-1])).eval()
        models.append((module, scale.copy()))
        checks.append({"id": name, **original.eager_check(module, x, scale, expected)})
        sample = torch.from_numpy(x.copy())
        def export_fn(target, sample=sample):
            with torch.no_grad():
                return torch.export.export(target, (sample,)).run_decompositions(get_decomp_table())
        converter.add_pytorch_module(module, export_fn=export_fn, externalize_modules=[spec],
                                     input_names=["input"], output_names=["output"], entrypoint_name=name)
    program = converter.to_coreai()
    program.save_asset(output / original.ASSET)
    converter.clear()
    for module, scale in models:
        require(not any(hasattr(child, "_original_forward") for child in module.modules()), "Externalization was not restored")
        if hasattr(module, "weight"):
            require(module.weight.dtype == torch.float16
                    and np.array_equal(module.weight.detach().numpy().view(np.uint16), scale.view(np.uint16)),
                    "Original F16 parameter changed")
        else:
            require(not list(module.parameters()) and not module.state_dict(), "Ones scale acquired persistent state")
    manifest = {**baseline, "assetSHA256": sha(output / original.ASSET / "main.mlirb")}
    write_json(output / "manifest.json", manifest)
    write_json(output / "generator-provenance.json", {
        "schemaVersion": 1, "kind": "assistRMSNormFP32FixtureProvenance",
        "generator": "scripts/export-rmsnorm-fp32-probe.py", "generatorSHA256": sha(Path(__file__)),
        "assetMetadataSHA256": sha(output / original.ASSET / "metadata.json"),
        "originalGeneratorSHA256": ORIGINAL_GENERATOR_SHA256, "originalManifestSHA256": ORIGINAL_MANIFEST_SHA256,
        "originalAssetSHA256": ORIGINAL_ASSET_SHA256,
        "versions": {name: version(name) for name in (*original.PINS, "numpy")},
        "originalSourceSHA256": json.loads((source / "generator-provenance.json").read_text())["sourceSHA256"],
        "variant": VARIANT,
        "eagerChecks": checks, "fixtureInputsExpectedAndScalesUnchanged": True,
        "modelWeightsLoaded": False, "runtimeOrSpecializationInvoked": False,
        "nativeCorrectnessVerified": False, "aneExecutionVerified": False,
    })
    return verify(output, source)


def verify(output, source):
    require(output.is_dir() and not output.is_symlink(), "Expected a regular output directory")
    require(not any(path.is_symlink() for path in output.rglob("*")), "Output contains a symlink")
    manifest = json.loads((output / "manifest.json").read_text())
    baseline = json.loads((source / "manifest.json").read_text())
    require(manifest == {**baseline, "assetSHA256": sha(output / original.ASSET / "main.mlirb")},
            "Fixture manifest differs beyond its new source asset hash")
    require((output / original.ASSET / "main.hash").read_bytes().hex() == manifest["assetSHA256"], "main.hash mismatch")
    checks = []
    allowed = {"manifest.json", "generator-provenance.json", f"{original.ASSET}/main.hash",
               f"{original.ASSET}/main.mlirb", f"{original.ASSET}/metadata.json"}
    for fixture in manifest["fixtures"]:
        name, shape = fixture["function"], fixture["shape"]
        for field, digest in (("inputFile", "inputSHA256"), ("expectedFile", "expectedSHA256")):
            require(sha(output / fixture[field]) == fixture[digest] == sha(source / fixture[field]), "Fixture bytes changed")
            allowed.add(fixture[field])
        scale_file = f"scale_{shape[-1]}.f16"
        require(sha(output / scale_file) == sha(source / scale_file), "Stored scale changed")
        allowed.add(scale_file)
        x = original.read_f16(output / fixture["inputFile"], shape)
        expected = original.read_f16(output / fixture["expectedFile"], shape)
        scale = (original.read_f16(output / scale_file, (shape[-1],))
                 if name.endswith("_weighted") else np.ones(shape[-1], dtype="<f2"))
        module = (WeightedNormFP32(scale) if name.endswith("_weighted") else OnesNormFP32(shape[-1])).eval()
        checks.append({"id": name, **original.eager_check(module, x, scale, expected)})
    provenance = json.loads((output / "generator-provenance.json").read_text())
    verify_provenance(provenance, output, source, checks)
    contract = inspect_asset(output / original.ASSET, manifest["fixtures"], source)
    files = sorted(path for path in output.rglob("*") if path.is_file())
    require({path.relative_to(output).as_posix() for path in files} == allowed, "Unexpected output tree contents")
    total = sum(path.stat().st_size for path in files)
    require(total < 2 * 1024**2, "Synthetic diagnostic exceeds 2 MiB")
    return {"status": "passed", "scope": "Synthetic F32-boundary CPU and saved source only",
            "assetSHA256": manifest["assetSHA256"], "manifestSHA256": sha(output / "manifest.json"),
            "fixtureCount": len(manifest["fixtures"]), "resourceFiles": len(files), "resourceBytes": total,
            "allFixtureHashesReread": True, "assetMainHashVerified": True, "assetMetadataHashVerified": True,
            "assetMetadataSHA256": sha(output / original.ASSET / "metadata.json"),
            "fixtureInputsExpectedAndScalesUnchanged": True, "contract": contract, "eagerChecks": checks,
            "modelWeightsLoaded": False, "runtimeOrSpecializationInvoked": False,
            "nativeCorrectnessVerified": False, "aneExecutionVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-fixtures", type=Path,
                        default=Path(__file__).resolve().parents[1] / "mobile/ios/Assist/NumericalProbe")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--require-limits", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    require(args.verify or not args.output.exists(), "Refusing to overwrite an output directory")
    require_disjoint_resources(args.output, args.source_fixtures)
    if args.report:
        require(not args.report.exists() and not args.report.is_symlink(), "Refusing to overwrite a report")
        require(not args.report.resolve().is_relative_to(args.output.resolve())
                and not args.report.resolve().is_relative_to(args.source_fixtures.resolve()), "Report must be outside resources")
    result = {"status": "failed", "generatorSHA256": sha(Path(__file__)), "verifyOnly": args.verify}
    started, before = time.monotonic(), None
    try:
        result["cgroupLimits"] = original.resource_limits(args.require_limits)
        require({name: version(name) for name in original.PINS} == original.PINS, "Use the reviewed export environment")
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        before = tree_snapshot(args.source_fixtures)
        result["originalFixturesVerification"] = verified_source(args.source_fixtures)
        result.update(verify(args.output, args.source_fixtures) if args.verify else export(args.output, args.source_fixtures))
        require(tree_snapshot(args.source_fixtures) == before, "Original resource bytes changed")
        result["originalResourceTreeUnchanged"] = True
    except Exception as exc:
        result.update(status="failed", errorType=type(exc).__name__, error=str(exc))
        raise
    finally:
        if before is not None:
            result["originalResourceTreeUnchanged"] = tree_snapshot(args.source_fixtures) == before
        result["elapsedSeconds"] = time.monotonic() - started
        result["maxRSSBytes"] = original.max_rss_bytes()
        if args.report:
            write_json(args.report, result)
        print(json.dumps({key: result[key] for key in ("status", "elapsedSeconds", "maxRSSBytes")}), flush=True)


if __name__ == "__main__":
    main()
