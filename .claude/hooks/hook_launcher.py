#!/usr/bin/env python3
"""Cross-platform hook launcher for Claude Code hooks.

Replaces bash wrapper scripts (.sh) with a Python launcher that works
on Windows, macOS, and Linux.

Usage:
    python -m scripts.hook_launcher <hook-name>

    # In settings.json:
    "command": "python -m scripts.hook_launcher skill-activation-prompt"

The launcher:
1. Finds the compiled .mjs script in ~/.claude/hooks/dist/
2. Pipes stdin JSON to Node.js
3. Returns the hook's JSON output

This replaces bash wrappers like:
    #!/bin/bash
    cd ~/.claude/hooks
    cat | node dist/skill-activation-prompt.mjs
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def expand_path(path: str) -> str:
    """Expand ~ and environment variables in a path.

    Works on Windows, macOS, and Linux.

    Args:
        path: Path string that may contain ~ or $HOME/%USERPROFILE%

    Returns:
        Expanded absolute path string
    """
    # Expand ~ to home directory
    if path.startswith("~"):
        path = str(Path.home()) + path[1:]

    # Expand environment variables ($HOME, %USERPROFILE%, etc.)
    path = os.path.expandvars(path)

    # Normalize path separators for current platform
    return str(Path(path))


def get_hooks_dirs() -> list[Path]:
    """Get the Claude Code hooks directories.

    Returns both project-specific and user-level hooks directories.
    Project hooks take precedence over user hooks.

    Returns:
        List of paths to check for hooks (project first, then user)
    """
    dirs = []

    # Project-specific hooks (from CLAUDE_PROJECT_DIR env var)
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        dirs.append(Path(project_dir) / ".claude" / "hooks")

    # User-level hooks (~/.claude/hooks)
    dirs.append(Path.home() / ".claude" / "hooks")

    return dirs


def get_hooks_dir() -> Path:
    """Get the primary Claude Code hooks directory (for backwards compat).

    Returns:
        Path to ~/.claude/hooks
    """
    return Path.home() / ".claude" / "hooks"


def find_node() -> str | None:
    """Find the Node.js executable.

    Returns:
        Path to node executable, or None if not found
    """
    # Try common names
    for name in ["node", "node.exe", "nodejs"]:
        path = shutil.which(name)
        if path:
            return path

    # On Windows, also check common install locations
    if sys.platform == "win32":
        common_paths = [
            Path(os.environ.get("PROGRAMFILES", "")) / "nodejs" / "node.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
        ]
        for p in common_paths:
            if p.exists():
                return str(p)

    return None


def find_hook_script(name: str) -> tuple[Path | None, Path | None]:
    """Find the hook script file.

    Searches project-specific hooks first, then user hooks.
    Looks for compiled .mjs in dist/, falls back to .ts in src/.

    Args:
        name: Hook name (e.g., "skill-activation-prompt")

    Returns:
        Tuple of (script_path, hooks_dir) or (None, None) if not found
    """
    for hooks_dir in get_hooks_dirs():
        # Try compiled .mjs first
        mjs_path = hooks_dir / "dist" / f"{name}.mjs"
        if mjs_path.exists():
            return mjs_path, hooks_dir

        # Fallback to TypeScript source
        ts_path = hooks_dir / "src" / f"{name}.ts"
        if ts_path.exists():
            return ts_path, hooks_dir

    return None, None


def run_hook(
    name: str,
    input_json: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Run a hook and return its output.

    Args:
        name: Hook name (e.g., "skill-activation-prompt")
        input_json: JSON data to pass via stdin
        env: Additional environment variables
        timeout: Timeout in seconds

    Returns:
        Dict with keys: returncode, stdout, stderr
    """
    # Find Node.js
    node_path = find_node()
    if not node_path:
        return {
            "returncode": 1,
            "stdout": "",
            "stderr": "Error: Node.js not found. Please install Node.js.",
        }

    # Find hook script
    script_path, hooks_dir = find_hook_script(name)
    if not script_path:
        search_dirs = ", ".join(str(d) for d in get_hooks_dirs())
        return {
            "returncode": 1,
            "stdout": "",
            "stderr": f"Error: Hook '{name}' not found in [{search_dirs}]",
        }

    # Build command
    if script_path.suffix == ".ts":
        # Use npx tsx for TypeScript
        cmd = ["npx", "tsx", str(script_path)]
    else:
        # Use node for compiled .mjs
        cmd = [node_path, str(script_path)]

    # Prepare environment
    run_env = os.environ.copy()
    if env:
        run_env.update(env)

    # Prepare stdin
    stdin_data = json.dumps(input_json) if input_json else "{}"

    try:
        result = subprocess.run(
            cmd,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=run_env,
            cwd=str(hooks_dir),  # Run from the hooks dir where script was found
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "returncode": 124,
            "stdout": "",
            "stderr": f"Error: Hook '{name}' timed out after {timeout}s",
        }
    except FileNotFoundError as e:
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": f"Error: Command not found: {e}",
        }
    except Exception as e:
        return {
            "returncode": 1,
            "stdout": "",
            "stderr": f"Error running hook: {e}",
        }


def main() -> None:
    """CLI entrypoint for hook launcher.

    Usage: python -m scripts.hook_launcher <hook-name> [--env KEY=VALUE ...]
    """
    if len(sys.argv) < 2:
        print("Usage: python -m scripts.hook_launcher <hook-name>", file=sys.stderr)
        sys.exit(1)

    hook_name = sys.argv[1]

    # Parse --env arguments
    env_vars: dict[str, str] = {}
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--env" and i + 1 < len(sys.argv):
            key, _, value = sys.argv[i + 1].partition("=")
            env_vars[key] = value
            i += 2
        else:
            i += 1

    # Special handling for CLAUDE_PPID (pass parent PID)
    if "CLAUDE_PPID" not in env_vars and os.getppid():
        env_vars["CLAUDE_PPID"] = str(os.getppid())

    # Read stdin
    try:
        stdin_data = sys.stdin.read()
        input_json = json.loads(stdin_data) if stdin_data.strip() else {}
    except json.JSONDecodeError:
        input_json = {}

    # Run hook
    result = run_hook(hook_name, input_json=input_json, env=env_vars)

    # Output results
    if result["stdout"]:
        print(result["stdout"])
    if result["stderr"]:
        print(result["stderr"], file=sys.stderr)

    sys.exit(result["returncode"])


if __name__ == "__main__":
    main()
