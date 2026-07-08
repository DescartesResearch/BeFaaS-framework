import json
import re
from pathlib import Path
from typing import Generator, Optional, List
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass
class PhaseData:
    """Benchmark phase definition."""
    index: int
    name: str
    duration_seconds: int


@dataclass
class RequestData:
    """Client-side request data from artillery log."""
    x_pair: Optional[str] = None
    context_id: Optional[str] = None
    timestamp_ms: int = 0
    endpoint: Optional[str] = None
    status_code: Optional[int] = None
    auth_type: Optional[str] = None
    phase_index: Optional[int] = None
    phase_name: Optional[str] = None
    is_error: bool = False
    is_timeout: bool = False
    error_type: Optional[str] = None
    error_code: Optional[str] = None


@dataclass
class ArtilleryParseResult:
    """Result from parsing artillery log."""
    phases: List[PhaseData] = field(default_factory=list)
    benchmark_start_ms: Optional[int] = None
    benchmark_end_ms: Optional[int] = None


# Regex to extract BEFAAS JSON from log line
BEFAAS_PATTERN = re.compile(r'BEFAAS(\{.+\})')


def _extract_endpoint(url: str) -> str:
    """Extract endpoint path from URL."""
    try:
        parsed = urlparse(url)
        path = parsed.path or '/'
        # Normalize: remove trailing slash, lowercase
        return path.rstrip('/') or '/'
    except Exception:
        return url


def parse_artillery_log(
    path: Path,
    batch_size: int = 10000
) -> Generator[tuple[ArtilleryParseResult, List[RequestData]], None, None]:
    """
    Stream parse artillery.log file.

    Yields:
        Tuple of (ArtilleryParseResult, List[RequestData])
        First yield has populated ArtilleryParseResult, subsequent ones have empty result.
    """
    if not path.exists():
        return

    result = ArtilleryParseResult()
    requests_batch: List[RequestData] = []

    pending_requests: dict[str, dict] = {}

    seen_phases: dict[int, str] = {}

    first_yield = True
    min_timestamp = None
    max_timestamp = None
    has_phases_loaded = False

    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                # Handle CloudWatch JSON wrapper format: {"timestamp":...,"message":"BEFAAS{...}\n","logGroup":...}
                if line.lstrip().startswith('{') and '"message"' in line:
                    line = _handle_cloudwatch_json_wrapper(line)

                # Look for BEFAAS events
                match = BEFAAS_PATTERN.search(line)
                if not match:
                    continue

                try:
                    data = json.loads(match.group(1))
                except json.JSONDecodeError:
                    continue

                event = data.get('event', {})
                event_type = event.get('type')
                timestamp = data.get('timestamp')

                # Track timestamps for benchmark duration
                if timestamp:
                    if min_timestamp is None or timestamp < min_timestamp:
                        min_timestamp = timestamp
                    if max_timestamp is None or timestamp > max_timestamp:
                        max_timestamp = timestamp

                # Handle phases_loaded event
                if event_type == 'phases_loaded':
                    phases = event.get('phases', [])
                    for phase in phases:
                        result.phases.append(PhaseData(
                            index=phase.get('index', 0),
                            name=phase.get('name', ''),
                            duration_seconds=phase.get('duration', 0),
                        ))
                    has_phases_loaded = True
                    continue

                # Handle before event (store for correlation)
                if event_type == 'before':
                    x_pair = event.get('xPair')
                    if x_pair:
                        pending_requests[x_pair] = {
                            'context_id': event.get('contextId'),
                            'timestamp_ms': timestamp,
                            'url': event.get('url'),
                            'auth_type': event.get('authType'),
                            'phase': data.get('phase', {}),
                        }
                    continue

                # Handle after event
                if event_type == 'after':
                    req = _get_request_data(data, event, pending_requests, seen_phases, timestamp)

                    requests_batch.append(req)

                    # Yield batch if full
                    if len(requests_batch) >= batch_size:
                        if first_yield:
                            result.benchmark_start_ms = min_timestamp
                            result.benchmark_end_ms = max_timestamp
                            yield (result, requests_batch)
                            result = ArtilleryParseResult()  # Reset for subsequent yields
                            first_yield = False
                        else:
                            yield (result, requests_batch)
                        requests_batch = []

    except IOError as e:
        print(f"Error reading artillery log: {e}")
        return

    # If no phases_loaded event, extract phases from seen request phases
    if not has_phases_loaded and seen_phases:
        for idx in sorted(seen_phases.keys()):
            result.phases.append(PhaseData(
                index=idx,
                name=seen_phases[idx],
                duration_seconds=0,  # Unknown without phases_loaded
            ))

    # Yield remaining requests
    if requests_batch or first_yield:
        result.benchmark_start_ms = min_timestamp
        result.benchmark_end_ms = max_timestamp
        yield (result, requests_batch)


def _handle_cloudwatch_json_wrapper(line) -> Any:
    try:
        log_entry = json.loads(line)
        message = log_entry.get('message', '')
        if 'BEFAAS' in message:
            line = message
    except json.JSONDecodeError:
        pass
    return line


def _get_request_data(data, event, pending_requests, seen_phases, timestamp) -> RequestData:
    x_pair = event.get('xPair')
    before_data = pending_requests.pop(x_pair, {}) if x_pair else {}

    phase = data.get('phase', before_data.get('phase', {}))

    # Track phases from request events
    if phase and 'index' in phase and 'name' in phase:
        phase_idx = phase['index']
        if phase_idx not in seen_phases:
            seen_phases[phase_idx] = phase['name']

    # Calculate latency if we have before timestamp
    before_ts = before_data.get('timestamp_ms')
    latency_ms = None
    if before_ts and timestamp:
        latency_ms = timestamp - before_ts

    # Extract endpoint from URL
    url = event.get('url') or before_data.get('url', '')
    endpoint = _extract_endpoint(url)

    status_code = event.get('statusCode')
    is_error = status_code is not None and (status_code < 200 or status_code >= 400)
    is_timeout = event.get('isTimeout', False)

    req = RequestData(
        x_pair=x_pair,
        context_id=event.get('contextId') or before_data.get('context_id'),
        timestamp_ms=timestamp or before_data.get('timestamp_ms', 0),
        endpoint=endpoint,
        status_code=status_code,
        auth_type=event.get('authType') or before_data.get('auth_type'),
        phase_index=phase.get('index'),
        phase_name=phase.get('name'),
        is_error=is_error,
        is_timeout=is_timeout,
        error_type=event.get('errorType'),
        error_code=event.get('errorCode'),
    )

    # Store latency
    req._latency_ms = latency_ms
    return req