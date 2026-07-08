import json
import re
from pathlib import Path
from typing import Generator, Optional, List
from dataclasses import dataclass, field

from .aws_logs import LambdaExecutionData, REPORT_PATTERN, REQUEST_ID_PATTERN


@dataclass
class EdgeAuthEventData:
    """One BEFAAS-EDGE event (any event_type).
    """
    event_type: str
    timestamp_ms: int
    instance_id: Optional[str] = None
    lambda_request_id: Optional[str] = None
    now_perf_ms: Optional[float] = None

    uri: Optional[str] = None
    outcome: Optional[str] = None
    total_ms: Optional[float] = None
    key_resolve_ms: Optional[float] = None
    crypto_verify_ms: Optional[float] = None
    sign_ms: Optional[float] = None
    triggered_jwks_fetch: Optional[bool] = None
    instance_age_ms: Optional[int] = None

    trigger: Optional[str] = None
    duration_ms: Optional[float] = None
    jwks_fetch_number: Optional[int] = None
    jwks_key_count: Optional[int] = None
    kid: Optional[str] = None
    since_last_ms: Optional[int] = None
    error: Optional[str] = None


@dataclass
class EdgeLogBatch:
    """Batch of parsed edge.log data."""
    lambda_executions: List[LambdaExecutionData] = field(default_factory=list)
    edge_auth_events: List[EdgeAuthEventData] = field(default_factory=list)


# Match BEFAAS-EDGE prefix followed directly by a JSON object. Matches the
# logEdge() emit format: console.log('BEFAAS-EDGE' + JSON.stringify({...})).
BEFAAS_EDGE_PATTERN = re.compile(r'BEFAAS-EDGE\s*(\{.+\})')


def _extract_edge_function_name(log_group: str, fn_name: str) -> str:
    """Extract the edge Lambda function name.

    Edge Lambda log groups follow the form:
        /aws/lambda/us-east-1.befaas-<projectId>-edge-auth
    We keep the final segment without the region prefix.
    """
    name = fn_name or ""
    if name.startswith("us-east-1."):
        name = name[len("us-east-1."):]
    if not name and log_group:
        tail = log_group.rsplit('/', 1)[-1]
        if tail.startswith("us-east-1."):
            tail = tail[len("us-east-1."):]
        name = tail
    return name or "edge-auth"


def _as_int(v) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _as_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _as_bool(v) -> Optional[bool]:
    if v is None:
        return None
    return bool(v)


def _event_from_payload(payload: dict, envelope_ts: Optional[int],
                        request_id: Optional[str]) -> Optional[EdgeAuthEventData]:
    """Map a parsed BEFAAS-EDGE JSON payload to an EdgeAuthEventData."""
    event_type = payload.get("event")
    if not event_type:
        return None

    ts = _as_int(payload.get("timestamp")) or envelope_ts or 0

    return EdgeAuthEventData(
        event_type=event_type,
        timestamp_ms=ts,
        instance_id=payload.get("instanceId"),
        lambda_request_id=request_id,
        now_perf_ms=_as_float(payload.get("now")),
        uri=payload.get("uri"),
        outcome=payload.get("outcome"),
        total_ms=_as_float(payload.get("totalMs")),
        key_resolve_ms=_as_float(payload.get("keyResolveMs")),
        crypto_verify_ms=_as_float(payload.get("cryptoVerifyMs")),
        sign_ms=_as_float(payload.get("signMs")),
        triggered_jwks_fetch=_as_bool(payload.get("triggeredJwksFetch")),
        instance_age_ms=_as_int(payload.get("instanceAgeMs")),
        trigger=payload.get("trigger"),
        duration_ms=_as_float(payload.get("durationMs")),
        jwks_fetch_number=_as_int(payload.get("fetchNumber")),
        jwks_key_count=_as_int(payload.get("keyCount")),
        kid=payload.get("kid"),
        since_last_ms=_as_int(payload.get("sinceLastMs")),
        error=payload.get("error"),
    )


def parse_edge_log(
    path: Path,
    batch_size: int = 10000,
) -> Generator[EdgeLogBatch, None, None]:
    """
    Stream parse edge.log, yielding batches of Lambda executions and edge
    auth events.

    Older experiments (run with v1 of the edge Lambda) produce only REPORT
    lines — the batches will contain lambda_executions but no edge_auth_events.
    Newer experiments (v2) produce both.
    """
    if not path.exists():
        return

    batch = EdgeLogBatch()
    event_count = 0

    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    envelope = json.loads(line)
                except json.JSONDecodeError:
                    continue

                message = envelope.get('message', '')
                envelope_ts = envelope.get('timestamp')
                log_group = envelope.get('logGroup', '')
                fn_name_field = envelope.get('fnName', '')

                request_id_match = REQUEST_ID_PATTERN.search(message)
                request_id = request_id_match.group(1) if request_id_match else None

                # REPORT line => Lambda platform metrics for the edge function.
                report_match = REPORT_PATTERN.search(message)
                if report_match:
                    init_duration = report_match.group(6)
                    batch.lambda_executions.append(LambdaExecutionData(
                        request_id=report_match.group(1),
                        function_name=_extract_edge_function_name(log_group, fn_name_field),
                        timestamp_ms=envelope_ts or 0,
                        duration_ms=float(report_match.group(2)),
                        billed_duration_ms=float(report_match.group(3)),
                        memory_size_mb=int(report_match.group(4)),
                        max_memory_used_mb=int(report_match.group(5)),
                        init_duration_ms=float(init_duration) if init_duration else None,
                        is_cold_start=init_duration is not None,
                    ))
                    event_count += 1

                # BEFAAS-EDGE structured event (v2 only).
                edge_match = BEFAAS_EDGE_PATTERN.search(message)
                if edge_match:
                    try:
                        payload = json.loads(edge_match.group(1))
                    except json.JSONDecodeError:
                        continue

                    event = _event_from_payload(payload, envelope_ts, request_id)
                    if event is not None:
                        batch.edge_auth_events.append(event)
                        event_count += 1

                if event_count >= batch_size:
                    yield batch
                    batch = EdgeLogBatch()
                    event_count = 0

    except IOError as e:
        print(f"Error reading edge log: {e}")

    if event_count > 0:
        yield batch
