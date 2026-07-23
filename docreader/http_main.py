import base64
import json
import logging
import os
import re
import sys
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from docreader import config
from docreader.parser import Parser
from docreader.parser.registry import registry
from docreader.parser.web_parser import redact_url_for_log
from docreader.utils.request import init_logging_request_id, request_id_context

_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")


def to_valid_utf8_text(s: Any) -> str:
    if s is None:
        return ""
    text = str(s)
    text = _SURROGATE_RE.sub("\ufffd", text)
    return text.encode("utf-8", errors="replace").decode("utf-8")


for handler in logging.root.handlers[:]:
    logging.root.removeHandler(handler)

handler = logging.StreamHandler(sys.stdout)
logging.root.addHandler(handler)

_level_name = (os.environ.get("LOG_LEVEL") or "INFO").upper()
_level = getattr(logging, _level_name, logging.INFO)
logging.root.setLevel(_level)

logger = logging.getLogger(__name__)
init_logging_request_id()


def _mime_for_ref(ref_path: str) -> tuple[str, str]:
    mime_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
    }
    fname = os.path.basename(ref_path) or f"{uuid.uuid4().hex}.png"
    ext = os.path.splitext(fname)[1].lower()
    return fname, mime_map.get(ext, "application/octet-stream")


def _image_refs(images: dict[str, str]) -> list[dict[str, str]]:
    refs = []
    for ref_path, b64data in (images or {}).items():
        if isinstance(b64data, bytes):
            encoded = base64.b64encode(b64data).decode("ascii")
        else:
            encoded = str(b64data)
        fname, mime = _mime_for_ref(ref_path)
        refs.append(
            {
                "filename": fname,
                "original_ref": ref_path,
                "mime_type": mime,
                "image_data": encoded,
            }
        )
    return refs


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _write_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class DocReaderHTTPHandler(BaseHTTPRequestHandler):
    parser = Parser()

    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            _write_json(self, HTTPStatus.OK, {"status": "ok"})
            return
        _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/read":
            self._handle_read()
            return
        if self.path == "/list-engines":
            self._handle_list_engines()
            return
        _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _handle_read(self) -> None:
        request_id = str(uuid.uuid4())
        try:
            payload = _read_json(self)
            request_id = str(payload.get("request_id") or request_id)
            cfg = payload.get("config") or {}
            parser_engine = cfg.get("parser_engine") or ""
            engine_overrides = cfg.get("parser_engine_overrides") or {}

            with request_id_context(request_id):
                url = payload.get("url") or ""
                html = payload.get("html") or ""
                if html:
                    base_url = payload.get("base_url") or url
                    logger.info("HTTP Read(HTML): base_url=%s, size=%d chars", redact_url_for_log(base_url), len(html))
                    result = self.parser.parse_html(
                        html,
                        base_url,
                        payload.get("title") or "",
                        parser_engine=parser_engine,
                        engine_overrides=engine_overrides,
                    )
                elif url:
                    logger.info("HTTP Read(URL): url=%s", redact_url_for_log(url))
                    result = self.parser.parse_url(
                        url,
                        payload.get("title") or "",
                        parser_engine=parser_engine,
                        engine_overrides=engine_overrides,
                    )
                else:
                    file_content = base64.b64decode(payload.get("file_content") or "")
                    file_name = payload.get("file_name") or ""
                    file_type = payload.get("file_type") or os.path.splitext(file_name)[1][1:]
                    logger.info(
                        "HTTP Read(File): file=%s, type=%s, size=%d bytes",
                        file_name,
                        file_type,
                        len(file_content),
                    )
                    result = self.parser.parse_file(
                        file_name,
                        file_type,
                        file_content,
                        parser_engine=parser_engine,
                        engine_overrides=engine_overrides,
                    )

                if not result or not result.content:
                    _write_json(self, HTTPStatus.OK, {"error": "Failed to parse"})
                    return

                _write_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "markdown_content": to_valid_utf8_text(result.content),
                        "image_refs": _image_refs(result.images),
                        "image_dir_path": "",
                        "metadata": {
                            to_valid_utf8_text(k): to_valid_utf8_text(v)
                            for k, v in (result.metadata or {}).items()
                        },
                    },
                )
        except Exception as exc:
            logger.error("HTTP read failed: %s", exc)
            logger.info("Traceback: %s", traceback.format_exc())
            _write_json(self, HTTPStatus.OK, {"error": str(exc)})

    def _handle_list_engines(self) -> None:
        try:
            payload = _read_json(self)
            engines = registry.list_engines(payload.get("config_overrides") or None)
            _write_json(self, HTTPStatus.OK, {"engines": engines})
        except Exception as exc:
            _write_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})


def main() -> None:
    config.print_config()
    port = int(os.environ.get("DOCREADER_HTTP_PORT") or "8080")
    server = ThreadingHTTPServer(("0.0.0.0", port), DocReaderHTTPHandler)
    logger.info("HTTP DocReader server started on port %d", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Received termination signal, shutting down HTTP server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
