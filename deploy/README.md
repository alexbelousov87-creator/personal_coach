# Runflow HTTPS/DNS setup

Prepared for:
- Product app: `127.0.0.1:8765` behind nginx
- Public domain: `https://runflow.pro`
- Staging app: `0.0.0.0:8766` for direct testing

Before running HTTPS setup:
1. DNS A-record: `runflow.pro -> 109.120.156.101`
2. Optional DNS A-record: `www.runflow.pro -> 109.120.156.101`
3. VPS firewall/provider security group allows TCP 80 and 443.
4. You have root/sudo access.

Apply when DNS is ready:

```bash
sudo bash /home/aliveco/runflow/deploy/setup_https_runflow.sh
```

After that:
- Product: `https://runflow.pro`
- Staging: `http://109.120.156.101:8766`

Polar settings after HTTPS:
- Redirect URI: `https://runflow.pro/api/polar/callback`
