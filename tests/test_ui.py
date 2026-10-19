"""Run the permanent web UI suite in the fixed smoke job."""

from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.smoke


def test_web_ui():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/ui.test.mjs"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
