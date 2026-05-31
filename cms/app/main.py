import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from . import config, db, auth
from .routes import web as web_routes
from .routes import api as api_routes


log = logging.getLogger("piplayer.cms")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates.env.globals["app_name"] = "PiPlayer"


def create_app() -> FastAPI:
    config.ensure_dirs()
    db.init_schema()
    username, generated_password = auth.ensure_admin_user()
    if generated_password:
        log.warning("=" * 72)
        log.warning("Created admin user '%s' with generated password: %s", username, generated_password)
        log.warning("Save this password now. It will not be shown again.")
        log.warning("Override at install time with PIPLAYER_ADMIN_PASSWORD env var.")
        log.warning("=" * 72)

    app = FastAPI(title="PiPlayer CMS", docs_url=None, redoc_url=None)
    app.add_middleware(
        SessionMiddleware,
        secret_key=config.SECRET_KEY,
        session_cookie=config.SESSION_COOKIE,
        max_age=config.SESSION_MAX_AGE,
        same_site="lax",
        https_only=False,
    )

    app.state.templates = templates
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    app.include_router(web_routes.router)
    app.include_router(api_routes.router, prefix="/api")

    @app.get("/")
    def root(request: Request):
        if auth.current_user(request):
            return RedirectResponse("/dashboard", status_code=303)
        return RedirectResponse("/login", status_code=303)

    return app


app = create_app()
