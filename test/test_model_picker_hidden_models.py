"""Dashboard model picker visibility configuration."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from dashboard_owner_helpers import as_owner

from kiro_crew.config.loader import KiroCrewConfig


@pytest.fixture()
def cfg_file(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{}", encoding="utf-8")
    with patch("kiro_crew.config.loader.config_path", return_value=path):
        yield path


@pytest.fixture()
def handler_app(cfg_file):
    from kiro_crew.dashboard.handlers.files import api_dashboard_config

    audit = MagicMock()
    with patch("kiro_crew.dashboard.handlers.files._sel", return_value=audit):
        app = web.Application()
        app.router.add_get("/api/dashboard/config", api_dashboard_config)
        app.router.add_put("/api/dashboard/config", api_dashboard_config)
        yield as_owner(app)


def test_default_is_empty():
    assert KiroCrewConfig().dashboard.model_picker_hidden_models == []


def test_loader_trims_deduplicates_and_ignores_auto(cfg_file):
    cfg_file.write_text(
        json.dumps(
            {
                "dashboard": {
                    "model_picker_hidden_models": [
                        " model-a ",
                        "model-a",
                        "",
                        "auto",
                        7,
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    assert KiroCrewConfig.load().dashboard.model_picker_hidden_models == ["model-a"]


def test_loader_rejects_non_array_shape_to_default(cfg_file):
    cfg_file.write_text(
        json.dumps({"dashboard": {"model_picker_hidden_models": "model-a"}}),
        encoding="utf-8",
    )
    assert KiroCrewConfig.load().dashboard.model_picker_hidden_models == []


@pytest.mark.asyncio
async def test_dashboard_put_round_trips_normalized_ids(handler_app):
    async with TestClient(TestServer(handler_app)) as client:
        response = await client.put(
            "/api/dashboard/config",
            json={"model_picker_hidden_models": [" model-a ", "model-a", "auto", ""]},
        )
        assert response.status == 200
        get_response = await client.get("/api/dashboard/config")
        assert get_response.status == 200
        body = await get_response.json()
        assert body["model_picker_hidden_models"] == ["model-a"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value",
    ["model-a", [1], ["bad/model"]],
)
async def test_dashboard_put_rejects_invalid_values(handler_app, value):
    async with TestClient(TestServer(handler_app)) as client:
        response = await client.put(
            "/api/dashboard/config", json={"model_picker_hidden_models": value}
        )
        assert response.status == 400
        assert (await response.json())["code"] == "invalid_model_picker_hidden_models"


@pytest.mark.asyncio
async def test_dashboard_put_rejects_oversized_list(handler_app):
    async with TestClient(TestServer(handler_app)) as client:
        response = await client.put(
            "/api/dashboard/config",
            json={"model_picker_hidden_models": [f"model-{i}" for i in range(129)]},
        )
        assert response.status == 400
