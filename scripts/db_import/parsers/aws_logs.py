import json
import re
from pathlib import Path
from typing import Generator, Optional, List
from dataclasses import dataclass, field


@dataclass
class LambdaExecutionData:
    """Lambda execution metrics from REPORT log."""
    request_id: str
    function_name: str
    timestamp_ms: int
    duration_ms: Optional[float] = None
    billed_duration_ms: Optional[float] = None
    init_duration_ms: Optional[float] = None
    memory_size_mb: Optional[int] = None
    max_memory_used_mb: Optional[int] = None
    is_cold_start: bool = False


@dataclass
class HandlerEventData:
    """Handler event from BEFAAS instrumentation."""
    x_pair: Optional[str] = None
    context_id: Optional[str] = None
    lambda_request_id: Optional[str] = None
    function_name: str = ""
    route: Optional[str] = None
    status_code: Optional[int] = None
    is_cold_start: bool = False
    request_count: Optional[int] = None
    timestamp_ms: int = 0
    duration_ms: Optional[float] = None


@dataclass
class ContainerStartData:
    """Container cold start event from BEFAAS."""
    lambda_request_id: Optional[str] = None
    function_name: str = ""
    deployment_id: Optional[str] = None
    timestamp_ms: int = 0
    container_start_time_ms: Optional[int] = None


@dataclass
class RpcCallData:
    """RPC call event from BEFAAS."""
    direction: str
    x_pair: Optional[str] = None
    context_id: Optional[str] = None
    lambda_request_id: Optional[str] = None
    function_name: str = ""
    target_function: Optional[str] = None
    call_x_pair: Optional[str] = None
    call_type: Optional[str] = None
    duration_ms: Optional[float] = None
    success: bool = True
    is_cold_start: bool = False
    timestamp_ms: int = 0
    received_at_ms: Optional[int] = None


@dataclass
class AwsLogBatch:
    """Batch of parsed AWS log data."""
    lambda_executions: List[LambdaExecutionData] = field(default_factory=list)
    handler_events: List[HandlerEventData] = field(default_factory=list)
    container_starts: List[ContainerStartData] = field(default_factory=list)
    rpc_calls: List[RpcCallData] = field(default_factory=list)


REPORT_PATTERN = re.compile(
    r'REPORT RequestId: ([\w-]+)\s+'
    r'Duration: ([\d.]+) ms\s+'
    r'Billed Duration: ([\d.]+) ms\s+'
    r'Memory Size: (\d+) MB\s+'
    r'Max Memory Used: (\d+) MB'
    r'(?:\s+Init Duration: ([\d.]+) ms)?'
)

# Match backend BEFAAS lines only. The negative lookahead `(?!-EDGE)` excludes
# BEFAAS-EDGE{...} lines emitted by the Lambda@Edge auth function
BEFAAS_PATTERN = re.compile(r'BEFAAS(?!-EDGE):?\s*(\{.+\})')

# Extract request ID from Lambda log message format
# Format: "2026-01-09T22:57:26.307Z\tb9fb9c29-4dd5-4dd1-ab87-14ba471891e2\tINFO\tBEFAAS: {...}"
REQUEST_ID_PATTERN = re.compile(r'[\dT:.-]+Z\t([\w-]+)\t')


def _extract_function_name(log_group: str, fn_name: str) -> str:
    """Extract clean function name from log group or fnName field."""
    # fnName format: "none_512MB_minimal_2026-01-09T22-48-43-424Z/addcartitem"
    if fn_name and '/' in fn_name:
        return fn_name.split('/')[-1]

    # log_group format: "/aws/lambda/faas_none_512MB_minimal.../addcartitem"
    if log_group:
        parts = log_group.split('/')
        if parts:
            return parts[-1]

    return fn_name or "unknown"


def parse_aws_log(
    path: Path,
    batch_size: int = 10000
) -> Generator[AwsLogBatch, None, None]:
    """
    Stream parse aws.log file.

    Yields:
        AwsLogBatch containing parsed events
    """
    if not path.exists():
        return

    batch = AwsLogBatch()
    event_count = 0

    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                # Parse JSON wrapper
                try:
                    log_entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                message = log_entry.get('message', '')
                timestamp = log_entry.get('timestamp')
                log_group = log_entry.get('logGroup', '')
                fn_name_field = log_entry.get('fnName', '')

                # Extract request ID from message if present
                request_id_match = REQUEST_ID_PATTERN.search(message)
                request_id = request_id_match.group(1) if request_id_match else None

                # Check for REPORT line
                report_match = REPORT_PATTERN.search(message)
                if report_match:
                    init_duration = report_match.group(6)
                    is_cold_start = init_duration is not None

                    batch.lambda_executions.append(LambdaExecutionData(
                        request_id=report_match.group(1),
                        function_name=_extract_function_name(log_group, fn_name_field),
                        timestamp_ms=timestamp or 0,
                        duration_ms=float(report_match.group(2)),
                        billed_duration_ms=float(report_match.group(3)),
                        memory_size_mb=int(report_match.group(4)),
                        max_memory_used_mb=int(report_match.group(5)),
                        init_duration_ms=float(init_duration) if init_duration else None,
                        is_cold_start=is_cold_start,
                    ))
                    event_count += 1

                # Check for BEFAAS event
                befaas_match = BEFAAS_PATTERN.search(message)
                if befaas_match:
                    try:
                        befaas_data = json.loads(befaas_match.group(1))
                    except json.JSONDecodeError:
                        continue

                    fn_info = befaas_data.get('fn', {})
                    raw_fn_name = fn_info.get('name')
                    # Fall back to serviceName/logGroup when fn.name is missing or generic
                    if not raw_fn_name or raw_fn_name in ('unknown', 'unknownFn'):
                        # ECS logs have serviceName in wrapper (e.g., "cart-service")
                        service_name = log_entry.get('serviceName')
                        if service_name:
                            function_name = service_name
                        else:
                            function_name = _extract_function_name(log_group, fn_name_field)
                    else:
                        function_name = raw_fn_name
                    event = befaas_data.get('event', {})
                    event_ts = befaas_data.get('timestamp', timestamp)
                    deployment_id = befaas_data.get('deploymentId')

                    # Container cold start event
                    if 'coldStart' in event and 'containerStartTime' in event:
                        batch.container_starts.append(ContainerStartData(
                            lambda_request_id=request_id,
                            function_name=function_name,
                            deployment_id=deployment_id,
                            timestamp_ms=event_ts or 0,
                            container_start_time_ms=event.get('containerStartTime'),
                        ))
                        event_count += 1

                    # RPC In event
                    if 'rpcIn' in event:
                        rpc_in = event['rpcIn']
                        batch.rpc_calls.append(RpcCallData(
                            direction='in',
                            x_pair=event.get('xPair'),
                            context_id=event.get('contextId'),
                            lambda_request_id=request_id,
                            function_name=function_name,
                            is_cold_start=rpc_in.get('coldStart', False),
                            timestamp_ms=event_ts or 0,
                            received_at_ms=rpc_in.get('receivedAt'),
                        ))
                        event_count += 1

                    # RPC Out event
                    if 'rpcOut' in event:
                        rpc_out = event['rpcOut']
                        batch.rpc_calls.append(RpcCallData(
                            direction='out',
                            x_pair=event.get('xPair'),
                            context_id=event.get('contextId'),
                            lambda_request_id=request_id,
                            function_name=function_name,
                            target_function=rpc_out.get('target'),
                            call_x_pair=rpc_out.get('callXPair'),
                            call_type=rpc_out.get('callType'),
                            duration_ms=rpc_out.get('durationMs'),
                            success=rpc_out.get('success', True),
                            timestamp_ms=event_ts or 0,
                        ))
                        event_count += 1

                    # Handler event
                    if 'handler' in event:
                        handler = event['handler']
                        batch.handler_events.append(HandlerEventData(
                            x_pair=event.get('xPair'),
                            context_id=event.get('contextId'),
                            lambda_request_id=request_id,
                            function_name=function_name,
                            route=handler.get('route'),
                            status_code=handler.get('statusCode'),
                            is_cold_start=handler.get('coldStart', False),
                            request_count=handler.get('requestCount'),
                            timestamp_ms=event_ts or 0,
                            duration_ms=handler.get('durationMs'),
                        ))
                        event_count += 1

                if event_count >= batch_size:
                    yield batch
                    batch = AwsLogBatch()
                    event_count = 0

    except IOError as e:
        print(f"Error reading AWS log: {e}")

    # Yield remaining events
    if event_count > 0:
        yield batch