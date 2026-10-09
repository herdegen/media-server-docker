# Correctif local ROMarr 0.9.0 : Transmission n'a pas de completed(), donc rien n'est jamais importé.
# Inactif dès qu'une version upstream fournit la méthode.
import sys as _sys

if "/app" not in _sys.path:
    _sys.path.append("/app")

try:
    from romarr import downloaders as _d

    if not hasattr(_d.Transmission, "completed"):
        def _completed(self):
            if not self.configured:
                return []
            body = self._call("torrent-get", {"fields": [
                "name", "downloadDir", "percentDone", "leftUntilDone", "labels", "status"]})
            out = []
            for t in (body.get("arguments") or {}).get("torrents") or []:
                if t.get("leftUntilDone", 1) != 0 or t.get("percentDone", 0) < 1:
                    continue
                labels = t.get("labels") or []
                if self._config.category and labels and self._config.category not in labels:
                    continue
                save = (t.get("downloadDir") or "").rstrip("/")
                name = t.get("name", "")
                out.append({"name": name, "content_path": f"{save}/{name}",
                            "save_path": save, "state": "done"})
            return out

        _d.Transmission.completed = _completed
except Exception as _err:
    import sys
    print(f"sitecustomize romarr: correctif non appliqué ({_err})", file=sys.stderr)
