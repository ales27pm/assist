#!/usr/bin/env python3
"""Run Apple's Gemma exporter while retaining its finalized palettes for quality checks.

Use inside the pinned Apple export environment. This retains intermediates and
uses one clustering worker; it does not implement the Linux memory adaptations.
"""
import argparse
from contextlib import contextmanager
from pathlib import Path
import runpy
import sys


@contextmanager
def retain_palettes(directory):
    from coreai_opt.common import ExportBackend
    from coreai_opt.palettization.kmeans.palettizer import KMeansPalettizer

    directory.mkdir(parents=True, exist_ok=False)
    original_prepare = KMeansPalettizer.prepare
    original_finalize = KMeansPalettizer.finalize

    def prepare(self, example_inputs, sensitivity_path=None, num_workers=1):
        return original_prepare(self, example_inputs, sensitivity_path, num_workers=1)

    def finalize(self, model=None, backend=ExportBackend.CoreAI, *, mmap_dir=None):
        if backend != ExportBackend.CoreAI or mmap_dir is not None:
            raise ValueError('Expected Core AI finalization without another mmap directory')
        return original_finalize(self, model, backend, mmap_dir=str(directory))

    KMeansPalettizer.prepare = prepare
    KMeansPalettizer.finalize = finalize
    try:
        yield
    finally:
        KMeansPalettizer.prepare = original_prepare
        KMeansPalettizer.finalize = original_finalize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exporter', type=Path, required=True)
    parser.add_argument('--palettes', type=Path, required=True, help='New directory outside the final bundle')
    args, export_args = parser.parse_known_args()
    if export_args[:1] == ['--']:
        export_args = export_args[1:]
    if not args.exporter.is_file() or args.palettes.exists():
        parser.error('Expected an existing exporter and a new palette directory')
    sys.argv = [str(args.exporter.resolve()), *export_args]
    with retain_palettes(args.palettes.resolve()):
        runpy.run_path(sys.argv[0], run_name='__main__')
    if not any(args.palettes.glob('*.safetensors')):
        raise RuntimeError('No finalized palettes were captured; inspect the export configuration')


if __name__ == '__main__':
    main()
