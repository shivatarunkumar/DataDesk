from fastapi import APIRouter

from app.api.v1 import admin, auth, health, onboarding, requests, studio, workspace

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(workspace.router)
api_router.include_router(requests.router)
api_router.include_router(admin.router)
api_router.include_router(onboarding.router)
api_router.include_router(studio.router)
