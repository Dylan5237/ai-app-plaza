from pathlib import Path
import json
import re
from portal_mock_data import build_payloads

root = Path(__file__).resolve().parent.parent
work = root / 'prototype'
source = root / 'generated' / 'portal-fragment.html'
source.parent.mkdir(parents=True, exist_ok=True)
fragment = (work / 'portal-square-shell.html').read_text(encoding='utf-8')
assert fragment.count('/* PT_PUBLISHER_FLOW */') == 1
fragment = fragment.replace('/* PT_PUBLISHER_FLOW */', (work / 'portal-publisher.js').read_text(encoding='utf-8'))
assert fragment.count('/* PT_PLATFORM_DEMO */') == 1
fragment = fragment.replace('/* PT_PLATFORM_DEMO */', (work / 'portal-platform-demo.js').read_text(encoding='utf-8'))
for identifier, data in build_payloads().items():
    payload = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    fragment, count = re.subn(r'(<script type="application/json" id="' + identifier + r'">).*?(</script>)', lambda m: m[1] + payload + m[2], fragment, count=1, flags=re.S)
    assert count == 1
source.write_text(fragment, encoding='utf-8')
print(source)
