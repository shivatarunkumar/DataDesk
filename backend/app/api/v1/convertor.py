"""Convertor: the sheets of an Excel workbook (.xlsx) to CSV files in My files.

    POST /convertor/folder                 My files › Convertor, made if missing (new uploads go there)
    GET  /convertor/files/{id}/sheets      the workbook's sheets, with their size and first rows
    POST /convertor/convert                chosen sheets → CSV files in a folder

The logic lives in services/convertor.py.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.core.config import Settings, get_settings
from app.core.db import get_session
from app.models.user import User
from app.schemas.workspace import FileOut, FolderOut
from app.services import convertor
from app.services import workspace as ws

router = APIRouter(prefix="/convertor", tags=["convertor"])


class SheetOut(BaseModel):
    name: str
    rows: int
    columns: int
    preview: list[list[str]]


class WorkbookOut(BaseModel):
    file_id: uuid.UUID
    workbook: str
    folder_id: uuid.UUID | None
    sheets: list[SheetOut]


class SheetChoice(BaseModel):
    sheet: str = Field(min_length=1, max_length=200)
    # the CSV's name; empty → the sheet's name
    name: str | None = Field(default=None, max_length=200)


class ConvertIn(BaseModel):
    file_id: uuid.UUID
    sheets: list[SheetChoice] = Field(min_length=1, max_length=200)
    delimiter: Literal["comma", "tab", "semicolon", "pipe"] = "comma"
    # where to save them; none → the top of My files
    folder_id: uuid.UUID | None = None


class ConvertOut(BaseModel):
    files: list[FileOut]
    # "name → new name" for names already taken in the folder
    renamed: list[str] = []


@router.post("/folder", response_model=FolderOut)
async def convertor_folder(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    folder = await ws.ensure_folder(session, user.id, convertor.CONVERTOR_FOLDER)
    await session.commit()
    return folder


@router.get("/files/{file_id}/sheets", response_model=WorkbookOut)
async def sheets(
    file_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    return await convertor.inspect(session, settings, user, file_id)


@router.post("/convert", response_model=ConvertOut)
async def convert(
    body: ConvertIn,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    files, renamed = await convertor.convert(
        session,
        settings,
        user,
        body.file_id,
        [(c.sheet, (c.name or "").strip()) for c in body.sheets],
        body.delimiter,
        body.folder_id,
    )
    await session.commit()
    for f in files:
        await session.refresh(f)
    return ConvertOut(files=files, renamed=renamed)
