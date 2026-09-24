from fastapi import Header, HTTPException

from app.auth_utils import decode_token


def parse_token(authorization: str) -> dict:
    try:
        token = authorization.removeprefix("Bearer ")
        return decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


async def require_admin(authorization: str = Header(...)) -> dict:
    payload = parse_token(authorization)
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required.")
    return payload
