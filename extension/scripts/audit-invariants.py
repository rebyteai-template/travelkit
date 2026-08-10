"""Mechanically re-check the invariants this extension is only safe because of."""
import json, pathlib, re, sys

root = pathlib.Path('/Users/wangfulong/src/cc/travelkit')

def strip_comments(src: str) -> str:
    """These invariants are about what the code DOES. The comments deliberately name the very
    things that must not appear (`sessionStorage`, `td_tk`) in order to warn future editors off
    them, so matching raw text would flag the warning as the violation."""
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'^\s*//.*$', '', src, flags=re.M)

read = lambda p: strip_comments((root / p).read_text(encoding='utf8'))
ext_src = ' '.join(read(f'extension/src/{n}') for n in
                   ['background.ts', 'ctrip-content.ts', 'tripdesk-content.ts', 'extract/ctrip-extract.ts'])
mani = json.loads(read('extension/dist/manifest.json'))
bridge = read('extension/src/tripdesk-content.ts')
spa = read('src/hooks/useCtripBridge.ts')
routes = read('server/routes.ts')
sw = read('extension/src/background.ts')

checks = [
    ('权限：无 tabs',              'tabs' not in (mani.get('permissions') or [])),
    ('权限：无 <all_urls>',        '<all_urls>' not in json.dumps(mani)),
    ('权限：host 恰为携程+tripdesk',
        sorted(mani['host_permissions']) == ['https://flights.ctrip.com/*', 'https://tripdesk.impo.ai/*']),
    ('桥：不读 sessionStorage',    'sessionStorage' not in bridge),
    ('扩展：全域无 td_tk',          'td_tk' not in ext_src),
    ('扩展：全域无 X-Travelkit',    'X-Travelkit' not in ext_src),
    ('扩展：不自行 fetch 我方 API', 'fetch(' not in ext_src),
    ('扩展：无 Authorization 头',   'Authorization' not in ext_src),
    ('postMessage：无通配 "*"',     not re.search(r"postMessage\([^)]*,\s*['\"]\*['\"]", ext_src + spa)),
    # Both ends now compare against their OWN frame origin, which is strictly tighter than a
    # hardcoded constant: the bridge only exists on origins content_scripts.matches allowed.
    ('桥：校验 event.origin',       'event.origin === location.origin' in bridge),
    ('桥：校验 event.source',       'event.source === window' in bridge),
    ('SPA：校验 origin+source',
        'event.source !== window || event.origin !== window.location.origin' in spa),
    ('生产 manifest 无 localhost',
        not any('localhost' in x or '127.0.0.1' in x
                for x in mani['host_permissions'] + [m for cs in mani['content_scripts'] for m in cs['matches']])),
    ('SW：只开 flights.ctrip.com',  "hostname === 'flights.ctrip.com'" in sw),
    ('服务端：sourceUrl 白名单',    "startsWith('https://flights.ctrip.com/')" in routes),
    ('服务端：身份取自 session/path',
        'ownedTask(store, taskId, userEmail)' in routes and "c.req.param('planId')" in routes),
]

bad = 0
for name, ok in checks:
    print(f'  {"✅" if ok else "❌"} {name}')
    bad += not ok
print('\n全部通过' if not bad else f'\n{bad} 项未通过')
sys.exit(1 if bad else 0)
