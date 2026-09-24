"""Set someone's password directly in the database, e.g. a locked-out admin.

    make reset-password LOGIN=<email or username>
    # or, from backend/ with .env loaded:
    python scripts/reset_password.py <email or username>

Also clears a lockout from too many failed sign-ins.
"""

import asyncio
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import get_engine, get_sessionmaker  # noqa: E402
from app.services import auth  # noqa: E402


async def main(login: str) -> None:
    async with get_sessionmaker()() as session:
        user = await auth.find_by_login(session, login.strip().lower())
        if user is None:
            sys.exit(f"No account found for '{login}'.")
        password = getpass.getpass(f"New password for {user.username}: ")
        if len(password) < 8 or password != getpass.getpass("Confirm: "):
            sys.exit("Passwords must match and be at least 8 characters.")
        auth.set_password(user, password)
        await session.commit()
    await get_engine().dispose()
    print("Password updated.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1]))
