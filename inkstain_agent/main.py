#!/usr/bin/env python3
"""
Inkstain Desktop Agent
Cross-platform menubar (Mac) / system tray (Windows) app.
Watches clipboard system-wide. Captures AI interactions from any app.
Never reads content — size and source only.
"""

import sys
import os
import json
import time
import threading
import hashlib
import sqlite3
import platform
from datetime import datetime
from pathlib import Path

# ── Detect platform ──
IS_MAC = platform.system() == 'Darwin'
IS_WIN = platform.system() == 'Windows'

# ── Data directory ──
if IS_MAC:
    DATA_DIR = Path.home() / 'Library' / 'Application Support' / 'Inkstain'
elif IS_WIN:
    DATA_DIR = Path(os.environ.get('APPDATA', Path.home())) / 'Inkstain'
else:
    DATA_DIR = Path.home() / '.inkstain'

DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / 'trail.db'
STATE_PATH = DATA_DIR / 'state.json'

# ── AI app signatures ──
# These are window title fragments that indicate AI apps
AI_APP_SIGNATURES = {
    # Mac app names / window titles
    'Claude': 'claude',
    'claude': 'claude',
    'ChatGPT': 'chatgpt',
    'Cursor': 'cursor',
    'Replit': 'replit',
    'GitHub Copilot': 'copilot',
    'Copilot': 'copilot',
    'Perplexity': 'perplexity',
    'Notion AI': 'notion_ai',
    'Gemini': 'gemini',
    # Browser window titles
    'claude.ai': 'claude',
    'chatgpt.com': 'chatgpt',
    'chat.openai.com': 'chatgpt',
    'gemini.google.com': 'gemini',
    'perplexity.ai': 'perplexity',
    'replit.com': 'replit',
    'copilot.microsoft.com': 'copilot',
    'grok.com': 'grok',
    'mistral.ai': 'mistral',
    'sudowrite.com': 'sudowrite',
    'novelai.net': 'novelai',
}

# Writing app signatures
WRITING_APP_SIGNATURES = {
    'Microsoft Word': 'word',
    'Pages': 'pages',
    'Scrivener': 'scrivener',
    'Google Docs': 'google_docs',
    'docs.google.com': 'google_docs',
    'Notion': 'notion',
    'Ulysses': 'ulysses',
    'iA Writer': 'ia_writer',
    'Bear': 'bear',
    'Obsidian': 'obsidian',
    'Notepad': 'notepad',
    'TextEdit': 'textedit',
}


def init_db():
    """Initialize SQLite database for Trail storage."""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS trail_events (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            platform TEXT,
            size_chars INTEGER DEFAULT 0,
            source_app TEXT,
            dest_app TEXT,
            manuscript_title TEXT DEFAULT 'untitled',
            session_id TEXT
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at TEXT,
            ended_at TEXT,
            app TEXT,
            manuscript_title TEXT
        )
    ''')
    conn.commit()
    conn.close()


def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except:
            pass
    return {
        'recording': True,
        'manuscript_title': '',
        'author_name': '',
        'started_at': datetime.utcnow().isoformat(),
        'session_id': generate_id()
    }


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2))


def generate_id():
    return hashlib.md5(f"{time.time()}{os.getpid()}".encode()).hexdigest()[:12]


def log_event(event_type, platform, size_chars, source_app='', dest_app='', state=None):
    """Log a Trail event to the database."""
    if not state or not state.get('recording', True):
        return
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('''
        INSERT INTO trail_events 
        (id, timestamp, event_type, platform, size_chars, source_app, dest_app, manuscript_title, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        generate_id(),
        datetime.utcnow().isoformat() + 'Z',
        event_type,
        platform,
        size_chars,
        source_app,
        dest_app,
        state.get('manuscript_title', 'untitled'),
        state.get('session_id', '')
    ))
    conn.commit()
    conn.close()


def get_trail_summary(state):
    """Get summary stats for the popup display."""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('SELECT COUNT(*) FROM trail_events')
    total = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM trail_events WHERE event_type='clipboard_copy'")
    copies = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM trail_events WHERE event_type='clipboard_paste'")
    pastes = c.fetchone()[0]
    c.execute('SELECT timestamp FROM trail_events ORDER BY timestamp DESC LIMIT 5')
    recent = c.fetchall()
    conn.close()
    return {'total': total, 'copies': copies, 'pastes': pastes, 'recent': recent}


def export_trail(state, activity_pattern=None, time_summary=None):
    """Export Trail as JSON for certificate generator."""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('SELECT * FROM trail_events ORDER BY timestamp DESC')
    rows = c.fetchall()
    cols = [d[0] for d in c.description]
    conn.close()

    events = [dict(zip(cols, row)) for row in rows]
    # Map to same format as browser extension
    mapped = []
    for ev in events:
        mapped.append({
            'id': ev['id'],
            'timestamp': ev['timestamp'],
            'type': 'ai_copy' if ev['event_type'] == 'clipboard_copy' else 'doc_paste',
            'platform': ev['platform'] or 'desktop',
            'size_chars': ev['size_chars'],
            'url_domain': ev['source_app'],
            'manuscript_title': ev['manuscript_title']
        })

    export = {
        'state': state,
        'trail': mapped,
        'activity_pattern': activity_pattern or {},
        'time_tracking': time_summary or {},
        'exported_at': datetime.utcnow().isoformat() + 'Z',
        'source': 'inkstain_desktop_agent'
    }

    export_path = DATA_DIR / f"inkstain-trail-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    export_path.write_text(json.dumps(export, indent=2))
    return str(export_path)


# ── Clipboard Monitor ──
class ClipboardMonitor:
    """
    System-wide clipboard monitor.
    Detects when text is copied from AI apps and pasted into writing apps.
    Never stores content — size and source app only.
    """

    def __init__(self, state_ref, on_event):
        self.state_ref = state_ref
        self.on_event = on_event
        self.last_clipboard = ''
        self.last_size = 0
        self.last_source_app = ''
        self.last_source_url = ''
        self.running = False
        self._thread = None

        # Time tracking
        self.time_tracker = {
            'session_start': datetime.utcnow().isoformat() + 'Z',
            'ai_active_seconds': 0.0,
        }

        # App-switch tracking
        self.last_app_category = None    # 'ai' | 'writing' | None
        self.category_entered_at = None  # time.time() when category was entered
        self.ai_sessions = 0
        self.writing_sessions = 0
        self.ai_session_durations = []   # seconds per discrete AI visit
        self.interleave_count = 0        # completed AI→Writing→AI cycles
        self._last_transition = None     # 'ai_to_writing' | 'writing_to_ai'

    def get_active_app(self):
        """Get the currently active application name and browser tab URL.

        Returns (app_name, url). url is non-empty only when a supported browser
        (Chrome, Safari, Arc) is frontmost and AppleScript succeeds.
        """
        app_name = ''
        url = ''
        try:
            if IS_MAC:
                import subprocess
                result = subprocess.run([
                    'osascript', '-e',
                    'tell application "System Events" to get name of first application process whose frontmost is true'
                ], capture_output=True, text=True, timeout=0.5)
                app_name = result.stdout.strip()

                browser_scripts = {
                    'Google Chrome': 'tell application "Google Chrome" to get URL of active tab of first window',
                    'Chrome':        'tell application "Google Chrome" to get URL of active tab of first window',
                    'Safari':        'tell application "Safari" to get URL of current tab of first window',
                    'Arc':           'tell application "Arc" to get URL of active tab of first window',
                }
                script = browser_scripts.get(app_name)
                if script:
                    url_result = subprocess.run(
                        ['osascript', '-e', script],
                        capture_output=True, text=True, timeout=0.5
                    )
                    url = url_result.stdout.strip()

            elif IS_WIN:
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                app_name = buf.value
                # On Windows, Chrome/Edge/Firefox embed the page title in the
                # window title (e.g. "Claude - Google Chrome"). Pass the full
                # title as `url` so identify_platform's domain scan also sees it.
                url = app_name
        except:
            pass
        return app_name, url

    def get_clipboard_text(self):
        """Get current clipboard text safely."""
        try:
            if IS_MAC:
                import subprocess
                result = subprocess.run(
                    ['pbpaste'], capture_output=True, timeout=0.5
                )
                return result.stdout.decode('utf-8', errors='replace')
            elif IS_WIN:
                import ctypes
                if not ctypes.windll.user32.OpenClipboard(0):
                    return ''
                try:
                    CF_UNICODETEXT = 13
                    handle = ctypes.windll.user32.GetClipboardData(CF_UNICODETEXT)
                    if not handle:
                        return ''
                    text = ctypes.cast(handle, ctypes.c_wchar_p).value or ''
                    return text
                finally:
                    ctypes.windll.user32.CloseClipboard()
        except:
            pass
        return ''

    def identify_platform(self, app_name, url=''):
        """Identify if an app is an AI platform.

        Checks the browser tab URL first (domain signatures are unambiguous),
        then falls back to matching against the app name.
        """
        if url:
            url_lower = url.lower()
            for signature, plat in AI_APP_SIGNATURES.items():
                if '.' in signature and signature.lower() in url_lower:
                    return plat
        if not app_name:
            return None
        app_lower = app_name.lower()
        for signature, plat in AI_APP_SIGNATURES.items():
            if signature.lower() in app_lower:
                return plat
        return None

    def _handle_app_switch(self, new_app, new_url, state):
        """Called whenever the active app changes. Updates category stats and logs switch events."""
        new_category = None
        if self.identify_platform(new_app, new_url):
            new_category = 'ai'
        elif self.identify_writing_app(new_app):
            new_category = 'writing'

        if new_category == self.last_app_category:
            return

        now = time.time()
        duration = int(now - self.category_entered_at) if self.category_entered_at else 0

        if self.last_app_category == 'ai':
            if duration > 0:
                self.ai_session_durations.append(duration)
            if new_category == 'writing':
                log_event('switch_to_writing', 'app_switch', duration,
                          source_app=new_app, dest_app='', state=state)
                self._last_transition = 'ai_to_writing'

        elif self.last_app_category == 'writing':
            if new_category == 'ai':
                log_event('switch_to_ai', 'app_switch', duration,
                          source_app=new_app, dest_app='', state=state)
                # Completing an AI→Writing→AI cycle
                if self._last_transition == 'ai_to_writing':
                    self.interleave_count += 1
                self._last_transition = 'writing_to_ai'

        if new_category == 'ai':
            self.ai_sessions += 1
        elif new_category == 'writing':
            self.writing_sessions += 1

        self.last_app_category = new_category
        self.category_entered_at = now

    def get_time_summary(self):
        """Return session duration and AI active time stats."""
        start = datetime.fromisoformat(self.time_tracker['session_start'].rstrip('Z'))
        session_seconds = (datetime.utcnow() - start).total_seconds()
        ai_seconds = self.time_tracker['ai_active_seconds']
        return {
            'session_start': self.time_tracker['session_start'],
            'session_minutes': round(session_seconds / 60, 1),
            'ai_active_minutes': round(ai_seconds / 60, 1),
            'ai_active_pct': round(ai_seconds / session_seconds * 100, 1) if session_seconds > 0 else 0.0,
        }

    def get_activity_pattern(self):
        """Return in-memory app-switch stats for export and display."""
        durations = self.ai_session_durations
        avg_ai = round(sum(durations) / len(durations), 1) if durations else 0.0
        return {
            'ai_sessions': self.ai_sessions,
            'writing_sessions': self.writing_sessions,
            'avg_ai_session_seconds': avg_ai,
            'interleave_count': self.interleave_count,
        }

    def identify_writing_app(self, app_name):
        """Identify if an app is a writing app."""
        if not app_name:
            return None
        app_lower = app_name.lower()
        for signature, app in WRITING_APP_SIGNATURES.items():
            if signature.lower() in app_lower:
                return app
        return None

    def monitor_loop(self):
        """Main monitoring loop — polls clipboard every 500ms."""
        last_text = self.get_clipboard_text()
        last_app = ''
        last_url = ''
        self.category_entered_at = time.time()

        while self.running:
            try:
                current_text = self.get_clipboard_text()
                current_app, current_url = self.get_active_app()

                # Detect app/tab switches and update category stats
                if current_app != last_app or current_url != last_url:
                    self._handle_app_switch(current_app, current_url, self.state_ref[0])

                # Accumulate AI active time every poll cycle
                if self.identify_platform(current_app, current_url):
                    self.time_tracker['ai_active_seconds'] += 0.5

                # Clipboard changed
                if current_text != last_text and len(current_text) > 5:
                    size = len(current_text)
                    ai_platform = self.identify_platform(current_app, current_url)
                    writing_app = self.identify_writing_app(last_app)

                    if ai_platform:
                        # Copied from an AI app
                        self.last_clipboard = current_text
                        self.last_size = size
                        self.last_source_app = current_app
                        self.last_source_url = current_url

                        log_event(
                            'clipboard_copy',
                            ai_platform,
                            size,
                            source_app=current_url or current_app,
                            dest_app='',
                            state=self.state_ref[0]
                        )
                        self.on_event('copy', ai_platform, size, current_url or current_app)

                    elif self.last_size > 0 and writing_app:
                        # Pasted into a writing app after copying from AI
                        log_event(
                            'clipboard_paste',
                            self.identify_platform(self.last_source_app, self.last_source_url) or 'unknown',
                            self.last_size,
                            source_app=self.last_source_url or self.last_source_app,
                            dest_app=current_app,
                            state=self.state_ref[0]
                        )
                        self.on_event('paste', writing_app, self.last_size, current_app)
                        self.last_size = 0
                        self.last_source_app = ''
                        self.last_source_url = ''

                last_text = current_text
                last_app = current_app
                last_url = current_url

            except Exception:
                pass

            time.sleep(0.5)

    def start(self):
        self.running = True
        self._thread = threading.Thread(target=self.monitor_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.running = False


# ── Windows tray icon ──
def _make_tray_icon():
    """Generate a 64×64 tray icon: dark ink background with amber 'I'."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (64, 64), color=(28, 28, 46))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('arial.ttf', 38)
    except Exception:
        font = ImageFont.load_default()
    try:
        bbox = draw.textbbox((0, 0), 'I', font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except AttributeError:  # Pillow < 9.2
        w, h = 10, 10
    draw.text(((64 - w) // 2, (64 - h) // 2), 'I', fill=(245, 158, 11), font=font)
    return img


def _run_windows():
    try:
        import pystray
    except ImportError:
        print("pystray required on Windows. Run: pip install pystray Pillow")
        sys.exit(1)

    state = load_state()
    monitor = ClipboardMonitor([state], lambda *a: None)
    if state.get('recording', True):
        monitor.start()

    def _status_text(item):
        summary = get_trail_summary(state)
        pattern = monitor.get_activity_pattern()
        time_s = monitor.get_time_summary()
        ai_min = int(time_s['ai_active_minutes'])
        return (
            f'Trail: {summary["copies"]} copies · '
            f'{pattern["ai_sessions"]} AI sessions · '
            f'{ai_min}min in AI apps'
        )

    def _recording_label(item):
        return 'Pause recording' if state.get('recording', True) else 'Resume recording'

    def _toggle_recording(icon, item):
        state['recording'] = not state.get('recording', True)
        save_state(state)
        if state['recording']:
            monitor.start()
        else:
            monitor.stop()

    def _set_manuscript(icon, item):
        import tkinter as tk
        from tkinter import simpledialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        ms = simpledialog.askstring(
            'Inkstain — Set Manuscript',
            'Manuscript title:',
            initialvalue=state.get('manuscript_title', ''),
            parent=root,
        )
        if ms is not None:
            state['manuscript_title'] = ms.strip()
        author = simpledialog.askstring(
            'Inkstain — Your Name',
            'Your name (as it appears on your certificate):',
            initialvalue=state.get('author_name', ''),
            parent=root,
        )
        if author is not None:
            state['author_name'] = author.strip()
        root.destroy()
        save_state(state)

    def _export(icon, item):
        import subprocess
        path = export_trail(
            state,
            monitor.get_activity_pattern(),
            monitor.get_time_summary(),
        )
        subprocess.Popen(['explorer', f'/select,{path}'])

    def _open_cert(icon, item):
        import webbrowser
        webbrowser.open('https://inkstain.ai/trail')

    def _quit(icon, item):
        monitor.stop()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem('Inkstain Trail', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(_recording_label, _toggle_recording),
        pystray.MenuItem('Set manuscript...', _set_manuscript),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(_status_text, None, enabled=False),
        pystray.MenuItem('Export Trail JSON', _export),
        pystray.MenuItem('Get certificate \u2192', _open_cert),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Quit', _quit),
    )

    icon = pystray.Icon('Inkstain Trail', _make_tray_icon(), 'Inkstain Trail', menu)
    icon.run()


# ── rumps Menubar App (Mac) / pystray Tray (Windows) ──
def run_app():
    if IS_WIN:
        init_db()
        _run_windows()
        return

    if not IS_MAC:
        print("Unsupported platform.")
        sys.exit(1)

    try:
        import rumps
    except ImportError:
        print("rumps not installed. Run: pip3 install rumps")
        sys.exit(1)

    init_db()

    class InkstainApp(rumps.App):
        def __init__(self):
            super().__init__('Inkstain', title='I')
            self.state = load_state()
            self.event_count = 0

            self.monitor = ClipboardMonitor([self.state], self.on_event)
            if self.state.get('recording', True):
                self.monitor.start()

            self._rebuild_menu()

            # Periodic menu refresh
            self._refresh_timer = rumps.Timer(self._refresh_menu, 5)
            self._refresh_timer.start()

        def on_event(self, event_type, platform, size, app_name):
            self.event_count += 1

        def _rebuild_menu(self):
            ms = self.state.get('manuscript_title', '')
            recording = self.state.get('recording', True)
            summary = get_trail_summary(self.state)
            pattern = self.monitor.get_activity_pattern()
            time_s = self.monitor.get_time_summary()

            header = rumps.MenuItem(
                f'Inkstain{"" if not ms else " · " + ms[:25]}',
                callback=None
            )

            rec_label = '⏸ Pause recording' if recording else '● Resume recording'
            rec_item = rumps.MenuItem(rec_label, callback=self.toggle_recording)

            ms_item = rumps.MenuItem('Set manuscript...', callback=self.set_manuscript)

            ai_min = int(time_s['ai_active_minutes'])
            status_label = (
                f'Trail: {summary["copies"]} copies · '
                f'{pattern["ai_sessions"]} AI sessions · '
                f'{ai_min}min in AI apps'
            )
            status_item = rumps.MenuItem(status_label, callback=None)

            export_item = rumps.MenuItem('Export Trail JSON', callback=self.export_trail_json)
            cert_item = rumps.MenuItem('Get certificate →', callback=self.open_cert)

            self.menu.clear()
            self.menu = [
                header,
                None,
                rec_item,
                ms_item,
                None,
                status_item,
                export_item,
                cert_item,
            ]

        def _refresh_menu(self, _timer):
            self._rebuild_menu()

        @rumps.clicked('⏸ Pause recording')
        def toggle_recording_pause(self, _):
            self._do_toggle_recording()

        @rumps.clicked('● Resume recording')
        def toggle_recording_resume(self, _):
            self._do_toggle_recording()

        def toggle_recording(self, _):
            self._do_toggle_recording()

        def _do_toggle_recording(self):
            self.state['recording'] = not self.state.get('recording', True)
            save_state(self.state)
            if self.state['recording']:
                self.monitor.start()
            else:
                self.monitor.stop()
            self._rebuild_menu()

        def set_manuscript(self, _):
            ms_response = rumps.Window(
                message='Manuscript title',
                title='Inkstain — Set Manuscript',
                default_text=self.state.get('manuscript_title', ''),
                ok='Save',
                cancel='Cancel',
                dimensions=(320, 24)
            ).run()
            if ms_response.clicked:
                self.state['manuscript_title'] = ms_response.text.strip()

                author_response = rumps.Window(
                    message='Your name (as it appears on your certificate)',
                    title='Inkstain — Your Name',
                    default_text=self.state.get('author_name', ''),
                    ok='Save',
                    cancel='Cancel',
                    dimensions=(320, 24)
                ).run()
                if author_response.clicked:
                    self.state['author_name'] = author_response.text.strip()

                save_state(self.state)
                self._rebuild_menu()

        def export_trail_json(self, _):
            import subprocess
            path = export_trail(
                self.state,
                self.monitor.get_activity_pattern(),
                self.monitor.get_time_summary(),
            )
            subprocess.run(['open', '-R', path])
            rumps.notification('Inkstain', 'Trail exported', path)

        def open_cert(self, _):
            import webbrowser
            webbrowser.open('https://inkstain.ai/trail')

    app = InkstainApp()
    rumps.notification('Inkstain Trail', '', 'Recording started. Your Trail is accumulating.')
    app.run()


if __name__ == '__main__':
    run_app()
