import os
from urllib.parse import quote_plus

DB_TYPE = "postgresql"

DB_HOST = os.environ.get("PGHOST", "localhost")
DB_PORT = int(os.environ.get("PGPORT", "5432"))
DB_NAME = os.environ.get("PGDATABASE", "postgres")
DB_USER = os.environ.get("PGUSER", "postgres")
DB_PASSWORD = os.environ.get("PGPASSWORD", "")


def get_config() -> dict:
    return {
        "type": DB_TYPE,
        "host": DB_HOST,
        "port": DB_PORT,
        "name": DB_NAME,
        "user": DB_USER,
        "password": DB_PASSWORD,
    }


def get_database_url() -> str:
    if DB_TYPE.lower() not in ("postgresql", "postgres", "pg"):
        raise ValueError("Only PostgreSQL is supported. Set DB_TYPE='postgresql'")

    # URL-encode password to handle special characters
    password = quote_plus(DB_PASSWORD) if DB_PASSWORD else ""

    if password:
        return f"postgresql://{DB_USER}:{password}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    else:
        return f"postgresql://{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}"


def print_config():
    print("Database Configuration:")
    print(f"  Type:     {DB_TYPE}")
    print(f"  Host:     {DB_HOST}")
    print(f"  Port:     {DB_PORT}")
    print(f"  Database: {DB_NAME}")
    print(f"  User:     {DB_USER}")
    print(f"  Password: {'*' * len(DB_PASSWORD) if DB_PASSWORD else '(not set)'}")

    masked_url = get_database_url()
    if DB_PASSWORD:
        masked_url = masked_url.replace(quote_plus(DB_PASSWORD), "***")
    print(f"\nConnection URL: {masked_url}")


if __name__ == "__main__":
    print_config()