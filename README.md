# Inkstain Desktop Agent

System-wide AI interaction capture for Mac and Windows.
Catches clipboard events from any app — Claude desktop, Replit, anything.

## What it does

- Watches your clipboard system-wide
- Detects when you copy from an AI app (Claude, ChatGPT, Replit, Cursor, etc.)
- Detects when you paste into a writing app (Word, Scrivener, Google Docs, etc.)
- Logs the event: platform, size, timestamp — never the content
- Stores your Trail locally in a SQLite database
- Export Trail as JSON → upload to inkstain.ai/trail → get your certificate

## What it never does

- Read your clipboard content
- Store what you copied or pasted
- Send anything to a server
- Run in the background without your knowledge
- Require an account or internet connection to record

## Install — Mac

```bash
chmod +x install_mac.sh
./install_mac.sh
```

Then drag `dist/Inkstain Trail.app` to your Applications folder.

## Install — Windows

Double-click `install_windows.bat`

Then move `dist/Inkstain Trail.exe` wherever you like.

## Run from source (both platforms)

```bash
pip install PyQt6
python3 inkstain_agent/main.py
```

## AI apps monitored

Claude desktop, ChatGPT desktop, Cursor, Replit, GitHub Copilot,
Perplexity, Notion AI, Gemini, Grok, Mistral, Sudowrite, NovelAI
— and any browser window with these domains in the title.

## Writing apps monitored for paste events

Microsoft Word, Pages, Scrivener, Google Docs, Notion,
Ulysses, iA Writer, Bear, Obsidian, TextEdit, Notepad

## Data location

Mac: `~/Library/Application Support/Inkstain/trail.db`
Windows: `%APPDATA%\Inkstain\trail.db`

---

The written word will prevail.
inkstain.ai
