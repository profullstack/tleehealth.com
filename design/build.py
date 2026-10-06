#!/usr/bin/env python3
"""Turn the design canvas artboards (design/*.dc.html) into the static pages the
web app serves (apps/web/public/*.html). Drops the x-dc wrapper and script and
fills {{accent}} with the brand accent. Re-run after editing an artboard:

    python3 design/build.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ACCENT = '#7CF2B0'
PAGES = {
    'Main.dc.html': ('index.html', 'tleehealth: the practice that runs itself',
                     'Telehealth and practice management with an AI agent that calls every patient. '
                     'Scheduling, prescriptions, labs and health-record import. $10 per seat or $199 for up to 1,000.',
                     'https://tleehealth.com/'),
}

for src, (out, title, desc, canonical) in PAGES.items():
    text = (ROOT / 'design' / src).read_text()
    helmet = re.search(r'<helmet>(.*?)</helmet>', text, re.S).group(1).strip()
    body = re.search(r'</helmet>(.*?)</x-dc>', text, re.S).group(1).strip()
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0A0D0C">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
{helmet}
</head>
<body>
{body}
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{{}});</script>
</body>
</html>
'''.replace('{{accent}}', ACCENT)
    if out == 'index.html':
        # The landing page's placeholder links: the logo goes home, Sign in goes to
        # sign-in, and every Start button goes to the app (which signs you in first).
        page = page.replace('href="#"', 'href="/"', 1)
        page = re.sub(r'href="#"(?=[^>]*>\s*Sign in)', 'href="/signin"', page)
        page = re.sub(r'href="#"(?=[^>]*>\s*Start)', 'href="/app"', page)
    assert '{{' not in page, f'unfilled hole in {src}'
    (ROOT / 'apps/web/public' / out).write_text(page)
    print(f'{src} -> apps/web/public/{out} ({len(page)} bytes)')
