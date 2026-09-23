import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

VERSION = os.environ.get("APP_VERSION", "dev")

from . import runner, state_watch, storage
from .api.routes_programs import router as programs_router
from .api.routes_status import router as status_router
from .api.routes_zones import router as zones_router
from .scheduler import apply_timezone, scheduler, sync_all

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("stayliquid")


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init_db()

    await runner.recover_orphaned_runs()

    await state_watch.sync_watched_zones()
    state_watch.watcher.start()

    timezone_name = await apply_timezone()
    scheduler.start()
    sync_all()
    log.info(
        "StayLiquid %s ready - %d job(s) scheduled in %s",
        VERSION, len(scheduler.get_jobs()), timezone_name,
    )
    yield

    # Stop taking on new work, then close anything already open. This has to
    # happen here, while the event loop is still running: once shutdown cancels
    # the run tasks, their own cleanup can no longer await a turn-off call.
    scheduler.shutdown(wait=False)
    await runner.stop_all("add-on shutting down")
    await state_watch.watcher.stop()


app = FastAPI(title="StayLiquid", lifespan=lifespan)

# API routes first - StaticFiles is mounted at "/" below and would otherwise
# shadow everything under /api if it came first.
app.include_router(zones_router, prefix="/api")
app.include_router(programs_router, prefix="/api")
app.include_router(status_router, prefix="/api")


class RevalidatingStaticFiles(StaticFiles):
    """Serve the frontend with `Cache-Control: no-cache`.

    Starlette sends only last-modified and an ETag. With no explicit freshness
    directive a browser is free to apply heuristic caching, so after an add-on
    update it can keep serving the old app.js from cache without ever asking
    whether it changed - and because Ingress runs the add-on in an iframe, a
    hard refresh of the Home Assistant page doesn't clear it either.

    "no-cache" means revalidate, not don't store: the ETag still turns an
    unchanged file into a 304 with no body, so this costs a round trip, not
    bandwidth.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


# Ingress serves this add-on under a dynamic sub-path, so the frontend must
# only ever use relative fetch() URLs (e.g. "api/status", not "/api/status").
app.mount("/", RevalidatingStaticFiles(directory="web", html=True), name="web")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8099, log_level="info")
