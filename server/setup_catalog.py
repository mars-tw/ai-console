"""Public, non-secret setup guidance for the desktop AI connection wizard."""
from __future__ import annotations

import shutil
import sys

TOOL_GUIDES = (
    ('qwen', 'Qwen Code', 'https://qwenlm.github.io/qwen-code-docs/en/',
     '開啟官方安裝指引，完成安裝後在 Qwen 內登入，再回來重新檢查。'),
    ('kimi', 'Kimi Code', 'https://www.kimi.ai/zh-hant/help/kimi-code/cli-getting-started',
     '依官方指引安裝，在 Kimi 內完成登入，再回來重新檢查。'),
    ('grok', 'Grok', 'https://grok.com/',
     '先安裝並登入 Grok 工具；控制台只檢查程式是否可啟動，不會讀取登入憑證。'),
    ('codex', 'Codex', 'https://developers.openai.com/codex/cli/',
     '依官方指引安裝 Codex，開啟後完成登入，再回來重新檢查。'),
    ('claude', 'Claude Code', 'https://code.claude.com/docs/en/quickstart',
     '依官方指引安裝 Claude Code，開啟後完成登入，再回來重新檢查。'),
    ('gemini', 'ANTIGRAVITY', 'https://antigravity.google/download',
     '先完成 Antigravity 的安裝與登入，再回來檢查工具狀態。'),
    ('cursor', 'Cursor', 'https://cursor.com/download',
     '安裝並登入 Cursor；終端工具需要在開啟後繼續操作。'),
)


def setup_catalog(available, models, connections, *, lmstudio_installed=False, tailscale_available=False):
    """Executable discovery is deliberately not promoted to login/inference proof."""
    tools = [{
        'id': key, 'label': label, 'installed': bool(available(key)),
        'authStatus': 'unknown', 'capabilities': {'chat': False, 'dispatch': True},
        'installUrl': url, 'setupHint': hint,
    } for key, label, url, hint in TOOL_GUIDES]
    return {
        'ok': True,
        'tools': tools,
        'connections': connections,
        'local': {'models': models, 'available': bool(models), 'installed': lmstudio_installed},
        'requirements': [
            {'id': 'python', 'label': 'Python', 'ready': True,
             'hint': '控制台後端已在 Python 執行。',
             'version': f'{sys.version_info.major}.{sys.version_info.minor}',
             'url': 'https://www.python.org/downloads/'},
            {'id': 'node', 'label': 'Node.js（部分 AI 工具需要）', 'ready': bool(shutil.which('node')),
             'hint': '如果選用的 AI 安裝指引需要 Node.js，請先安裝再回來檢查。',
             'url': 'https://nodejs.org/en/download'},
            {'id': 'lmstudio', 'label': 'LM Studio（地端問答）', 'ready': bool(models),
             'hint': '安裝 LM Studio 並下載完整模型；送出問題後由控制台準備模型。',
             'url': 'https://lmstudio.ai/download'},
            {'id': 'tailscale', 'label': 'Tailscale（手機遙控）', 'ready': tailscale_available,
             'hint': '只用電腦時可略過；手機與電腦需登入同一個 Tailscale 網路。',
             'url': 'https://tailscale.com/download'},
        ],
    }
