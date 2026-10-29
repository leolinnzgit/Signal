"""Embed the checked lunar calendar for offline web and optional Watch use."""
import argparse
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
parser.add_argument('--watch-project', type=Path)
args = parser.parse_args()
repository = Path(__file__).resolve().parent.parent
dates = json.loads((repository / 'public/seasonal-calendar.json').read_text(encoding='utf-8'))['chineseNewYear']
targets = [(repository / 'public/seasonal-branding.js', '  const chineseNewYear = ' + json.dumps(dates, indent=2) + ';')]
if args.watch_project:
    entries = ',\n'.join(f'        {year} to "{date}"' for year, date in dates.items())
    targets.append((args.watch_project / 'app/src/main/java/nz/signal/watch/SeasonalBranding.kt',
                    '    private val chineseNewYear = mapOf(\n' + entries + '\n    )'))
for path, replacement in targets:
    source = path.read_text(encoding='utf-8')
    updated, count = re.subn(r'(?<=// BEGIN GENERATED CALENDAR\n).*?(?=\n\s*// END GENERATED CALENDAR)',
                             lambda _: replacement, source, flags=re.S)
    if count != 1:
        raise SystemExit(f'Expected exactly one calendar block: {path}')
    if args.check and updated != source:
        raise SystemExit(f'Calendar is out of sync: {path}')
    if not args.check:
        path.write_text(updated, encoding='utf-8')
print('Seasonal calendar is in sync.')
