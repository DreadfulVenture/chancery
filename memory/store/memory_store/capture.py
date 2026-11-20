"""Capture classification and repo resolution (input-classification ADR).

kind: speech | exhibit | fork_summary — resolved mechanically at capture,
where the bytes arrive. The fork marker is a stable literal; fences parse
per CommonMark run-length rules (a fence opens with N backticks, closes with
a run of >= N) so nested blocks survive; size flags for classification but
never classifies (pasted logs are legitimate large turns); speech is the
default for unclassifiable residue because artifact-as-speech corrupts one
recoverable summary while speech-as-exhibit loses the human's words outright.

Repo resolution uses thatch's detectRepo chain, worktree-safe: git remote
origin -> git-common-dir basename -> directory basename.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

FORK_MARKER = "<chat-history-summary>"

# Below this many characters inside a fenced block, the block is treated as
# prose (inline code mentions, short snippets) — exhibit-tracking noise.
EXHIBIT_BLOCK_FLOOR = 400

# A turn this large is never speech; it must classify as something. If no
# marker or fence claims it, it defaults to speech anyway (ADR default) but
# the flag exists for telemetry on unfenced-paste residue.
LARGE_TURN_FLAG = 5000

# The voice/capture tool's title-generation template leaks into capture as user turns; the
# stable preamble is dropped at ingest.
TITLE_GEN_MARKER = "Generate a title and a git branch name for a coding agent"

# Speaker labels the capture hook prepends; classification runs on the
# content beneath the label.
_SPEAKER_LABEL_RE = re.compile(r"^\[(?:USER|HUMAN|AGENT|ASSISTANT|SYSTEM)\]\s*")


def _strip_speaker_label(content: str) -> str:
    return _SPEAKER_LABEL_RE.sub("", content, count=1)


def classify_capture(content: str) -> str:
    """Return the capture kind for a user-channel turn."""
    body = _strip_speaker_label(content)
    if FORK_MARKER in body:
        return "fork_summary"
    if body.lstrip().startswith(TITLE_GEN_MARKER):
        return "exhibit"  # tool insertion — never speech or attributed to either speaker
    if _blocked_fraction(body) > 0:
        return "exhibit"
    return "speech"


def is_title_gen_template(content: str) -> bool:
    """True for the voice/capture tool's leaked title-generation prompts: drop entirely."""
    return _strip_speaker_label(content).lstrip().startswith(TITLE_GEN_MARKER)


_FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})")


def _blocked_fraction(content: str) -> float:
    """Fraction of content inside fenced blocks (CommonMark run-length),
    counting only blocks that clear the exhibit size floor — small inline
    snippets are prose, not exhibits."""
    lines = content.splitlines()
    total = sum(len(line) for line in lines)
    if total == 0:
        return 0.0
    block_size = 0
    open_len = 0  # length of the opening fence run; 0 = not in a block
    blocks = []
    for line in lines:
        match = _FENCE_RE.match(line)
        if open_len == 0:
            if match and len(match.group(2)) >= 3:
                open_len = len(match.group(2))
                block_size = 0
            continue
        if match and len(match.group(2)) >= open_len:
            blocks.append(block_size)
            open_len = 0
            continue
        block_size += len(line)
    if open_len:
        blocks.append(block_size)  # unclosed opener: paste-like remainder
    exhibit_chars = sum(size for size in blocks if size >= EXHIBIT_BLOCK_FLOOR)
    return exhibit_chars / total


_repo_cache: dict = {}


def resolve_workspace(cwd: str | None = None) -> str:
    """detect_repo memoized per cwd, or "" when there is no cwd to resolve.
    A session's cwd is stable, so its workspace resolves once; git remotes
    don't change mid-session."""
    if not cwd:
        return ""
    directory = os.path.abspath(cwd)
    if directory not in _repo_cache:
        _repo_cache[directory] = detect_repo(directory)
    return _repo_cache[directory]


def detect_repo(cwd: str | None = None) -> str:
    """Resolve the stable repo name for `cwd`: git remote -> git-common-dir
    basename -> directory basename, or "" when given no directory.
    Worktree-safe: the common dir resolves through the worktree's .git file
    to the main checkout.

    This process's own directory is never the answer. One daemon serves
    every session from cwd `/`, so resolving that for a turn whose client
    sent nothing stamped it with the basename of `/` — empty, which the
    final fallback used to render as the literal name `unknown`."""
    if not cwd:
        return ""
    directory = cwd
    try:
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if remote.returncode == 0 and remote.stdout.strip():
            url = remote.stdout.strip().rstrip("/").removesuffix(".git")
            name = url.rsplit("/", 1)[-1]
            if name:
                return name
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if common.returncode == 0:
            path = common.stdout.strip()
            if path == ".git":
                path = directory
            resolved = Path(directory) / path if not os.path.isabs(path) else Path(path)
            name = resolved.parent.name if resolved.name == ".git" else resolved.name
            if name and name != "unknown":
                return name
    except (OSError, subprocess.TimeoutExpired):
        pass
    return os.path.basename(os.path.abspath(directory))


def capture_source(repo: str, conversation_id: str) -> str:
    """Capture source grammar: cursor:<repo>:<conv8> — repo is the resolved
    stable name, never the worktree basename (provenance fix)."""
    return f"cursor:{repo}:{conversation_id[:8]}"


def deliberate_source(label: str, repo: str | None = None) -> str:
    """Compound deliberate source (convention:example): head is the
    classification label, tail carries the workspace."""
    if repo:
        return f"{label}:{repo}"
    return label
