"""Create an admin account (active straight away), prompting for its password.

    make admin EMAIL=you@company.com
    # or, from backend/ with .env loaded:
    python scripts/seed_admin.py you@company.com

An existing account with that email is promoted to an active admin instead; its
password is only changed if you type a new one.
"""

import asyncio
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.core.db import get_engine, get_sessionmaker  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import auth  # noqa: E402


async def main(email: str) -> None:
    email = email.strip().lower()
    async with get_sessionmaker()() as session:
        user = await session.scalar(select(User).where(User.email == email))
        if user is not None:
            password = getpass.getpass(f"New password for {email} (Enter to keep the current one): ")
            if password:
                if len(password) < 8 or password != getpass.getpass("Confirm: "):
                    sys.exit("Passwords must match and be at least 8 characters.")
                auth.set_password(user, password)
            user.role, user.status = "admin", "active"
            await session.commit()
            print(f"{email} is now an active admin (username: {user.username}).")
        else:
            password = getpass.getpass(f"Password for {email}: ")
            if len(password) < 8 or password != getpass.getpass("Confirm: "):
                sys.exit("Passwords must match and be at least 8 characters.")
            username = await auth.unique_username(session, auth.username_from_email(email))
            user = User(email=email, username=username, role="admin", status="active", password_hash="")
            auth.set_password(user, password)
            session.add(user)
            await session.commit()
            print(f"Admin {email} created (username: {username}).")
    await get_engine().dispose()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1]))
