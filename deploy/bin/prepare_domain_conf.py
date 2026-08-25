import json
from pathlib import Path

PRODUCT = Path('/home/aliveco/runflow/product/conf.json')
STAGING = Path('/home/aliveco/runflow/staging/conf.json')

def update(path, host, port, redirect_uri):
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    data.setdefault('server', {})['host'] = host
    data.setdefault('server', {})['port'] = port
    data.setdefault('polar', {})['redirectUri'] = redirect_uri
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

# After nginx is active, product should be private behind reverse proxy.
update(PRODUCT, '127.0.0.1', 8765, 'https://runflow.pro/api/polar/callback')
# Staging remains reachable only by high port unless a staging domain is added later.
update(STAGING, '0.0.0.0', 8766, 'http://109.120.156.101:8766/api/polar/callback')
