import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import runner, storage
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

    timezone_name = await apply_timezone()
    scheduler.start()
    sync_all()
    log.info(
        "StayLiquid ready - %d job(s) scheduled in %s",
        len(scheduler.get_jobs()), timezone_name,
    )
    yield

    # Stop taking on new work, then close anything already open. This has to
    # happen here, while the event loop is still running: once shutdown cancels
    # the run tasks, their own cleanup can no longer await a turn-off call.
    scheduler.shutdown(wait=False)
    await runner.stop_all("add-on shutting down")


app = FastAPI(title="StayLiquid", lifespan=lifespan)

# API routes first - StaticFiles is mounted at "/" below and would otherwise
# shadow everything under /api if it came first.
app.include_router(zones_router, prefix="/api")
app.include_router(programs_router, prefix="/api")
app.include_router(status_router, prefix="/api")


# Ingress serves this add-on under a dynamic sub-path, so the frontend must
# only ever use relative fetch() URLs (e.g. "api/status", not "/api/status").
app.mount("/", StaticFiles(directory="web", html=True), name="web")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8099, log_level="info")
