"""Tests for the authenticated streamable HTTP deployment."""

from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

import sk_agent


def test_streamable_http_requires_api_key():
    with patch.object(sk_agent, "_transport_mode", "streamable-http"), patch.object(
        sk_agent, "_http_api_key", ""
    ):
        with pytest.raises(RuntimeError, match="SK_AGENT_API_KEY is required"):
            sk_agent.main()


def test_streamable_http_uses_configured_host():
    with patch.object(sk_agent, "_transport_mode", "streamable-http"), patch.object(
        sk_agent, "_http_api_key", "test-only-key"
    ), patch.object(sk_agent, "_http_host", "127.0.0.1"), patch.object(
        sk_agent, "_build_http_app", return_value=Starlette()
    ), patch("uvicorn.run") as run:
        sk_agent.main()

    assert run.call_args.kwargs["host"] == "127.0.0.1"


def build_test_app():
    async def mcp_endpoint(request):
        return JSONResponse({"status": "mcp-reached"})

    test_app = Starlette(routes=[Route("/mcp", mcp_endpoint, methods=["POST"])])
    with patch.object(
        sk_agent.mcp_server, "streamable_http_app", return_value=test_app
    ):
        return sk_agent._build_http_app()


def test_http_auth_and_healthz(tmp_path: Path):
    config_path = tmp_path / "sk_agent_config.json"
    config_path.write_text(
        '{"config_version": 2, "models": [], "agents": [], "mcps": []}',
        encoding="utf-8",
    )

    with patch.object(sk_agent, "CONFIG_PATH", str(config_path)), patch.object(
        sk_agent, "_http_api_key", "test-only-key"
    ), patch.object(sk_agent, "_manager", None):
        with TestClient(build_test_app()) as client:
            health = client.get("/healthz")
            assert health.status_code == 200
            assert health.json() == {
                "status": "healthy",
                "config": "valid",
                "models_enabled": 0,
                "manager": "not_initialized",
            }

            unauthenticated = client.post("/mcp")
            assert unauthenticated.status_code == 401

            invalid = client.post(
                "/mcp", headers={"Authorization": "Bearer invalid-key"}
            )
            assert invalid.status_code == 401

            authenticated = client.post(
                "/mcp", headers={"Authorization": "Bearer test-only-key"}
            )
            assert authenticated.status_code == 200
            assert authenticated.json() == {"status": "mcp-reached"}

            for malformed_header in (
                "bearer test-only-key",
                "Bearer",
                "Basic test-only-key",
            ):
                response = client.post(
                    "/mcp", headers={"Authorization": malformed_header}
                )
                assert response.status_code == 401

            non_ascii = client.post(
                "/mcp", headers={"Authorization": b"Bearer t\xe9st-only-key"}
            )
            assert non_ascii.status_code == 401


def test_healthz_reports_missing_config(tmp_path: Path):
    config_path = tmp_path / "missing.json"

    with patch.object(sk_agent, "CONFIG_PATH", str(config_path)), patch.object(
        sk_agent, "_http_api_key", "test-only-key"
    ):
        with TestClient(build_test_app()) as client:
            response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json() == {"status": "unhealthy", "config": "missing"}


def test_healthz_reports_invalid_config(tmp_path: Path):
    config_path = tmp_path / "sk_agent_config.json"
    config_path.write_text("not-json", encoding="utf-8")

    with patch.object(sk_agent, "CONFIG_PATH", str(config_path)), patch.object(
        sk_agent, "_http_api_key", "test-only-key"
    ):
        with TestClient(build_test_app()) as client:
            response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json() == {"status": "unhealthy", "config": "invalid"}
