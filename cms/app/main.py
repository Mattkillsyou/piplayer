import logging
import sqlite3
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import config, db, auth
from .routes import web as web_routes
from .routes import api as api_routes


log = logging.getLogger("piplayer.cms")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = Path(__file__).parent / "static"


def create_app() -> FastAPI:
    config.ensure_dirs()
    db.init_schema()
    username, generated_password, created = auth.ensure_admin_user()
    if created and generated_password:
        log.warning("=" * 72)
        log.warning("Created admin user '%s' with generated password: %s", username, generated_password)
        log.warning("Save this password now. It will not be shown again.")
        log.warning("Override at install time with PIPLAYER_ADMIN_PASSWORD env var.")
        log.warning("=" * 72)
    elif created:
        log.info("admin user '%s' created from PIPLAYER_ADMIN_PASSWORD", username)
    if config.SECRET_KEY_GENERATED:
        log.warning("PIPLAYER_SECRET_KEY is not set: using a random session key, "
                    "so all logins will be invalidated whenever this process restarts")
    web_routes.sweep_upload_tmp()
    db.enrollment_key()  # generated at startup when missing (never logged)
    pruned = db.prune_audit_log(config.AUDIT_RETENTION_DAYS)
    if pruned:
        log.info("pruned %d audit log rows older than %d days", pruned, config.AUDIT_RETENTION_DAYS)

    app = FastAPI(title="Projection5000 CMS", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        SessionMiddleware,
        secret_key=config.SECRET_KEY,
        session_cookie=config.SESSION_COOKIE,
        max_age=config.SESSION_MAX_AGE,
        same_site="lax",
        https_only=config.HTTPS_ONLY,
    )

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    app.include_router(web_routes.router)
    app.include_router(api_routes.router, prefix="/api")

    @app.exception_handler(sqlite3.IntegrityError)
    async def integrity_error(request: Request, exc: sqlite3.IntegrityError):
        # A constraint violation that no route mapped itself: never a bare 500, and never
        # the sqlite text (table/column names) in the response.
        log.exception("integrity error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "conflicts with an existing record or references one that does not exist"},
                            status_code=409)

    @app.exception_handler(sqlite3.OperationalError)
    async def operational_error(request: Request, exc: sqlite3.OperationalError):
        # Writer starvation past the busy timeout ("database is locked") or an I/O error:
        # a clean, retryable answer instead of a bare 500 page.
        log.exception("database error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "database busy, try again"}, status_code=503,
                            headers={"Retry-After": "2"})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Contract 10: malformed input is 400 {detail}, also when FastAPI's own parameter
        # parsing rejects it (non-integer path id, empty required form field, bad query).
        errs = exc.errors()
        first = errs[0] if errs else {}
        where = ".".join(str(x) for x in first.get("loc", ()))
        msg = first.get("msg", "invalid input")
        return JSONResponse({"detail": f"{where}: {msg}" if where else msg}, status_code=400)

    @app.get("/")
    def root(request: Request):
        if auth.current_user(request):
            return RedirectResponse("/dashboard", status_code=303)
        return RedirectResponse("/login", status_code=303)

    return app


app = create_app()
