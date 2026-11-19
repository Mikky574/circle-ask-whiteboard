"""Repository entry point for the installable whiteboard-service skill helper."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parents[1] / ".agents" / "skills" /
                       "whiteboard-service" / "scripts" / "whiteboard_service.py"), run_name="__main__")
