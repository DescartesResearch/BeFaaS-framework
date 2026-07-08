import argparse
import sys
from pathlib import Path

from sqlalchemy import create_engine, select, func, text
from sqlalchemy.pool import QueuePool
from sqlalchemy.orm import Session

from .schema import (
    Base, Experiment, Request, LambdaExecution, HandlerEvent,
    ContainerStart, RpcCall,
    MetricsEcs, MetricsAlb, Phase, ScalingRule,
)
from .importer import import_experiment, import_all_experiments, init_database, backfill_nulls, _run_post_processing, _calculate_phase_starts


def get_database_url() -> str:
    """Get PostgreSQL database URL from config."""
    from .config import get_database_url as get_url
    return get_url()


def create_db_engine(url: str, echo: bool = False):
    return create_engine(
        url,
        echo=echo,
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_timeout=30,
    )


def cmd_init(args):
    url = get_database_url()
    print(f"Database: {url.split('@')[-1] if '@' in url else url}")

    engine = create_db_engine(url, echo=args.verbose)
    init_database(engine, drop_existing=args.drop)


def cmd_import(args):
    url = get_database_url()
    print(f"Database: {url.split('@')[-1] if '@' in url else url}")

    engine = create_db_engine(url, echo=args.verbose)
    exp_dir = Path(args.directory).resolve()

    with Session(engine) as session:
        exp_id = import_experiment(
            session,
            exp_dir,
            force=args.force,
            batch_size=args.batch_size,
        )
        if exp_id:
            print(f"\nSuccessfully imported experiment {exp_id}")


def cmd_import_all(args):
    url = get_database_url()
    print(f"Database: {url.split('@')[-1] if '@' in url else url}")

    engine = create_db_engine(url, echo=args.verbose)
    results_dir = Path(args.results_dir).resolve()

    with Session(engine) as session:
        ids = import_all_experiments(
            session,
            results_dir,
            force=args.force,
            batch_size=args.batch_size,
        )
        print(f"\nSuccessfully imported {len(ids)} experiments")


def cmd_list(args):
    url = get_database_url()
    engine = create_db_engine(url, echo=args.verbose)

    with Session(engine) as session:
        experiments = session.execute(
            select(Experiment).order_by(Experiment.id)
        ).scalars().all()

        if not experiments:
            print("No experiments in database")
            return

        print(f"\n{'ID':>4} {'Architecture':<15} {'Auth Strategy':<25} {'RAM':>8} {'Name'}")
        print("-" * 100)

        for exp in experiments:
            print(f"{exp.id:>4} {exp.architecture:<15} {exp.auth_strategy:<25} {exp.ram_in_mb:>6}MB {exp.name}")

        print(f"\nTotal: {len(experiments)} experiments")


def cmd_delete(args):
    url = get_database_url()
    engine = create_db_engine(url, echo=args.verbose)

    with Session(engine) as session:
        exp = session.get(Experiment, args.experiment_id)
        if not exp:
            print(f"Experiment {args.experiment_id} not found")
            return

        if not args.yes:
            confirm = input(f"Delete experiment '{exp.name}'? [y/N] ")
            if confirm.lower() != 'y':
                print("Cancelled")
                return

        session.delete(exp)
        session.commit()
        print(f"Deleted experiment {args.experiment_id}")


def cmd_stats(args):
    url = get_database_url()
    engine = create_db_engine(url, echo=args.verbose)

    with Session(engine) as session:
        # Experiment counts by architecture
        print("\n=== Experiments by Architecture ===")
        result = session.execute(
            select(Experiment.architecture, func.count(Experiment.id))
            .group_by(Experiment.architecture)
        )
        for arch, count in result:
            print(f"  {arch}: {count}")

        # Experiment counts by auth strategy
        print("\n=== Experiments by Auth Strategy ===")
        result = session.execute(
            select(Experiment.auth_strategy, func.count(Experiment.id))
            .group_by(Experiment.auth_strategy)
        )
        for auth, count in result:
            print(f"  {auth}: {count}")

        # Table row counts
        print("\n=== Table Row Counts ===")
        tables = [
            ("experiments", Experiment),
            ("phases", Phase),
            ("scaling_rules", ScalingRule),
            ("requests", Request),
            ("lambda_executions", LambdaExecution),
            ("handler_events", HandlerEvent),
            ("container_starts", ContainerStart),
            ("rpc_calls", RpcCall),
            ("metrics_alb", MetricsAlb),
            ("metrics_ecs", MetricsEcs),
        ]

        for name, model in tables:
            count = session.execute(select(func.count()).select_from(model)).scalar()
            print(f"  {name}: {count:,}")


def cmd_query(args):
    url = get_database_url()
    engine = create_db_engine(url, echo=args.verbose)

    with engine.connect() as conn:
        result = conn.execute(text(args.sql))

        # Print column headers
        if result.keys():
            headers = list(result.keys())
            print("\t".join(headers))
            print("-" * 80)

            # Print rows
            for row in result:
                print("\t".join(str(v) for v in row))


def cmd_post_process(args):
    """Run post-processing for specific experiment IDs."""
    url = get_database_url()
    print(f"Database: {url.split('@')[-1] if '@' in url else url}")

    engine = create_db_engine(url, echo=args.verbose)

    with Session(engine) as session:
        exp_ids = args.experiment_ids

        print(f"\n=== Post-processing {len(exp_ids)} experiments ===")
        for i, exp_id in enumerate(exp_ids, 1):
            print(f"\n[{i}/{len(exp_ids)}] Post-processing experiment {exp_id}...")
            experiment = session.execute(
                select(Experiment).where(Experiment.id == exp_id)
            ).scalar_one_or_none()

            if not experiment:
                print(f"  Experiment {exp_id} not found, skipping")
                continue

            # Reconstruct phase_starts from the phases table
            phases = session.execute(
                select(Phase).where(Phase.experiment_id == exp_id).order_by(Phase.phase_index)
            ).scalars().all()
            phase_starts = _calculate_phase_starts(phases) if phases else {}

            _run_post_processing(session, exp_id, experiment, phase_starts)
            session.commit()

        print(f"\nPost-processing complete for {len(exp_ids)} experiments")


def cmd_backfill(args):
    """Backfill NULL columns using derived data."""
    url = get_database_url()
    print(f"Database: {url.split('@')[-1] if '@' in url else url}")

    engine = create_db_engine(url, echo=args.verbose)

    with Session(engine) as session:
        backfill_nulls(session)


def cmd_reset(args):
    """Reset hidden folders by removing the '.' prefix from folder names."""
    target_dir = Path(args.directory).resolve()

    if not target_dir.is_dir():
        print(f"Error: {target_dir} is not a directory")
        return

    # Find all hidden directories (starting with '.')
    hidden_dirs = sorted([
        d for d in target_dir.iterdir()
        if d.is_dir() and d.name.startswith('.') and not d.name.startswith('..')
    ])

    if not hidden_dirs:
        print(f"No hidden folders found in {target_dir}")
        return

    print(f"Found {len(hidden_dirs)} hidden folder(s) in {target_dir}:\n")
    for d in hidden_dirs:
        new_name = d.name[1:]  # Remove leading '.'
        print(f"  {d.name} -> {new_name}")

    if not args.yes:
        confirm = input(f"\nRename {len(hidden_dirs)} folder(s)? [y/N] ")
        if confirm.lower() != 'y':
            print("Cancelled")
            return

    print()
    renamed = 0
    for d in hidden_dirs:
        new_name = d.name[1:]  # Remove leading '.'
        new_path = d.parent / new_name

        if new_path.exists():
            print(f"  Warning:  Skipped {d.name}: {new_name} already exists")
            continue

        try:
            d.rename(new_path)
            print(f"  [OK] Renamed {d.name} -> {new_name}")
            renamed += 1
        except Exception as e:
            print(f"  [FAIL] Failed to rename {d.name}: {e}")

    print(f"\nRenamed {renamed}/{len(hidden_dirs)} folder(s)")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="BeFaaS Benchmark Database Import Tool (PostgreSQL only)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Database configuration is read from .env file or environment variables.\n"
               "Required: DB_TYPE=postgresql, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD"
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose SQL logging",
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # init command
    init_parser = subparsers.add_parser("init", help="Initialize database schema")
    init_parser.add_argument(
        "--drop",
        action="store_true",
        help="Drop existing tables before creating",
    )

    # import command
    import_parser = subparsers.add_parser("import", help="Import a single experiment")
    import_parser.add_argument(
        "directory",
        help="Path to experiment directory",
    )
    import_parser.add_argument(
        "--force", "-f",
        action="store_true",
        help="Reimport existing experiment",
    )
    import_parser.add_argument(
        "--batch-size",
        type=int,
        default=10000,
        help="Batch size for large table inserts (default: 10000)",
    )

    # import-all command
    import_all_parser = subparsers.add_parser("import-all", help="Import all experiments from directory")
    import_all_parser.add_argument(
        "results_dir",
        help="Path to results directory containing experiment subdirectories",
    )
    import_all_parser.add_argument(
        "--force", "-f",
        action="store_true",
        help="Reimport existing experiments",
    )
    import_all_parser.add_argument(
        "--batch-size",
        type=int,
        default=10000,
        help="Batch size for large table inserts (default: 10000)",
    )

    # list command
    subparsers.add_parser("list", help="List all experiments")

    # delete command
    delete_parser = subparsers.add_parser("delete", help="Delete an experiment")
    delete_parser.add_argument(
        "experiment_id",
        type=int,
        help="Experiment ID to delete",
    )
    delete_parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="Skip confirmation prompt",
    )

    # stats command
    subparsers.add_parser("stats", help="Show database statistics")

    # query command
    query_parser = subparsers.add_parser("query", help="Run a SQL query")
    query_parser.add_argument(
        "sql",
        help="SQL query to execute",
    )

    # post-process command
    pp_parser = subparsers.add_parser(
        "post-process",
        help="Run post-processing for specific experiment IDs (resume after crash)"
    )
    pp_parser.add_argument(
        "experiment_ids",
        type=int,
        nargs="+",
        help="Experiment IDs to post-process",
    )

    # backfill command
    subparsers.add_parser(
        "backfill",
        help="Backfill NULL columns (auth_type, phase_index, phase_name, phase_relative_time_ms) using derived data"
    )

    # reset command (no database required)
    reset_parser = subparsers.add_parser(
        "reset",
        help="Unhide folders by removing '.' prefix from folder names"
    )
    reset_parser.add_argument(
        "directory",
        help="Path to directory containing hidden folders to reset",
    )
    reset_parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="Skip confirmation prompt",
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Dispatch to command handler
    commands = {
        "init": cmd_init,
        "import": cmd_import,
        "import-all": cmd_import_all,
        "list": cmd_list,
        "delete": cmd_delete,
        "stats": cmd_stats,
        "query": cmd_query,
        "post-process": cmd_post_process,
        "backfill": cmd_backfill,
        "reset": cmd_reset,
    }

    try:
        commands[args.command](args)
    except KeyboardInterrupt:
        print("\nInterrupted")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()