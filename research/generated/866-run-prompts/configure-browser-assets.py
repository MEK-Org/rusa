from pathlib import Path
import json, shutil, sys
output, font, base = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
fonts = output / "assets/fonts"
fonts.mkdir(exist_ok=True)
shutil.copy2(font, fonts / "Roboto-Regular.ttf")
p = output / "assets/FontManifest.json"
manifest = json.loads(p.read_text())
manifest = [entry for entry in manifest if entry["family"] != "Roboto"]
manifest.append({"family": "Roboto", "fonts": [{"asset": "fonts/Roboto-Regular.ttf"}]})
p.write_text(json.dumps(manifest))
p = output / "index.html"
p.write_text(p.read_text().replace('<base href="/">', f'<base href="/{base}/">'))
