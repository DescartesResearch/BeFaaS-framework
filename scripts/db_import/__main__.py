"""
Entry point for running db_import as a module.

Usage:
    python -m db_import <command> [options]

Commands:
    init        Initialize database schema
    import      Import a single experiment
    import-all  Import all experiments from a directory
    list        List all experiments
    delete      Delete an experiment
    stats       Show database statistics
    query       Run a SQL query
"""

from .cli import main

if __name__ == "__main__":
    main()