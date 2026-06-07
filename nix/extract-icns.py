#!/usr/bin/env python3
import struct, os, sys

icns_path, icon_root = sys.argv[1], sys.argv[2]
with open(icns_path, 'rb') as f:
    data = f.read()

size_map = {b'ic07': 128, b'ic08': 256, b'ic09': 512, b'ic10': 1024}
installed = []
offset = 8
while offset < len(data) - 8:
    chunk_type = data[offset:offset + 4]
    chunk_size = struct.unpack('>I', data[offset + 4:offset + 8])[0]
    if chunk_size < 8:
        break
    chunk_data = data[offset + 8:offset + chunk_size]
    px = size_map.get(chunk_type)
    if px and chunk_data[:8] == b'\x89PNG\r\n\x1a\n':
        d = os.path.join(icon_root, f'{px}x{px}', 'apps')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'claude.png'), 'wb') as out:
            out.write(chunk_data)
        installed.append(px)
    offset += chunk_size

if not installed:
    raise SystemExit('No PNG chunks found in .icns')
print(f"Installed icon sizes: {sorted(installed)}")
