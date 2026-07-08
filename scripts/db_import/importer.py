import os
import time
from io import StringIO
from pathlib import Path
from typing import Optional, Any
from datetime import datetime

from sqlalchemy import insert, select, delete, text
from sqlalchemy.orm import Session

USE_OPTIMIZED_PROCESSING = os.getenv('DB_IMPORT_OPTIMIZED', 'true').lower() == 'true'
USE_COPY_INSERT = os.getenv('DB_IMPORT_USE_COPY', 'true').lower() == 'true'
DROP_INDEXES_DURING_IMPORT = os.getenv('DB_IMPORT_DROP_INDEXES', 'true').lower() == 'true'
COPY_BATCH_SIZE = int(os.getenv('DB_IMPORT_COPY_BATCH_SIZE', '100000'))
POST_PROCESS_BATCH_SIZE = int(os.getenv('DB_IMPORT_BATCH_SIZE', '50000'))
COMMIT_EVERY_N_RECORDS = int(os.getenv('DB_IMPORT_COMMIT_EVERY', '500000'))
ENRICH_IN_POST_PROCESSING = os.getenv('DB_IMPORT_ENRICH_POST', 'true').lower() == 'true'
FLUSH_DELAY_SECONDS = float(os.getenv('DB_IMPORT_FLUSH_DELAY', '0.1'))

from .schema import (
    Base, Experiment, ScalingRule, Phase, Request, LambdaExecution,
    HandlerEvent, ContainerStart, RpcCall,
    MetricsEcs, MetricsAlb, EdgeAuthEvent,
    create_tables,
)
from .parsers import (
    parse_directory_name,
    parse_hardware_config,
    parse_benchmark_config,
    parse_experiment_start_time,
    parse_error_description,
    parse_artillery_log,
    parse_aws_log,
    parse_edge_log,
    parse_alb_metrics,
    parse_ecs_metrics,
)


class ImportProgress:
    """Simple progress reporter."""

    def __init__(self, total: int = 0, desc: str = ""):
        self.total = total
        self.desc = desc
        self.current = 0
        self.last_percent = -1

    def update(self, n: int = 1):
        self.current += n
        if self.total > 0:
            percent = int(100 * self.current / self.total)
            if percent != self.last_percent and percent % 5 == 0:
                self.last_percent = percent
                print(f"  {self.desc}: {percent}% ({self.current:,}/{self.total:,})", flush=True)

    def finish(self):
        if self.total > 0:
            print(f"  {self.desc}: 100% ({self.current:,} records)", flush=True)
        else:
            print(f"  {self.desc}: {self.current:,} records", flush=True)


def _batch_insert(session: Session, table, records: list, batch_size: int = 5000, flush_every: int = 100000):
    if not records:
        return

    total_processed = 0
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        session.execute(insert(table), batch)
        total_processed += len(batch)

        # Only flush every flush_every records instead of after every batch
        if total_processed >= flush_every:
            session.flush()
            total_processed = 0

    # Final flush for remaining records
    if total_processed > 0:
        session.flush()


TABLE_COLUMNS = {
    'requests': [
        'experiment_id', 'x_pair', 'context_id', 'timestamp_ms', 'latency_ms',
        'relative_time_ms', 'phase_relative_time_ms', 'endpoint', 'status_code',
        'auth_type', 'is_error', 'is_timeout', 'error_type', 'error_code',
        'phase_index', 'phase_name', 'handler_duration_ms', 'network_overhead_ms'
    ],
    'lambda_executions': [
        'experiment_id', 'request_id', 'function_name', 'timestamp_ms',
        'duration_ms', 'billed_duration_ms', 'init_duration_ms', 'memory_size_mb',
        'max_memory_used_mb', 'is_cold_start', 'relative_time_ms'
    ],
    'handler_events': [
        'experiment_id', 'x_pair', 'context_id', 'lambda_request_id', 'function_name',
        'route', 'status_code', 'is_cold_start', 'request_count', 'timestamp_ms',
        'duration_ms', 'relative_time_ms', 'phase_relative_time_ms', 'is_protected_endpoint',
        'phase_index', 'phase_name', 'auth_type'
    ],
    'container_starts': [
        'experiment_id', 'lambda_request_id', 'function_name', 'deployment_id',
        'timestamp_ms', 'container_start_time_ms', 'relative_time_ms'
    ],
    'rpc_calls': [
        'experiment_id', 'direction', 'x_pair', 'context_id', 'lambda_request_id',
        'function_name', 'target_function', 'call_x_pair', 'call_type', 'duration_ms',
        'success', 'is_cold_start', 'timestamp_ms', 'received_at_ms', 'relative_time_ms',
        'phase_index', 'phase_name', 'auth_type'
    ],
    'edge_auth_events': [
        'experiment_id', 'event_type', 'instance_id', 'lambda_request_id',
        'timestamp_ms', 'relative_time_ms', 'now_perf_ms',
        'uri', 'outcome', 'total_ms', 'key_resolve_ms', 'crypto_verify_ms',
        'sign_ms', 'triggered_jwks_fetch', 'instance_age_ms',
        'trigger', 'duration_ms', 'jwks_fetch_number', 'jwks_key_count',
        'kid', 'since_last_ms', 'error',
        'phase_index', 'phase_name',
    ],
}

TABLE_INDEXES = {
    'requests': [
        ('idx_req_exp', 'experiment_id'),
        ('idx_req_exp_ts', 'experiment_id, timestamp_ms'),
        ('idx_req_exp_endpoint', 'experiment_id, endpoint'),
        ('idx_req_exp_auth', 'experiment_id, auth_type'),
        ('idx_req_exp_phase', 'experiment_id, phase_index'),
        ('idx_req_xpair', 'x_pair'),
        ('idx_req_latency', 'experiment_id, latency_ms'),
        ('idx_req_exp_xpair', 'experiment_id, x_pair'),
        ('idx_req_exp_context', 'experiment_id, context_id'),
    ],
    'lambda_executions': [
        ('idx_lambda_exp', 'experiment_id'),
        ('idx_lambda_exp_fn', 'experiment_id, function_name'),
        ('idx_lambda_exp_cold', 'experiment_id, is_cold_start'),
        ('idx_lambda_reqid', 'request_id'),
    ],
    'handler_events': [
        ('idx_handler_exp', 'experiment_id'),
        ('idx_handler_exp_fn', 'experiment_id, function_name'),
        ('idx_handler_xpair', 'x_pair'),
        ('idx_handler_exp_auth', 'experiment_id, auth_type'),
        ('idx_handler_exp_xpair', 'experiment_id, x_pair'),
        ('idx_handler_exp_phase_idx', 'experiment_id, phase_index'),
        ('idx_handler_exp_context', 'experiment_id, context_id'),
    ],
    'container_starts': [
        ('idx_cold_exp', 'experiment_id'),
        ('idx_cold_exp_fn', 'experiment_id, function_name'),
    ],
    'rpc_calls': [
        ('idx_rpc_exp', 'experiment_id'),
        ('idx_rpc_exp_dir', 'experiment_id, direction'),
        ('idx_rpc_exp_fn', 'experiment_id, function_name'),
        ('idx_rpc_xpair', 'x_pair'),
        ('idx_rpc_exp_xpair', 'experiment_id, x_pair'),
        ('idx_rpc_exp_context', 'experiment_id, context_id'),
    ],
    'edge_auth_events': [
        ('idx_edge_exp', 'experiment_id'),
        ('idx_edge_exp_event', 'experiment_id, event_type'),
        ('idx_edge_exp_outcome', 'experiment_id, outcome'),
        ('idx_edge_exp_instance', 'experiment_id, instance_id'),
        ('idx_edge_exp_ts', 'experiment_id, timestamp_ms'),
    ],
}


def _format_value_for_copy(value: Any) -> str:
    if value is None:
        return '\\N'  # PostgreSQL NULL representation
    if isinstance(value, bool):
        return 't' if value else 'f'
    if isinstance(value, (int, float)):
        return str(value)

    s = str(value)
    s = s.replace('\\', '\\\\')
    s = s.replace('\t', '\\t')
    s = s.replace('\n', '\\n')
    s = s.replace('\r', '\\r')
    return s


def _copy_insert(session: Session, table_name: str, records: list[dict], columns: list[str], commit: bool = False):
    if not records:
        return

    raw_conn = session.connection().connection
    cursor = raw_conn.cursor()

    try:
        buffer = StringIO()
        for record in records:
            row = [_format_value_for_copy(record.get(col)) for col in columns]
            buffer.write('\t'.join(row) + '\n')

        buffer.seek(0)

        columns_str = ', '.join(columns)
        cursor.copy_expert(
            f"COPY {table_name} ({columns_str}) FROM STDIN WITH (FORMAT text, NULL '\\N')",
            buffer
        )
    finally:
        cursor.close()

    if commit:
        session.commit()


def _drop_indexes(session: Session, table_name: str):
    if table_name not in TABLE_INDEXES:
        return

    for idx_name, _ in TABLE_INDEXES[table_name]:
        try:
            session.execute(text(f"DROP INDEX IF EXISTS {idx_name}"))
        except Exception as e:
            print(f"    Warning: Could not drop index {idx_name}: {e}")

    session.flush()


def _create_indexes(session: Session, table_name: str):
    if table_name not in TABLE_INDEXES:
        return

    for idx_name, columns in TABLE_INDEXES[table_name]:
        try:
            session.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table_name} ({columns})"))
        except Exception as e:
            print(f"    Warning: Could not create index {idx_name}: {e}")

    session.flush()


def _drop_all_large_table_indexes(session: Session):
    print("  Dropping indexes for faster import...")
    for table_name in TABLE_INDEXES:
        _drop_indexes(session, table_name)


def _rebuild_all_indexes(session: Session):
    print("  Rebuilding indexes...")
    start = time.time()
    for table_name in TABLE_INDEXES:
        _create_indexes(session, table_name)
    print(f"  Indexes rebuilt in {time.time() - start:.1f}s")


def _set_fast_import_mode(session: Session, enable: bool = True):
    if enable:
        session.execute(text("SET synchronous_commit = OFF"))
        session.execute(text("SET work_mem = '256MB'"))
    else:
        session.execute(text("SET synchronous_commit = ON"))
        session.execute(text("RESET work_mem"))


def _calculate_phase_starts(phases):
    phase_starts = {0: 0}
    cumulative = 0

    sorted_phases = sorted(phases, key=lambda p: p.phase_index)
    for i, phase in enumerate(sorted_phases[:-1]):
        next_phase_idx = sorted_phases[i + 1].phase_index
        cumulative += phase.duration_seconds * 1000 if phase.duration_seconds else 0
        phase_starts[next_phase_idx] = cumulative

    return phase_starts


def _is_protected_endpoint(route):
    if not route:
        return False
    if '/login' in route:
        return False
    if '/register' in route:
        return False
    if '/health' in route:
        return False
    if route.startswith('GET /api/products'):
        return False
    if '/api/' in route:
        return True
    return False


def _create_lambda_execution_records(lambda_executions, experiment_id, benchmark_start=None):
    for e in lambda_executions:
        record = {
            'experiment_id': experiment_id,
            'request_id': e.request_id,
            'function_name': e.function_name,
            'timestamp_ms': e.timestamp_ms,
            'duration_ms': e.duration_ms,
            'billed_duration_ms': e.billed_duration_ms,
            'init_duration_ms': e.init_duration_ms,
            'memory_size_mb': e.memory_size_mb,
            'max_memory_used_mb': e.max_memory_used_mb,
            'is_cold_start': e.is_cold_start,
        }
        if benchmark_start and e.timestamp_ms:
            record['relative_time_ms'] = e.timestamp_ms - benchmark_start
        yield record


def _create_handler_event_records(handler_events, experiment_id, benchmark_start=None,
                                   phase_starts=None, x_pair_lookup=None, skip_enrichment=False):
    for e in handler_events:
        record = {
            'experiment_id': experiment_id,
            'x_pair': e.x_pair,
            'context_id': e.context_id,
            'lambda_request_id': e.lambda_request_id,
            'function_name': e.function_name,
            'route': e.route,
            'status_code': e.status_code,
            'is_cold_start': e.is_cold_start,
            'request_count': e.request_count,
            'timestamp_ms': e.timestamp_ms,
            'duration_ms': e.duration_ms,
            'is_protected_endpoint': _is_protected_endpoint(e.route),
        }

        if benchmark_start and e.timestamp_ms:
            record['relative_time_ms'] = e.timestamp_ms - benchmark_start

        if not skip_enrichment and x_pair_lookup and e.context_id and e.context_id in x_pair_lookup:
            lookup = x_pair_lookup[e.context_id]
            record['phase_index'] = lookup.get('phase_index')
            record['phase_name'] = lookup.get('phase_name')
            record['auth_type'] = lookup.get('auth_type')

            if phase_starts and record.get('relative_time_ms') is not None:
                phase_idx = record.get('phase_index')
                if phase_idx is not None and phase_idx in phase_starts:
                    record['phase_relative_time_ms'] = record['relative_time_ms'] - phase_starts[phase_idx]

        yield record


def _create_container_start_records(container_starts, experiment_id, benchmark_start=None):
    for cs in container_starts:
        record = {
            'experiment_id': experiment_id,
            'lambda_request_id': cs.lambda_request_id,
            'function_name': cs.function_name,
            'deployment_id': cs.deployment_id,
            'timestamp_ms': cs.timestamp_ms,
            'container_start_time_ms': cs.container_start_time_ms,
        }
        if benchmark_start and cs.timestamp_ms:
            record['relative_time_ms'] = cs.timestamp_ms - benchmark_start
        yield record


def _create_rpc_call_records(rpc_calls, experiment_id, benchmark_start=None, x_pair_lookup=None, skip_enrichment=False):
    for rpc in rpc_calls:
        record = {
            'experiment_id': experiment_id,
            'direction': rpc.direction,
            'x_pair': rpc.x_pair,
            'context_id': rpc.context_id,
            'lambda_request_id': rpc.lambda_request_id,
            'function_name': rpc.function_name,
            'target_function': rpc.target_function,
            'call_x_pair': rpc.call_x_pair,
            'call_type': getattr(rpc, 'call_type', None),
            'duration_ms': rpc.duration_ms,
            'success': getattr(rpc, 'success', None),
            'is_cold_start': getattr(rpc, 'is_cold_start', None),
            'timestamp_ms': rpc.timestamp_ms,
            'received_at_ms': getattr(rpc, 'received_at_ms', None),
        }

        if benchmark_start and rpc.timestamp_ms:
            record['relative_time_ms'] = rpc.timestamp_ms - benchmark_start

        if not skip_enrichment and x_pair_lookup and rpc.context_id and rpc.context_id in x_pair_lookup:
            lookup = x_pair_lookup[rpc.context_id]
            record['phase_index'] = lookup.get('phase_index')
            record['phase_name'] = lookup.get('phase_name')
            record['auth_type'] = lookup.get('auth_type')

        yield record


def _phase_index_for_relative_time(relative_ms, phase_starts):
    if relative_ms is None or not phase_starts:
        return None
    best_idx = None
    best_start = -1
    for idx, start in phase_starts.items():
        if start <= relative_ms and start > best_start:
            best_idx = idx
            best_start = start
    return best_idx


def _create_edge_auth_event_records(edge_events, experiment_id, benchmark_start=None,
                                     phase_starts=None, phase_name_by_index=None):
    for e in edge_events:
        record = {
            'experiment_id': experiment_id,
            'event_type': e.event_type,
            'instance_id': e.instance_id,
            'lambda_request_id': e.lambda_request_id,
            'timestamp_ms': e.timestamp_ms,
            'now_perf_ms': e.now_perf_ms,
            'uri': e.uri,
            'outcome': e.outcome,
            'total_ms': e.total_ms,
            'key_resolve_ms': e.key_resolve_ms,
            'crypto_verify_ms': e.crypto_verify_ms,
            'sign_ms': e.sign_ms,
            'triggered_jwks_fetch': e.triggered_jwks_fetch,
            'instance_age_ms': e.instance_age_ms,
            'trigger': e.trigger,
            'duration_ms': e.duration_ms,
            'jwks_fetch_number': e.jwks_fetch_number,
            'jwks_key_count': e.jwks_key_count,
            'kid': e.kid,
            'since_last_ms': e.since_last_ms,
            'error': e.error,
        }

        if benchmark_start and e.timestamp_ms:
            rel = e.timestamp_ms - benchmark_start
            record['relative_time_ms'] = rel
            phase_idx = _phase_index_for_relative_time(rel, phase_starts)
            if phase_idx is not None:
                record['phase_index'] = phase_idx
                if phase_name_by_index and phase_idx in phase_name_by_index:
                    record['phase_name'] = phase_name_by_index[phase_idx]

        yield record


def _create_optimized_request_records(requests, experiment_id, benchmark_start=None, phase_starts=None):
    records = []
    for r in requests:
        record = {
            'experiment_id': experiment_id,
            'x_pair': r.x_pair,
            'context_id': r.context_id,
            'timestamp_ms': r.timestamp_ms,
            'latency_ms': getattr(r, '_latency_ms', None),
            'endpoint': r.endpoint,
            'status_code': r.status_code,
            'is_error': r.is_error,
            'is_timeout': r.is_timeout,
            'phase_index': r.phase_index,
            'phase_name': r.phase_name,
            'auth_type': r.auth_type,
            'error_type': getattr(r, 'error_type', None),
            'error_code': getattr(r, 'error_code', None),
        }

        if benchmark_start and r.timestamp_ms:
            record['relative_time_ms'] = r.timestamp_ms - benchmark_start

            if r.phase_index is not None and phase_starts and r.phase_index in phase_starts:
                record['phase_relative_time_ms'] = record['relative_time_ms'] - phase_starts[r.phase_index]

        records.append(record)

    return records


def _post_process_optimized(session, exp_id, benchmark_start=None, phase_starts=None, enrich_from_requests=False):
    total_start = time.time()
    print(f"  Post-processing derived fields...", flush=True)

    # Step 0: Calculate relative_time_ms for all tables
    if benchmark_start:
        print(f"    Calculating relative_time_ms...", flush=True)
        step_start = time.time()

        # Requests
        result = session.execute(text("""
            UPDATE requests
            SET relative_time_ms = timestamp_ms - :start
            WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
        """), {"start": benchmark_start, "exp_id": exp_id})
        requests_updated = result.rowcount
        session.commit()

        # Handler events
        result = session.execute(text("""
            UPDATE handler_events
            SET relative_time_ms = timestamp_ms - :start
            WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
        """), {"start": benchmark_start, "exp_id": exp_id})
        handlers_updated = result.rowcount
        session.commit()

        # Lambda executions
        result = session.execute(text("""
            UPDATE lambda_executions
            SET relative_time_ms = timestamp_ms - :start
            WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
        """), {"start": benchmark_start, "exp_id": exp_id})
        lambda_updated = result.rowcount
        session.commit()

        # RPC calls
        RELATIVE_TIME_BATCH = 500000
        rpc_updated = 0
        while True:
            result = session.execute(text("""
                UPDATE rpc_calls
                SET relative_time_ms = timestamp_ms - :start
                WHERE id IN (
                    SELECT id FROM rpc_calls
                    WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
                    LIMIT :batch_size
                )
            """), {"start": benchmark_start, "exp_id": exp_id, "batch_size": RELATIVE_TIME_BATCH})
            batch_count = result.rowcount
            session.commit()
            rpc_updated += batch_count
            if batch_count < RELATIVE_TIME_BATCH:
                break

        # Container starts
        result = session.execute(text("""
            UPDATE container_starts
            SET relative_time_ms = timestamp_ms - :start
            WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
        """), {"start": benchmark_start, "exp_id": exp_id})
        container_updated = result.rowcount
        session.commit()

        print(f"      Updated requests={requests_updated:,}, handlers={handlers_updated:,}, lambda={lambda_updated:,}, rpc={rpc_updated:,}, containers={container_updated:,} ({time.time() - step_start:.1f}s)", flush=True)

        # Calculate phase_relative_time_ms for requests
        if phase_starts:
            print(f"    Calculating phase_relative_time_ms for requests...", flush=True)
            step_start = time.time()

            # Build CASE statement for phase start times
            case_parts = []
            for phase_idx, start_ms in phase_starts.items():
                case_parts.append(f"WHEN {phase_idx} THEN {start_ms}")
            case_sql = "CASE phase_index " + " ".join(case_parts) + " ELSE 0 END"

            result = session.execute(text(f"""
                UPDATE requests
                SET phase_relative_time_ms = relative_time_ms - ({case_sql})
                WHERE experiment_id = :exp_id
                  AND relative_time_ms IS NOT NULL
                  AND phase_index IS NOT NULL
                  AND phase_relative_time_ms IS NULL
            """), {"exp_id": exp_id})
            phase_rel_updated = result.rowcount
            session.commit()
            print(f"      Updated {phase_rel_updated:,} rows ({time.time() - step_start:.1f}s)", flush=True)

    # Step 1: Enrich handler_events with phase/auth info from requests (if skipped during import)
    if enrich_from_requests:
        print(f"    Enriching handler_events from requests...", flush=True)
        step_start = time.time()

        result = session.execute(text("""
            UPDATE handler_events h
            SET phase_index = r.phase_index,
                phase_name = r.phase_name,
                auth_type = r.auth_type
            FROM (
                SELECT DISTINCT ON (context_id) context_id, phase_index, phase_name, auth_type
                FROM requests
                WHERE experiment_id = :exp_id
                  AND context_id IS NOT NULL
                ORDER BY context_id
            ) r
            WHERE h.experiment_id = :exp_id
              AND h.context_id IS NOT NULL
              AND h.phase_index IS NULL
              AND h.context_id = r.context_id
        """), {"exp_id": exp_id})
        handler_enriched = result.rowcount
        session.commit()
        print(f"      Enriched {handler_enriched:,} handler_events ({time.time() - step_start:.1f}s)", flush=True)

        # Step 2: Calculate phase_relative_time_ms for handler_events
        if phase_starts:
            print(f"    Calculating phase_relative_time_ms for handler_events...", flush=True)
            step_start = time.time()

            case_parts = []
            for phase_idx, start_ms in phase_starts.items():
                case_parts.append(f"WHEN {phase_idx} THEN {start_ms}")
            case_sql = "CASE phase_index " + " ".join(case_parts) + " ELSE 0 END"

            result = session.execute(text(f"""
                UPDATE handler_events
                SET phase_relative_time_ms = relative_time_ms - ({case_sql})
                WHERE experiment_id = :exp_id
                  AND relative_time_ms IS NOT NULL
                  AND phase_index IS NOT NULL
                  AND phase_relative_time_ms IS NULL
            """), {"exp_id": exp_id})
            phase_rel_updated = result.rowcount
            session.commit()
            print(f"      Updated {phase_rel_updated:,} rows ({time.time() - step_start:.1f}s)", flush=True)

        # Step 3: Enrich rpc_calls with phase/auth info from requests
        print(f"    Enriching rpc_calls from requests...", flush=True)
        step_start = time.time()

        result = session.execute(text("""
            UPDATE rpc_calls rc
            SET phase_index = r.phase_index,
                phase_name = r.phase_name,
                auth_type = r.auth_type
            FROM (
                SELECT DISTINCT ON (context_id) context_id, phase_index, phase_name, auth_type
                FROM requests
                WHERE experiment_id = :exp_id
                  AND context_id IS NOT NULL
                ORDER BY context_id
            ) r
            WHERE rc.experiment_id = :exp_id
              AND rc.context_id IS NOT NULL
              AND rc.phase_index IS NULL
              AND rc.context_id = r.context_id
        """), {"exp_id": exp_id})
        rpc_enriched = result.rowcount
        session.commit()
        print(f"      Enriched {rpc_enriched:,} rpc_calls ({time.time() - step_start:.1f}s)", flush=True)

    # Step 4: Calculate handler_duration_ms and network_overhead_ms for requests
    print(f"    Calculating handler_duration_ms...", flush=True)
    step_start = time.time()

    # Count rows to process for progress feedback
    count_result = session.execute(text("""
        SELECT COUNT(*)
        FROM requests r
        WHERE r.experiment_id = :exp_id
          AND r.x_pair IS NOT NULL
          AND r.handler_duration_ms IS NULL
    """), {"exp_id": exp_id})
    total_to_process = count_result.scalar() or 0

    if total_to_process == 0:
        print(f"      No requests need handler_duration_ms calculation", flush=True)
    else:
        print(f"      Processing {total_to_process:,} requests...", flush=True)

        # Single set-based UPDATE
        result = session.execute(text("""
            UPDATE requests r
            SET handler_duration_ms = he.duration_ms,
                network_overhead_ms = r.latency_ms - he.duration_ms
            FROM handler_events he
            WHERE r.experiment_id = :exp_id
              AND he.experiment_id = :exp_id
              AND r.x_pair = he.x_pair
              AND r.x_pair IS NOT NULL
              AND he.duration_ms IS NOT NULL
              AND r.handler_duration_ms IS NULL
        """), {"exp_id": exp_id})

        updated = result.rowcount
        session.commit()
        print(f"      Updated {updated:,} requests ({time.time() - step_start:.1f}s)", flush=True)

    print(f"  Post-processing completed in {time.time() - total_start:.1f}s", flush=True)



def _parse_pricing_metadata(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        import json
        with open(path, 'r') as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

    meta = data.get('meta', {})
    def _iso(value):
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            return None

    return {
        'region': meta.get('region'),
        'start_time': _iso(meta.get('start_time')),
        'end_time': _iso(meta.get('end_time')),
        'duration_minutes': meta.get('duration_minutes'),
        'duration_hours': meta.get('duration_hours'),
        'collected_at': _iso(meta.get('collected_at')),
    }


def import_experiment(
    session: Session,
    experiment_dir: Path,
    force: bool = False,
    batch_size: int = 10000,
    skip_post_processing: bool = False,
) -> Optional[int]:
    """
    Import a single experiment directory into the database.

    Args:
        session: SQLAlchemy session
        experiment_dir: Path to experiment directory
        force: If True, delete existing experiment data before importing
        batch_size: Batch size for large table inserts
        skip_post_processing: If True, skip post-processing (caller handles it after index rebuild)

    Returns:
        Experiment ID if successful, None otherwise
    """
    if not experiment_dir.is_dir():
        print(f"Error: {experiment_dir} is not a directory")
        return None

    print(f"\nImporting: {experiment_dir.name}")

    # Parse directory name for basic metadata
    dir_meta = parse_directory_name(experiment_dir)
    print(f"  Architecture: {dir_meta.architecture}, Auth: {dir_meta.auth_strategy}")

    # Check if experiment already exists
    existing = session.execute(
        select(Experiment).where(Experiment.name == dir_meta.name)
    ).scalar_one_or_none()

    if existing:
        if force:
            print(f"  Deleting existing experiment (id={existing.id})")
            session.execute(delete(Experiment).where(Experiment.id == existing.id))
            session.flush()
        else:
            renamed_path = experiment_dir.parent / f".{experiment_dir.name}"
            if renamed_path.exists():
                print(f"  Experiment already exists (id={existing.id}), skipping. Use --force to reimport.")
                return existing.id
            request_count = session.execute(
                text("SELECT COUNT(*) FROM requests WHERE experiment_id = :eid"),
                {"eid": existing.id}
            ).scalar() or 0
            if request_count > 0:
                print(f"  Experiment exists (id={existing.id}) with {request_count:,} requests - resuming post-processing")
                return existing.id
            else:
                print(f"  Experiment exists (id={existing.id}) but has no data - reimporting")
                session.execute(delete(Experiment).where(Experiment.id == existing.id))
                session.flush()

    # Parse configuration files
    hardware_config = parse_hardware_config(experiment_dir / "hardware_config.json")
    benchmark_config = parse_benchmark_config(experiment_dir / "benchmark_configuration.json")
    start_time = parse_experiment_start_time(experiment_dir / "experiment_start_time.txt")
    error_desc = parse_error_description(experiment_dir / "error_description.md")
    pricing_meta = _parse_pricing_metadata(experiment_dir / "pricing" / "pricing.json")

    # Determine AWS service type
    aws_service = None
    if dir_meta.architecture == 'faas':
        aws_service = 'lambda'
    elif dir_meta.architecture in ('microservices', 'monolith'):
        aws_service = 'ecs_fargate'

    ram_in_mb = dir_meta.ram_in_mb
    cpu_in_vcpu = dir_meta.cpu_in_vcpu
    if hardware_config:
        if hardware_config.ram_in_mb and hardware_config.ram_in_mb > 0:
            ram_in_mb = hardware_config.ram_in_mb
        if hardware_config.cpu_in_vcpu:
            cpu_in_vcpu = hardware_config.cpu_in_vcpu

    http_timeout = None
    if benchmark_config and benchmark_config.http_timeout_seconds:
        http_timeout = benchmark_config.http_timeout_seconds
    else:
        if dir_meta.architecture == 'faas':
            http_timeout = 10
        elif dir_meta.architecture in ('microservices', 'monolith'):
            http_timeout = 30

    experiment = Experiment(
        name=dir_meta.name,
        architecture=dir_meta.architecture,
        auth_strategy=dir_meta.auth_strategy,
        run_timestamp=dir_meta.run_timestamp,
        aws_service=aws_service,
        ram_in_mb=ram_in_mb or 0,
        bundle_mode=hardware_config.bundle_mode if hardware_config else None,
        cpu_in_vcpu=cpu_in_vcpu,
        cpu_units=int(cpu_in_vcpu * 1024) if cpu_in_vcpu else None,
        password_hash_algorithm=hardware_config.password_hash_algorithm if hardware_config else None,
        jwt_sign_algorithm=hardware_config.jwt_sign_algorithm if hardware_config else None,
        with_cloudfront=(
            dir_meta.with_cloudfront
            or (hardware_config.with_cloudfront if hardware_config else False)
            or dir_meta.auth_strategy in ('edge', 'edge-selective')
        ),
        auth_granularity=(
            (hardware_config.auth_granularity if hardware_config and hardware_config.auth_granularity else 'per-function')
        ),
        http_timeout_seconds=http_timeout,
        start_timestamp_ms=start_time.timestamp_ms if start_time else None,
        error_description=error_desc,
    )

    if pricing_meta:
        experiment.pricing_region = pricing_meta.get('region')
        experiment.pricing_start_time = pricing_meta.get('start_time')
        experiment.pricing_end_time = pricing_meta.get('end_time')
        experiment.pricing_duration_minutes = pricing_meta.get('duration_minutes')
        experiment.pricing_duration_hours = pricing_meta.get('duration_hours')
        experiment.pricing_collected_at = pricing_meta.get('collected_at')

    session.add(experiment)
    session.flush()
    exp_id = experiment.id
    print(f"  Created experiment (id={exp_id})")

    if hardware_config and hardware_config.scaling_rules:
        for rule in hardware_config.scaling_rules:
            session.add(ScalingRule(
                experiment_id=exp_id,
                service_name=rule.service_name,
                rule_type=rule.rule_type,
                target_value=rule.target_value,
                min_capacity=rule.min_capacity,
                max_capacity=rule.max_capacity,
                cpu_units=rule.cpu_units,
                memory_mb=rule.memory_mb,
                scale_in_cooldown_sec=rule.scale_in_cooldown_sec,
                scale_out_cooldown_sec=rule.scale_out_cooldown_sec,
            ))
        services = set(r.service_name for r in hardware_config.scaling_rules)
        print(f"  Imported {len(hardware_config.scaling_rules)} scaling rules for {len(services)} service(s)")

    session.flush()

    # Import CloudWatch metrics
    alb_metrics_path = experiment_dir / "cloudwatch" / "alb_metrics.csv"
    if alb_metrics_path.exists():
        alb_metrics = parse_alb_metrics(alb_metrics_path)
        if alb_metrics:
            records = [
                {
                    'experiment_id': exp_id,
                    'timestamp': m.timestamp,
                    'request_count': m.request_count,
                    'response_time_avg': m.response_time_avg,
                    'response_time_p95': m.response_time_p95,
                    'http_2xx_count': m.http_2xx_count,
                    'http_4xx_count': m.http_4xx_count,
                    'http_5xx_count': m.http_5xx_count,
                }
                for m in alb_metrics
            ]
            _batch_insert(session, MetricsAlb, records)
            print(f"  Imported {len(records)} ALB metrics")

    ecs_metrics_path = experiment_dir / "cloudwatch" / "ecs_metrics.csv"
    if ecs_metrics_path.exists():
        ecs_metrics = parse_ecs_metrics(ecs_metrics_path)
        if ecs_metrics:
            records = [
                {
                    'experiment_id': exp_id,
                    'timestamp': m.timestamp,
                    'service_name': m.service_name,
                    'cpu_percent': m.cpu_percent,
                    'memory_percent': m.memory_percent,
                    'running_tasks': m.running_tasks,
                    'desired_tasks': m.desired_tasks,
                }
                for m in ecs_metrics
            ]
            _batch_insert(session, MetricsEcs, records)
            print(f"  Imported {len(records)} ECS metrics")

    session.flush()

    # Import artillery log (client-side requests)
    artillery_path = experiment_dir / "logs" / "artillery.log"
    x_pair_lookup = {}
    benchmark_start_ms = None
    phase_starts = {}

    if artillery_path.exists():
        print(f"  Parsing artillery.log...")
        total_requests = 0
        records_since_commit = 0
        phases_imported = False
        phases_data = []
        start = time.time()

        request_buffer = []

        def flush_request_buffer(force_commit=False):
            """Flush request buffer to database using COPY."""
            nonlocal request_buffer, total_requests, records_since_commit
            if not request_buffer:
                return
            if USE_COPY_INSERT:
                should_commit = force_commit or (
                    COMMIT_EVERY_N_RECORDS > 0 and
                    records_since_commit + len(request_buffer) >= COMMIT_EVERY_N_RECORDS
                )
                _copy_insert(session, 'requests', request_buffer, TABLE_COLUMNS['requests'], commit=should_commit)
                if should_commit:
                    records_since_commit = 0
                else:
                    records_since_commit += len(request_buffer)
            else:
                _batch_insert(session, Request, request_buffer)
            total_requests += len(request_buffer)
            request_buffer = []

            if FLUSH_DELAY_SECONDS > 0:
                time.sleep(FLUSH_DELAY_SECONDS)

        for result, requests in parse_artillery_log(artillery_path, batch_size=batch_size):
            if not phases_imported and result.phases:
                for phase in result.phases:
                    phase_obj = Phase(
                        experiment_id=exp_id,
                        phase_index=phase.index,
                        phase_name=phase.name,
                        duration_seconds=phase.duration_seconds,
                    )
                    session.add(phase_obj)
                    phases_data.append(phase_obj)

                if USE_OPTIMIZED_PROCESSING:
                    phase_starts = _calculate_phase_starts(phases_data)

                session.flush()
                print(f"  Imported {len(result.phases)} phases")
                phases_imported = True

            if result.benchmark_start_ms:
                experiment.benchmark_start_ms = result.benchmark_start_ms
                benchmark_start_ms = result.benchmark_start_ms  # Store for aws.log parsing
            if result.benchmark_end_ms:
                experiment.benchmark_end_ms = result.benchmark_end_ms

            if requests:
                if USE_OPTIMIZED_PROCESSING:
                    records = _create_optimized_request_records(
                        requests, exp_id,
                        benchmark_start=result.benchmark_start_ms,
                        phase_starts=phase_starts
                    )
                    if not ENRICH_IN_POST_PROCESSING:
                        for r in requests:
                            if r.context_id:
                                x_pair_lookup[r.context_id] = {
                                    'phase_index': r.phase_index,
                                    'phase_name': r.phase_name,
                                    'auth_type': r.auth_type,
                                    'latency_ms': getattr(r, '_latency_ms', None),
                                }
                else:
                    records = [
                        {
                            'experiment_id': exp_id,
                            'x_pair': r.x_pair,
                            'context_id': r.context_id,
                            'timestamp_ms': r.timestamp_ms,
                            'latency_ms': getattr(r, '_latency_ms', None),
                            'endpoint': r.endpoint,
                            'status_code': r.status_code,
                            'auth_type': r.auth_type,
                            'phase_index': r.phase_index,
                            'phase_name': r.phase_name,
                            'is_error': r.is_error,
                            'is_timeout': r.is_timeout,
                            'error_type': r.error_type,
                            'error_code': r.error_code,
                        }
                        for r in requests
                    ]

                request_buffer.extend(records)

                if len(request_buffer) >= COPY_BATCH_SIZE:
                    flush_request_buffer()

                current_count = total_requests + len(request_buffer)
                if current_count % 100000 == 0 and current_count > 0:
                    elapsed = time.time() - start
                    rate = current_count / elapsed if elapsed > 0 else 0
                    print(f"    Requests: {current_count:,} ({rate:,.0f}/s)...", flush=True)

        flush_request_buffer(force_commit=True)

        if total_requests > 0:
            elapsed = time.time() - start
            rate = total_requests / elapsed if elapsed > 0 else 0
            print(f"  Imported {total_requests:,} requests in {elapsed:.1f}s ({rate:,.0f}/s)")
            if x_pair_lookup and not ENRICH_IN_POST_PROCESSING:
                print(f"  Built context_id lookup with {len(x_pair_lookup):,} entries for enrichment")
            elif ENRICH_IN_POST_PROCESSING:
                print(f"  Enrichment deferred to post-processing (faster for large datasets)")

    # Import AWS log (server-side events)
    aws_log_path = experiment_dir / "logs" / "aws.log"
    if aws_log_path.exists():
        if ENRICH_IN_POST_PROCESSING:
            print(f"  Parsing aws.log (enrichment deferred to post-processing)...")
        else:
            print(f"  Parsing aws.log (with insert-time enrichment)...")

        all_lambda = []
        all_handlers = []
        all_container_starts = []
        all_rpc = []
        total_lambda = 0
        total_handlers = 0
        total_container_starts = 0
        total_rpc = 0
        event_count = 0
        records_since_commit = 0
        start = time.time()

        def flush_buffers(force_commit=False):
            """Flush all buffers to database using COPY."""
            nonlocal all_lambda, all_handlers, all_container_starts, all_rpc
            nonlocal total_lambda, total_handlers, total_container_starts, total_rpc
            nonlocal records_since_commit

            batch_total = len(all_lambda) + len(all_handlers) + len(all_container_starts) + len(all_rpc)
            if batch_total == 0:
                return

            should_commit = force_commit or (
                COMMIT_EVERY_N_RECORDS > 0 and
                records_since_commit + batch_total >= COMMIT_EVERY_N_RECORDS
            )

            if USE_COPY_INSERT:
                if all_lambda:
                    _copy_insert(session, 'lambda_executions', all_lambda, TABLE_COLUMNS['lambda_executions'])
                    total_lambda += len(all_lambda)
                    all_lambda = []
                if all_handlers:
                    _copy_insert(session, 'handler_events', all_handlers, TABLE_COLUMNS['handler_events'])
                    total_handlers += len(all_handlers)
                    all_handlers = []
                if all_container_starts:
                    _copy_insert(session, 'container_starts', all_container_starts, TABLE_COLUMNS['container_starts'])
                    total_container_starts += len(all_container_starts)
                    all_container_starts = []
                if all_rpc:
                    _copy_insert(session, 'rpc_calls', all_rpc, TABLE_COLUMNS['rpc_calls'])
                    total_rpc += len(all_rpc)
                    all_rpc = []

                if should_commit:
                    session.commit()
                    records_since_commit = 0
                else:
                    records_since_commit += batch_total
            else:
                if all_lambda:
                    _batch_insert(session, LambdaExecution, all_lambda)
                    total_lambda += len(all_lambda)
                    all_lambda = []
                if all_handlers:
                    _batch_insert(session, HandlerEvent, all_handlers)
                    total_handlers += len(all_handlers)
                    all_handlers = []
                if all_container_starts:
                    _batch_insert(session, ContainerStart, all_container_starts)
                    total_container_starts += len(all_container_starts)
                    all_container_starts = []
                if all_rpc:
                    _batch_insert(session, RpcCall, all_rpc)
                    total_rpc += len(all_rpc)
                    all_rpc = []

            if FLUSH_DELAY_SECONDS > 0:
                time.sleep(FLUSH_DELAY_SECONDS)

        for batch in parse_aws_log(aws_log_path, batch_size=batch_size):
            # Lambda executions
            if batch.lambda_executions:
                for record in _create_lambda_execution_records(
                    batch.lambda_executions, exp_id,
                    benchmark_start=benchmark_start_ms
                ):
                    all_lambda.append(record)

            # Handler events
            if batch.handler_events:
                for record in _create_handler_event_records(
                    batch.handler_events, exp_id,
                    benchmark_start=benchmark_start_ms,
                    phase_starts=phase_starts,
                    x_pair_lookup=x_pair_lookup,
                    skip_enrichment=ENRICH_IN_POST_PROCESSING
                ):
                    all_handlers.append(record)

            # Container starts
            if batch.container_starts:
                for record in _create_container_start_records(
                    batch.container_starts, exp_id,
                    benchmark_start=benchmark_start_ms
                ):
                    all_container_starts.append(record)

            # RPC calls
            if batch.rpc_calls:
                for record in _create_rpc_call_records(
                    batch.rpc_calls, exp_id,
                    benchmark_start=benchmark_start_ms,
                    x_pair_lookup=x_pair_lookup,
                    skip_enrichment=ENRICH_IN_POST_PROCESSING
                ):
                    all_rpc.append(record)

            # Flush buffers when they get large enough
            buffer_size = len(all_lambda) + len(all_handlers) + len(all_container_starts) + len(all_rpc)
            if buffer_size >= COPY_BATCH_SIZE:
                flush_buffers()

            # Progress update
            event_count = total_lambda + total_handlers + total_container_starts + total_rpc + buffer_size
            if event_count % 500000 == 0 and event_count > 0:
                elapsed = time.time() - start
                rate = event_count / elapsed if elapsed > 0 else 0
                print(f"    Events: {event_count:,} ({rate:,.0f}/s)...", flush=True)

        flush_buffers(force_commit=True)

        elapsed = time.time() - start
        total_events = total_lambda + total_handlers + total_container_starts + total_rpc
        rate = total_events / elapsed if elapsed > 0 else 0
        print(f"  Inserted {total_events:,} events in {elapsed:.1f}s ({rate:,.0f}/s)")
        print(f"  Imported from aws.log:")
        if total_lambda > 0:
            print(f"    Lambda executions: {total_lambda:,}")
        if total_handlers > 0:
            print(f"    Handler events: {total_handlers:,}")
        if total_container_starts > 0:
            print(f"    Container starts: {total_container_starts:,}")
        if total_rpc > 0:
            print(f"    RPC calls: {total_rpc:,}")

    # Import edge Lambda log (Lambda@Edge REPORT lines + BEFAAS-EDGE events).
    edge_log_path = experiment_dir / "logs" / "edge.log"
    if edge_log_path.exists():
        print(f"  Parsing edge.log...")
        phase_name_by_index = {}
        try:
            _phases_for_edge = locals().get('phases_data') or []
            for p in _phases_for_edge:
                phase_name_by_index[p.phase_index] = p.phase_name
        except Exception:
            phase_name_by_index = {}

        edge_lambda_buffer = []
        edge_event_buffer = []
        total_edge_lambda = 0
        total_edge_events = 0
        edge_records_since_commit = 0
        edge_start = time.time()

        def flush_edge_buffers(force_commit=False):
            nonlocal edge_lambda_buffer, edge_event_buffer
            nonlocal total_edge_lambda, total_edge_events
            nonlocal edge_records_since_commit

            batch_total = len(edge_lambda_buffer) + len(edge_event_buffer)
            if batch_total == 0:
                return

            should_commit = force_commit or (
                COMMIT_EVERY_N_RECORDS > 0 and
                edge_records_since_commit + batch_total >= COMMIT_EVERY_N_RECORDS
            )

            if USE_COPY_INSERT:
                if edge_lambda_buffer:
                    _copy_insert(session, 'lambda_executions', edge_lambda_buffer,
                                 TABLE_COLUMNS['lambda_executions'])
                    total_edge_lambda += len(edge_lambda_buffer)
                    edge_lambda_buffer = []
                if edge_event_buffer:
                    _copy_insert(session, 'edge_auth_events', edge_event_buffer,
                                 TABLE_COLUMNS['edge_auth_events'])
                    total_edge_events += len(edge_event_buffer)
                    edge_event_buffer = []
            else:
                if edge_lambda_buffer:
                    _batch_insert(session, LambdaExecution, edge_lambda_buffer)
                    total_edge_lambda += len(edge_lambda_buffer)
                    edge_lambda_buffer = []
                if edge_event_buffer:
                    _batch_insert(session, EdgeAuthEvent, edge_event_buffer)
                    total_edge_events += len(edge_event_buffer)
                    edge_event_buffer = []

            if should_commit:
                session.commit()
                edge_records_since_commit = 0
            else:
                edge_records_since_commit += batch_total

            if FLUSH_DELAY_SECONDS > 0:
                time.sleep(FLUSH_DELAY_SECONDS)

        for batch in parse_edge_log(edge_log_path, batch_size=batch_size):
            if batch.lambda_executions:
                for record in _create_lambda_execution_records(
                    batch.lambda_executions, exp_id,
                    benchmark_start=benchmark_start_ms
                ):
                    edge_lambda_buffer.append(record)

            if batch.edge_auth_events:
                for record in _create_edge_auth_event_records(
                    batch.edge_auth_events, exp_id,
                    benchmark_start=benchmark_start_ms,
                    phase_starts=phase_starts,
                    phase_name_by_index=phase_name_by_index,
                ):
                    edge_event_buffer.append(record)

            if len(edge_lambda_buffer) + len(edge_event_buffer) >= COPY_BATCH_SIZE:
                flush_edge_buffers()

        flush_edge_buffers(force_commit=True)

        edge_elapsed = time.time() - edge_start
        edge_total = total_edge_lambda + total_edge_events
        edge_rate = edge_total / edge_elapsed if edge_elapsed > 0 else 0
        print(f"  Inserted {edge_total:,} events from edge.log in {edge_elapsed:.1f}s ({edge_rate:,.0f}/s)")
        if total_edge_lambda > 0:
            print(f"    Edge Lambda executions: {total_edge_lambda:,}")
        if total_edge_events > 0:
            print(f"    Edge auth events: {total_edge_events:,}")
        elif total_edge_lambda > 0:
            print(f"    (No BEFAAS-EDGE events — experiment uses v1 legacy edge Lambda or older instrumentation)")

    if skip_post_processing:
        session.commit()
        print(f"  Data import complete for experiment {exp_id} (post-processing deferred)")
        return exp_id

    _run_post_processing(session, exp_id, experiment, phase_starts)

    session.commit()
    print(f"  Completed import for experiment {exp_id}")

    # Rename directory to mark as imported (add '.' prefix)
    _rename_imported_dir(experiment_dir)

    return exp_id


def _rename_imported_dir(experiment_dir: Path):
    """Rename directory to mark as imported (add '.' prefix)."""
    new_name = f".{experiment_dir.name}"
    new_path = experiment_dir.parent / new_name
    try:
        experiment_dir.rename(new_path)
        print(f"  Renamed directory to: {new_name}")
    except OSError as e:
        print(f"  Warning: Could not rename directory: {e}")


def _run_post_processing(session: Session, exp_id: int, experiment, phase_starts: dict):
    """Run post-processing for a single experiment (requires indexes to be present)."""
    if USE_OPTIMIZED_PROCESSING:
        _post_process_optimized(
            session, exp_id, experiment.benchmark_start_ms,
            phase_starts=phase_starts,
            enrich_from_requests=ENRICH_IN_POST_PROCESSING
        )
    else:
        # Legacy post-processing (for rollback compatibility)
        print(f"  Post-processing: calculating derived fields (legacy)...")

        # Get benchmark_start_ms for relative time calculations
        benchmark_start = experiment.benchmark_start_ms
        if benchmark_start:
            # Calculate relative_time_ms for requests
            session.execute(text("""
                UPDATE requests
                SET relative_time_ms = timestamp_ms - :start
                WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
            """), {"start": benchmark_start, "exp_id": exp_id})

            # Calculate relative_time_ms for handler_events
            session.execute(text("""
                UPDATE handler_events
                SET relative_time_ms = timestamp_ms - :start
                WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
            """), {"start": benchmark_start, "exp_id": exp_id})

            # Calculate relative_time_ms for lambda_executions
            session.execute(text("""
                UPDATE lambda_executions
                SET relative_time_ms = timestamp_ms - :start
                WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
            """), {"start": benchmark_start, "exp_id": exp_id})

            # Calculate relative_time_ms for rpc_calls
            session.execute(text("""
                UPDATE rpc_calls
                SET relative_time_ms = timestamp_ms - :start
                WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
            """), {"start": benchmark_start, "exp_id": exp_id})

            # Calculate relative_time_ms for container_starts
            session.execute(text("""
                UPDATE container_starts
                SET relative_time_ms = timestamp_ms - :start
                WHERE experiment_id = :exp_id AND relative_time_ms IS NULL
            """), {"start": benchmark_start, "exp_id": exp_id})

            print(f"    Calculated relative_time_ms for all tables")

        session.execute(text("""
            UPDATE requests r
            SET phase_relative_time_ms = r.relative_time_ms - (
                SELECT COALESCE(SUM(p2.duration_seconds) * 1000, 0)
                FROM phases p2
                WHERE p2.experiment_id = r.experiment_id
                  AND p2.phase_index < r.phase_index
            )
            WHERE r.experiment_id = :exp_id
              AND r.relative_time_ms IS NOT NULL
              AND r.phase_index IS NOT NULL
              AND r.phase_relative_time_ms IS NULL
        """), {"exp_id": exp_id})
        print(f"    Calculated phase_relative_time_ms for requests")
        session.execute(text("""
            UPDATE handler_events h
            SET phase_index = r.phase_index,
                phase_name = r.phase_name,
                auth_type = r.auth_type
            FROM requests r
            WHERE h.experiment_id = :exp_id
              AND r.experiment_id = :exp_id
              AND h.context_id = r.context_id
              AND h.context_id IS NOT NULL
              AND h.phase_index IS NULL
        """), {"exp_id": exp_id})
        print(f"    Enriched handler_events with phase/auth info from requests")

        # Calculate phase_relative_time_ms for handler_events
        session.execute(text("""
            UPDATE handler_events h
            SET phase_relative_time_ms = h.relative_time_ms - (
                SELECT COALESCE(SUM(p2.duration_seconds) * 1000, 0)
                FROM phases p2
                WHERE p2.experiment_id = h.experiment_id
                  AND p2.phase_index < h.phase_index
            )
            WHERE h.experiment_id = :exp_id
              AND h.relative_time_ms IS NOT NULL
              AND h.phase_index IS NOT NULL
              AND h.phase_relative_time_ms IS NULL
        """), {"exp_id": exp_id})
        print(f"    Calculated phase_relative_time_ms for handler_events")

        # Enrich rpc_calls with phase/auth info from requests (via context_id join)
        # NOTE: We join on context_id (not x_pair) because internal RPC calls have x_pairs
        # that are generated call_x_pairs which don't exist in the requests table.
        # Batched to avoid connection timeouts on large datasets.
        result = session.execute(text("""
            UPDATE rpc_calls rc
            SET phase_index = r.phase_index,
                phase_name = r.phase_name,
                auth_type = r.auth_type
            FROM (
                SELECT DISTINCT ON (context_id) context_id, phase_index, phase_name, auth_type
                FROM requests
                WHERE experiment_id = :exp_id
                  AND context_id IS NOT NULL
                ORDER BY context_id
            ) r
            WHERE rc.experiment_id = :exp_id
              AND rc.context_id IS NOT NULL
              AND rc.phase_index IS NULL
              AND rc.context_id = r.context_id
        """), {"exp_id": exp_id})
        session.commit()
        print(f"    Enriched {result.rowcount:,} rpc_calls with phase/auth info from requests")

        # Calculate is_protected_endpoint based on route patterns
        # Protected endpoints typically require auth (non-login/register routes under /api/)
        session.execute(text("""
            UPDATE handler_events
            SET is_protected_endpoint = CASE
                WHEN route LIKE '%/login%' THEN FALSE
                WHEN route LIKE '%/register%' THEN FALSE
                WHEN route LIKE '%/health%' THEN FALSE
                WHEN route LIKE 'GET /api/products%' THEN FALSE
                WHEN route LIKE '%/api/%' THEN TRUE
                ELSE FALSE
            END
            WHERE experiment_id = :exp_id AND is_protected_endpoint IS NULL
        """), {"exp_id": exp_id})
        print(f"    Calculated is_protected_endpoint for handler_events")

        # Calculate handler_duration_ms and network_overhead_ms for requests
        session.execute(text("""
            UPDATE requests r
            SET handler_duration_ms = h.duration_ms,
                network_overhead_ms = r.latency_ms - h.duration_ms
            FROM handler_events h
            WHERE r.experiment_id = :exp_id
              AND h.experiment_id = :exp_id
              AND r.x_pair = h.x_pair
              AND r.x_pair IS NOT NULL
              AND r.handler_duration_ms IS NULL
              AND h.duration_ms IS NOT NULL
        """), {"exp_id": exp_id})
        print(f"    Calculated handler_duration_ms and network_overhead_ms for requests")


def import_all_experiments(
    session: Session,
    results_dir: Path,
    force: bool = False,
    batch_size: int = 10000,
) -> list[int]:
    """
    Import all experiments from a results directory.

    Uses a two-phase approach when indexes are dropped:
      Phase 1: COPY all experiment data without indexes (fast bulk insert)
      Phase 2: Rebuild indexes, then run post-processing for all experiments (fast JOINs)

    This prevents the previous issue where post-processing JOINs ran without indexes,
    causing quadratic slowdown and apparent freezes after 5-8 experiments.

    Args:
        session: SQLAlchemy session
        results_dir: Path to directory containing experiment subdirectories
        force: If True, reimport existing experiments
        batch_size: Batch size for large table inserts

    Returns:
        List of imported experiment IDs
    """
    if not results_dir.is_dir():
        print(f"Error: {results_dir} is not a directory")
        return []

    # Find all experiment directories
    exp_dirs = sorted([
        d for d in results_dir.iterdir()
        if d.is_dir() and not d.name.startswith('.')
    ])

    print(f"Found {len(exp_dirs)} experiment directories")

    if len(exp_dirs) == 0:
        return []

    defer_post_processing = DROP_INDEXES_DURING_IMPORT and USE_COPY_INSERT

    # Enable fast import mode
    if USE_COPY_INSERT:
        print("  Enabling fast import mode (synchronous_commit=OFF)...")
        _set_fast_import_mode(session, enable=True)

    # Drop indexes before bulk import for faster inserts
    if defer_post_processing:
        _drop_all_large_table_indexes(session)
        session.commit()

    import_start = time.time()
    imported_ids = []
    # Track experiment dirs for deferred post-processing
    imported_dirs = []
    try:
        # Phase 1: Import all experiment data (COPY only when indexes are dropped)
        for i, exp_dir in enumerate(exp_dirs, 1):
            print(f"\n[{i}/{len(exp_dirs)}] ", end="")
            exp_id = import_experiment(
                session, exp_dir, force=force, batch_size=batch_size,
                skip_post_processing=defer_post_processing,
            )
            if exp_id:
                imported_ids.append(exp_id)
                if defer_post_processing:
                    imported_dirs.append(exp_dir)
    finally:
        # Rebuild indexes after all COPY inserts complete
        if defer_post_processing:
            _rebuild_all_indexes(session)
            session.commit()

        # Restore normal PostgreSQL settings
        if USE_COPY_INSERT:
            print("  Restoring normal database settings...")
            _set_fast_import_mode(session, enable=False)
            session.commit()

    # Phase 2: Run post-processing for all experiments (with indexes present)
    if defer_post_processing and imported_ids:
        print(f"\n=== Post-processing {len(imported_ids)} experiments (with indexes) ===")
        for i, exp_id in enumerate(imported_ids, 1):
            print(f"\n[{i}/{len(imported_ids)}] Post-processing experiment {exp_id}...")
            experiment = session.execute(
                select(Experiment).where(Experiment.id == exp_id)
            ).scalar_one()

            # Reconstruct phase_starts from the phases table
            phases = session.execute(
                select(Phase).where(Phase.experiment_id == exp_id).order_by(Phase.phase_index)
            ).scalars().all()
            phase_starts = _calculate_phase_starts(phases) if phases else {}

            _run_post_processing(session, exp_id, experiment, phase_starts)
            session.commit()

        # Rename directories after successful post-processing
        for exp_dir in imported_dirs:
            _rename_imported_dir(exp_dir)

    total_time = time.time() - import_start
    print(f"\nImported {len(imported_ids)} experiments in {total_time:.1f}s")
    return imported_ids


def backfill_nulls(session: Session):
    """
    Backfill NULL columns across all experiments using derived data.

    This fixes columns that were left NULL during import because the
    enrichment JOIN (context_id match between handler_events/rpc_calls
    and requests) failed. This happens for:
    - Monolith experiments: server-side instrumentation generates different
      x_pair/context_id values than the client (Artillery)
    - Internal RPC calls: triggered by other handlers, not direct client requests,
      so their context_ids don't appear in the requests table
    - Experiments without phases defined

    Strategy:
    1. auth_type: Set from experiments.auth_strategy (same for all rows in an experiment)
    2. phase_index/phase_name: Assign based on relative_time_ms falling within phase
       time boundaries (derived from requests table per experiment)
    3. phase_relative_time_ms: Calculate from relative_time_ms and phase start boundary

    Columns that remain NULL after backfill (inherently missing data):
    - metrics_alb/metrics_ecs partial NULLs: CloudWatch data gaps
    - requests.handler_duration_ms: No matching handler_events by x_pair
    - relative_time_ms where benchmark_start_ms is NULL
    """
    total_start = time.time()
    print("\n=== Backfilling NULL columns ===\n", flush=True)

    # Increase work_mem for faster UPDATE operations
    session.execute(text("SET work_mem = '256MB'"))

    # Get all experiments
    experiments = session.execute(
        select(Experiment).order_by(Experiment.id)
    ).scalars().all()

    total_stats = {
        'handler_auth': 0,
        'handler_phase': 0,
        'handler_phase_rel': 0,
        'rpc_auth': 0,
        'rpc_phase': 0,
        'request_auth': 0,
    }

    for exp in experiments:
        exp_id = exp.id
        exp_start = time.time()
        print(f"[Experiment {exp_id}] {exp.name}", flush=True)

        # --- Step 1: Set auth_type from experiment's auth_strategy ---
        auth_strategy = exp.auth_strategy

        result = session.execute(text("""
            UPDATE handler_events
            SET auth_type = :auth
            WHERE experiment_id = :exp_id AND auth_type IS NULL
        """), {"auth": auth_strategy, "exp_id": exp_id})
        handler_auth_updated = result.rowcount
        total_stats['handler_auth'] += handler_auth_updated
        if handler_auth_updated:
            session.commit()

        result = session.execute(text("""
            UPDATE rpc_calls
            SET auth_type = :auth
            WHERE experiment_id = :exp_id AND auth_type IS NULL
        """), {"auth": auth_strategy, "exp_id": exp_id})
        rpc_auth_updated = result.rowcount
        total_stats['rpc_auth'] += rpc_auth_updated
        if rpc_auth_updated:
            session.commit()

        result = session.execute(text("""
            UPDATE requests
            SET auth_type = :auth
            WHERE experiment_id = :exp_id AND auth_type IS NULL
        """), {"auth": auth_strategy, "exp_id": exp_id})
        request_auth_updated = result.rowcount
        total_stats['request_auth'] += request_auth_updated
        if request_auth_updated:
            session.commit()

        if handler_auth_updated or rpc_auth_updated or request_auth_updated:
            print(f"  auth_type: handlers={handler_auth_updated:,}, rpc={rpc_auth_updated:,}, requests={request_auth_updated:,}", flush=True)

        # --- Step 2: Compute phase boundaries from requests ---
        # For each phase, get the min and max relative_time_ms from requests
        phase_boundaries = session.execute(text("""
            SELECT phase_index, phase_name,
                   MIN(relative_time_ms) as phase_start,
                   MAX(relative_time_ms) as phase_end
            FROM requests
            WHERE experiment_id = :exp_id
              AND phase_index IS NOT NULL
              AND relative_time_ms IS NOT NULL
            GROUP BY phase_index, phase_name
            ORDER BY phase_index
        """), {"exp_id": exp_id}).fetchall()

        if not phase_boundaries:
            print(f"  No phase boundaries available, skipping phase assignment ({time.time() - exp_start:.1f}s)", flush=True)
            continue

        # Build non-overlapping ranges: each phase starts at its min,
        # ends at the start of the next phase (or infinity for the last)
        phase_ranges = []
        for i, pb in enumerate(phase_boundaries):
            phase_idx = pb[0]
            phase_name = pb[1]
            range_start = pb[2]  # min relative_time_ms for this phase
            if i + 1 < len(phase_boundaries):
                range_end = phase_boundaries[i + 1][2]  # start of next phase
            else:
                range_end = None  # no upper bound for last phase
            phase_ranges.append((phase_idx, phase_name, range_start, range_end))

        # Build CASE expressions for phase assignment (reused for handlers and rpc)
        case_idx_parts = []
        case_name_parts = []
        for phase_idx, phase_name, range_start, range_end in phase_ranges:
            if range_end is not None:
                condition = f"relative_time_ms >= {range_start} AND relative_time_ms < {range_end}"
            else:
                condition = f"relative_time_ms >= {range_start}"
            case_idx_parts.append(f"WHEN {condition} THEN {phase_idx}")
            safe_name = phase_name.replace("'", "''")
            case_name_parts.append(f"WHEN {condition} THEN '{safe_name}'")

        # Handle events before the first phase (assign to first phase)
        first_start = phase_ranges[0][2]
        case_idx_parts.insert(0, f"WHEN relative_time_ms < {first_start} THEN {phase_ranges[0][0]}")
        safe_first_name = phase_ranges[0][1].replace("'", "''")
        case_name_parts.insert(0, f"WHEN relative_time_ms < {first_start} THEN '{safe_first_name}'")

        case_idx_sql = "CASE " + " ".join(case_idx_parts) + " END"
        case_name_sql = "CASE " + " ".join(case_name_parts) + " END"

        # Build CASE for phase start times (for phase_relative_time_ms)
        phase_start_parts = []
        for phase_idx, _, range_start, _ in phase_ranges:
            phase_start_parts.append(f"WHEN {phase_idx} THEN {range_start}")
        phase_start_sql = "CASE phase_index " + " ".join(phase_start_parts) + " END"

        # --- Step 3: Assign phase_index/phase_name to handler_events ---
        handler_phase_updated = 0
        result = session.execute(text(f"""
            UPDATE handler_events
            SET phase_index = ({case_idx_sql}),
                phase_name = ({case_name_sql})
            WHERE experiment_id = :exp_id
              AND phase_index IS NULL
              AND relative_time_ms IS NOT NULL
        """), {"exp_id": exp_id})
        handler_phase_updated = result.rowcount
        total_stats['handler_phase'] += handler_phase_updated
        if handler_phase_updated:
            session.commit()

        # --- Step 4: Calculate phase_relative_time_ms for handler_events ---
        result = session.execute(text(f"""
            UPDATE handler_events
            SET phase_relative_time_ms = relative_time_ms - ({phase_start_sql})
            WHERE experiment_id = :exp_id
              AND phase_index IS NOT NULL
              AND relative_time_ms IS NOT NULL
              AND phase_relative_time_ms IS NULL
        """), {"exp_id": exp_id})
        handler_phase_rel_updated = result.rowcount
        total_stats['handler_phase_rel'] += handler_phase_rel_updated
        if handler_phase_rel_updated:
            session.commit()

        if handler_phase_updated or handler_phase_rel_updated:
            print(f"  handler_events: phase_assigned={handler_phase_updated:,}, phase_rel_time={handler_phase_rel_updated:,}", flush=True)

        # --- Step 5: Assign phase_index/phase_name to rpc_calls ---
        result = session.execute(text(f"""
            UPDATE rpc_calls
            SET phase_index = ({case_idx_sql}),
                phase_name = ({case_name_sql})
            WHERE experiment_id = :exp_id
              AND phase_index IS NULL
              AND relative_time_ms IS NOT NULL
        """), {"exp_id": exp_id})
        rpc_phase_updated = result.rowcount
        total_stats['rpc_phase'] += rpc_phase_updated
        if rpc_phase_updated:
            session.commit()
            print(f"  rpc_calls: phase_assigned={rpc_phase_updated:,}", flush=True)

        print(f"  Done ({time.time() - exp_start:.1f}s)", flush=True)

    # Restore work_mem
    session.execute(text("RESET work_mem"))
    session.commit()

    # Summary
    print(f"\n=== Backfill Summary ===", flush=True)
    print(f"  handler_events.auth_type:            {total_stats['handler_auth']:,} rows updated", flush=True)
    print(f"  handler_events.phase_index/name:     {total_stats['handler_phase']:,} rows updated", flush=True)
    print(f"  handler_events.phase_relative_time:  {total_stats['handler_phase_rel']:,} rows updated", flush=True)
    print(f"  rpc_calls.auth_type:                 {total_stats['rpc_auth']:,} rows updated", flush=True)
    print(f"  rpc_calls.phase_index/name:          {total_stats['rpc_phase']:,} rows updated", flush=True)
    print(f"  requests.auth_type:                  {total_stats['request_auth']:,} rows updated", flush=True)
    print(f"\nBackfill completed in {time.time() - total_start:.1f}s", flush=True)


def init_database(engine, drop_existing: bool = False):
    """
    Initialize the database schema.

    Args:
        engine: SQLAlchemy engine
        drop_existing: If True, drop all tables before creating
    """
    if drop_existing:
        print("Dropping existing tables...")
        Base.metadata.drop_all(engine)

    print("Creating tables...")
    create_tables(engine)

    print("Database initialized successfully")