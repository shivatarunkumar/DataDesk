"""Moving and copying files and folders in a person's workspace.

Nothing is ever overwritten: a name already taken at the destination becomes "name (1)",
"name (2)" … the way OneDrive and Finder do it. A folder can't go into itself or into
one of its own folders.

Moving keeps a file what it is (its id, versions and load requests), and moves its
bytes in the bucket along with it, so the bucket keeps mirroring the folder tree. The
new objects are written before the database changes; the old ones are deleted only
after the commit (by the caller), so a failure never leaves a file without its bytes.

Copying makes new files from the current version of each file (a copy starts its own
history at v1) and recreates folders with everything inside them.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.storage import get_storage
from app.models.user import User
from app.models.workspace import WorkspaceFile, WorkspaceFileVersion, WorkspaceFolder
from app.schemas.workspace import TransferIn
from app.services.errors import NotFound, ServiceError
from app.services.workspace import run_storage

log = logging.getLogger("datadesk.transfer")

# most files one move or copy may touch, folders' contents included
MAX_FILES = 1000


@dataclass
class Outcome:
    files: int = 0
    folders: int = 0
    renamed: list[str] = field(default_factory=list)
    # objects to delete once the move is committed
    stale_objects: list[str] = field(default_factory=list)
    # objects written for this move or copy: deleted again if it fails
    new_objects: list[str] = field(default_factory=list)


def free_name(name: str, taken: set[str], is_file: bool) -> str:
    """`name`, or "name (1)", "name (2)" … whichever isn't taken (the extension stays last)."""
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".") if is_file and "." in name.lstrip(".") else (name, "", "")
    # "sales (1).csv" taken → "sales (2).csv", not "sales (1) (1).csv"
    numbered = re.fullmatch(r"(.*) \((\d+)\)", stem)
    if numbered:
        stem = numbered.group(1)
    n = int(numbered.group(2)) + 1 if numbered else 1
    while f"{stem} ({n}){dot}{ext}" in taken:
        n += 1
    return f"{stem} ({n}){dot}{ext}"


class _Workspace:
    """One person's folders and files, loaded once, for working out paths and names."""

    def __init__(self, folders: list[WorkspaceFolder], files: list[WorkspaceFile]) -> None:
        self.folders = {f.id: f for f in folders}
        self.files = files

    def path(self, folder_id: uuid.UUID | None) -> str:
        return self.folders[folder_id].path if folder_id else ""

    def subtree(self, folder: WorkspaceFolder) -> list[WorkspaceFolder]:
        """The folder and every folder inside it, parents before children."""
        inside = [
            f for f in self.folders.values() if f.path == folder.path or f.path.startswith(folder.path + "/")
        ]
        return sorted(inside, key=lambda f: f.path.count("/"))

    def within(self, folder_id: uuid.UUID | None, ancestor: WorkspaceFolder) -> bool:
        path = self.path(folder_id)
        return path == ancestor.path or path.startswith(ancestor.path + "/")

    def folder_names(self, parent_id: uuid.UUID | None) -> set[str]:
        return {f.name for f in self.folders.values() if f.parent_id == parent_id}

    def file_names(self, folder_id: uuid.UUID | None) -> set[str]:
        return {f.original_name for f in self.files if f.folder_id == folder_id}


async def _load(session: AsyncSession, user: User, body: TransferIn):
    folders = list(await session.scalars(select(WorkspaceFolder).where(WorkspaceFolder.user_id == user.id)))
    files = list(
        await session.scalars(
            select(WorkspaceFile).where(WorkspaceFile.user_id == user.id, WorkspaceFile.status == "active")
        )
    )
    ws = _Workspace(folders, files)
    if body.destination_id and body.destination_id not in ws.folders:
        raise NotFound("Destination folder")
    chosen_folders = [ws.folders[i] for i in dict.fromkeys(body.folder_ids) if i in ws.folders]
    by_id = {f.id: f for f in files}
    chosen_files = [by_id[i] for i in dict.fromkeys(body.file_ids) if i in by_id]
    if len(chosen_folders) != len(set(body.folder_ids)) or len(chosen_files) != len(set(body.file_ids)):
        raise NotFound("One of the selected items")
    if not chosen_folders and not chosen_files:
        raise ServiceError("Select something to move or copy.")

    # a folder inside another selected folder travels with it; so does a file
    chosen_folders = [
        f for f in chosen_folders if not any(o is not f and ws.within(f.parent_id, o) for o in chosen_folders)
    ]
    chosen_files = [f for f in chosen_files if not any(ws.within(f.folder_id, o) for o in chosen_folders)]
    for f in chosen_folders:
        if body.destination_id and ws.within(body.destination_id, f):
            raise ServiceError(f"{f.name} can't go inside itself.", status_code=409)

    touched = len(chosen_files) + sum(
        1 for f in files for o in chosen_folders if f.folder_id and ws.within(f.folder_id, o)
    )
    if touched > MAX_FILES:
        raise ServiceError(
            f"That is {touched} files; move or copy up to {MAX_FILES} at a time.", status_code=413
        )
    return ws, chosen_folders, chosen_files


# ------------------------------------------------------------------ move
async def _move_bytes(session: AsyncSession, user: User, file: WorkspaceFile, folder_path: str, out: Outcome):
    """Every version of the file to its new place in the bucket."""
    storage = get_storage()
    versions = list(
        await session.scalars(select(WorkspaceFileVersion).where(WorkspaceFileVersion.file_id == file.id))
    )
    for v in versions:
        new_path = storage.object_path(str(user.id), v.version, file.original_name, folder_path)
        if new_path == v.gcs_path:
            continue
        await run_storage(storage.copy, v.gcs_path, new_path)
        out.new_objects.append(new_path)
        out.stale_objects.append(v.gcs_path)
        if file.current_gcs_path == v.gcs_path:
            file.current_gcs_path = new_path
        v.gcs_path = new_path


async def move(session: AsyncSession, user: User, body: TransferIn, out: Outcome) -> Outcome:
    ws, folders, files = await _load(session, user, body)
    dest = body.destination_id
    dest_path = ws.path(dest)
    storage = get_storage()

    for folder in folders:
        if folder.parent_id == dest:
            continue  # already there
        name = free_name(folder.name, ws.folder_names(dest), is_file=False)
        if name != folder.name:
            out.renamed.append(f"{folder.name} → {name}")
        old_root = folder.path
        new_root = f"{dest_path}/{name}" if dest_path else name
        subtree = ws.subtree(folder)
        folder.parent_id, folder.name = dest, name
        for f in subtree:
            old_path = f.path
            f.path = new_root + f.path[len(old_root) :]
            if storage.configured:
                await run_storage(
                    storage.upload,
                    storage.folder_marker_path(str(user.id), f.path),
                    b"",
                    "application/x-directory",
                )
                out.new_objects.append(storage.folder_marker_path(str(user.id), f.path))
                out.stale_objects.append(storage.folder_marker_path(str(user.id), old_path))
            out.folders += 1
        ids = {f.id for f in subtree}
        for file in ws.files:
            if file.folder_id in ids:
                await _move_bytes(session, user, file, ws.path(file.folder_id), out)
                out.files += 1

    for file in files:
        if file.folder_id == dest:
            continue
        name = free_name(file.original_name, ws.file_names(dest), is_file=True)
        if name != file.original_name:
            out.renamed.append(f"{file.original_name} → {name}")
        file.original_name, file.folder_id = name, dest
        await _move_bytes(session, user, file, dest_path, out)
        out.files += 1

    await session.flush()
    log.info("moved %d files, %d folders to %s", out.files, out.folders, dest_path or "My files")
    return out


# ------------------------------------------------------------------ copy
async def _copy_file(
    session: AsyncSession,
    user: User,
    file: WorkspaceFile,
    folder_id: uuid.UUID | None,
    folder_path: str,
    name: str,
    out: Outcome,
) -> WorkspaceFile:
    storage = get_storage()
    path = storage.object_path(str(user.id), 1, name, folder_path)
    await run_storage(storage.copy, file.current_gcs_path, path)
    out.new_objects.append(path)
    copy = WorkspaceFile(
        id=uuid.uuid4(),
        user_id=user.id,
        folder_id=folder_id,
        original_name=name,
        format=file.format,
        current_version=1,
        current_gcs_path=path,
        row_count=file.row_count,
        column_meta=file.column_meta,
        size_bytes=file.size_bytes,
        is_permanent=False,
    )
    session.add(copy)
    session.add(
        WorkspaceFileVersion(
            file_id=copy.id,
            version=1,
            gcs_path=path,
            row_count=file.row_count,
            size_bytes=file.size_bytes,
            note=f"Copied from {file.original_name} v{file.current_version}",
            created_by=user.id,
        )
    )
    return copy


async def copy(session: AsyncSession, user: User, body: TransferIn, out: Outcome) -> Outcome:
    ws, folders, files = await _load(session, user, body)
    dest = body.destination_id
    dest_path = ws.path(dest)
    storage = get_storage()

    for folder in folders:
        name = free_name(folder.name, ws.folder_names(dest), is_file=False)
        if name != folder.name:
            out.renamed.append(f"{folder.name} → {name}")
        old_root = folder.path
        new_root = f"{dest_path}/{name}" if dest_path else name
        subtree = ws.subtree(folder)
        made: dict[uuid.UUID, WorkspaceFolder] = {}
        for f in subtree:  # parents first, so each copy's parent exists
            new = WorkspaceFolder(
                id=uuid.uuid4(),
                user_id=user.id,
                parent_id=dest if f is folder else made[f.parent_id].id,
                name=name if f is folder else f.name,
                path=new_root + f.path[len(old_root) :],
            )
            session.add(new)
            made[f.id] = new
            ws.folders[new.id] = new
            if storage.configured:
                await run_storage(
                    storage.upload,
                    storage.folder_marker_path(str(user.id), new.path),
                    b"",
                    "application/x-directory",
                )
                out.new_objects.append(storage.folder_marker_path(str(user.id), new.path))
            out.folders += 1
        await session.flush()  # the new folders exist before files are put in them
        for file in [f for f in ws.files if f.folder_id in made]:
            target = made[file.folder_id]
            ws.files.append(
                await _copy_file(session, user, file, target.id, target.path, file.original_name, out)
            )
            out.files += 1

    for file in files:
        name = free_name(file.original_name, ws.file_names(dest), is_file=True)
        if name != file.original_name:
            out.renamed.append(f"{file.original_name} → {name}")
        ws.files.append(await _copy_file(session, user, file, dest, dest_path, name, out))
        out.files += 1

    await session.flush()
    log.info("copied %d files, %d folders to %s", out.files, out.folders, dest_path or "My files")
    return out
