"""Run the permanent tracker fixtures in the application's fixed smoke suite."""

from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.smoke


def test_tracker():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/tracker.test.mjs", "tests/registry.test.mjs"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
