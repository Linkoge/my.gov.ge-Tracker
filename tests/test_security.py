"""Run the permanent offline security and configuration suite in the fixed smoke job."""

from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.smoke


def test_repository_security():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/security.test.mjs"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
