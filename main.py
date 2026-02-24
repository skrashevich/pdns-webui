"""
PowerDNS Web UI - FastAPI backend
Proxies requests to the PowerDNS HTTP API and serves the frontend SPA.
"""
import os
import logging

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PowerDNS Web UI", version="1.0.0")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


def get_pdns_config() -> dict:
    return {
        "url": os.getenv("PDNS_API_URL", "http://localhost:8081").rstrip("/"),
        "key": os.getenv("PDNS_API_KEY", "changeme"),
        "server_id": os.getenv("PDNS_SERVER_ID", "localhost"),
    }


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/config")
async def api_config():
    cfg = get_pdns_config()
    return {"server_id": cfg["server_id"]}


@app.api_route(
    "/api/pdns/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def proxy_to_pdns(request: Request, path: str):
    cfg = get_pdns_config()
    target_url = f"{cfg['url']}/api/v1/{path}"

    query = str(request.url.query)
    if query:
        target_url += f"?{query}"

    body = await request.body()

    headers = {
        "X-API-Key": cfg["key"],
        "Accept": "application/json",
    }
    if body:
        headers["Content-Type"] = "application/json"

    logger.info("%s %s", request.method, target_url)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

        if response.status_code == 204:
            return JSONResponse(content=None, status_code=204)

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                data = response.json()
                return JSONResponse(content=data, status_code=response.status_code)
            except Exception:
                pass

        # Non-JSON response (e.g. zone export returns plain text)
        return JSONResponse(
            content={"result": response.text},
            status_code=response.status_code,
        )

    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Cannot connect to PowerDNS API at {cfg['url']}: {exc}",
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="PowerDNS API request timed out",
        )
    except Exception as exc:
        logger.exception("Unexpected proxy error")
        raise HTTPException(status_code=500, detail=str(exc))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8080")),
        reload=os.getenv("DEBUG", "").lower() in ("1", "true", "yes"),
    )
